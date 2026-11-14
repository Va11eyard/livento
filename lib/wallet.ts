/**
 * Livento wallet (server-only, Stripe TEST MODE).
 *
 * - Identity: one Stripe Customer per browser. The browser keeps a token
 *   "<cus id>.<HMAC-SHA256(Stripe key, 'livento-wallet:' + cus id), base64url, 32 chars>".
 * - Ledger: Stripe itself. Deposits are succeeded PaymentIntents of the customer with
 *   metadata livento_envelope / livento_kind / livento_event; withdrawals are their refunds.
 * - Auto-save schedules live in Customer metadata:
 *   `as_<envelopeId>` = "<weeklyCents>|<nextDate YYYY-MM-DD>|<pm id>|<targetCents>|active|failed",
 *   plus `livento_autosave=1` while at least one schedule is active (used by the daily job's search).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { addDays, utcToISODate } from "./dates";
import { apiError } from "./http";
import { ENVELOPE_ID } from "./schemas";
import {
  isStripeError,
  stripeApi,
  stripeTestKey,
  type StripeCharge,
  type StripeCustomer,
  type StripeList,
  type StripeMetadata,
  type StripePaymentIntent,
  type StripeRefund,
} from "./stripe";
import type { WalletAutosave, WalletEntry, WalletEnvelope, WalletSummary } from "./types";

const TOKEN_MAC_CHARS = 32;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{6,64}$/;
const MAX_PI_PAGES = 5; // 500 payments per wallet is far beyond a hackathon demo
const REFUND_BATCH = 4;
export const AUTOSAVE_KEY_PREFIX = "as_";
export const AUTOSAVE_FLAG = "livento_autosave";

/** Today's date in UTC ("YYYY-MM-DD"); every server-side wallet date uses UTC. */
export function utcToday(now: number = Date.now()): string {
  return utcToISODate(now);
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

function tokenMac(key: string, customerId: string): string {
  return createHmac("sha256", key).update(`livento-wallet:${customerId}`).digest("base64url").slice(0, TOKEN_MAC_CHARS);
}

/** The browser token for a customer id (requires a Stripe test key). */
export function walletToken(customerId: string): string {
  const key = stripeTestKey();
  if (!key) throw new Error("Stripe test mode is not configured");
  return `${customerId}.${tokenMac(key, customerId)}`;
}

/** The customer id inside a valid token, or null. Constant-time comparison. */
export function verifyWalletToken(token: string): string | null {
  const key = stripeTestKey();
  if (!key) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const customerId = token.slice(0, dot);
  if (!CUSTOMER_ID.test(customerId)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(tokenMac(key, customerId));
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? customerId : null;
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

export const WALLET_OFF_MESSAGE = "The wallet isn't connected on this deployment yet, so money can't be added.";

type WalletAuth = { ok: true; customerId: string } | { ok: false; response: Response };

/** Checks configuration and the token. 503 when Stripe test mode is off, 401 for a bad token. */
export function authorizeWallet(token: string): WalletAuth {
  if (!stripeTestKey()) return { ok: false, response: apiError(WALLET_OFF_MESSAGE, 503) };
  const customerId = verifyWalletToken(token);
  if (!customerId) {
    return {
      ok: false,
      response: apiError("This wallet link isn't valid on this deployment. A new wallet will be created when you add money.", 401),
    };
  }
  return { ok: true, customerId };
}

/** Maps a Stripe failure to a short, safe message. Logs status and code only. */
export function walletFailure(route: string, err: unknown): Response {
  if (isStripeError(err)) {
    console.warn(`[wallet/${route}] Stripe error status=${err.status} code=${err.code ?? err.type ?? "-"}`);
    if (err.code === "not_configured") return apiError(WALLET_OFF_MESSAGE, 503);
    if (err.code === "resource_missing" && /customer/i.test(err.message)) {
      return apiError("This wallet wasn't found. A new wallet will be created when you add money.", 404);
    }
    if (err.status === 0) return apiError("Stripe test mode isn't answering right now. Please try again.", 502);
    if (err.status === 429) return apiError("Stripe is busy right now. Wait a few seconds and try again.", 503);
  } else {
    console.warn(`[wallet/${route}] unexpected failure`);
  }
  return apiError("The wallet couldn't finish that. Please try again.", 502);
}

// ---------------------------------------------------------------------------
// Ledger (read from Stripe)
// ---------------------------------------------------------------------------

export interface LedgerPayment {
  id: string;
  envelopeId: string;
  kind: "deposit" | "autosave";
  eventName?: string;
  cycle?: string; // auto-save cycle date (metadata livento_cycle) for payments made by the daily job
  cents: number; // amount received
  refundedCents: number; // latest_charge.amount_refunded
  created: number; // unix seconds
  seq: number; // position in Stripe's newest-first list: breaks ties within the same second
}

export interface LedgerRefund {
  id: string;
  envelopeId: string;
  paymentIntent: string;
  cents: number;
  created: number;
  requestId?: string; // metadata livento_request of the withdrawal that made it
}

export interface Ledger {
  payments: LedgerPayment[];
  refunds: LedgerRefund[];
}

function toLedgerPayment(pi: StripePaymentIntent, seq: number): LedgerPayment | null {
  const meta = pi.metadata ?? {};
  const envelopeId = meta.livento_envelope;
  if (pi.status !== "succeeded" || !envelopeId || !ENVELOPE_ID.test(envelopeId)) return null;
  if (typeof pi.currency === "string" && pi.currency.toLowerCase() !== "usd") return null;
  const cents = Number.isInteger(pi.amount_received) ? (pi.amount_received as number) : pi.amount;
  if (!Number.isInteger(cents) || cents <= 0) return null;
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as StripeCharge) : null;
  const refunded = charge && Number.isInteger(charge.amount_refunded) ? charge.amount_refunded : 0;
  return {
    id: pi.id,
    envelopeId: envelopeId.toLowerCase(),
    kind: meta.livento_kind === "autosave" ? "autosave" : "deposit",
    eventName: meta.livento_event || undefined,
    cycle: meta.livento_cycle || undefined,
    cents,
    refundedCents: Math.max(0, Math.min(cents, refunded)),
    created: pi.created,
    seq,
  };
}

/** Every succeeded Livento payment of the customer, plus refunds of the ones with money returned. */
export async function loadLedger(customerId: string): Promise<Ledger> {
  const payments: LedgerPayment[] = [];
  let startingAfter: string | undefined;
  let seen = 0;
  for (let page = 0; page < MAX_PI_PAGES; page++) {
    const list = await stripeApi<StripeList<StripePaymentIntent>>("GET", "/v1/payment_intents", {
      customer: customerId,
      limit: 100,
      expand: ["data.latest_charge"],
      starting_after: startingAfter,
    });
    for (const pi of list.data) {
      const p = toLedgerPayment(pi, seen++);
      if (p) payments.push(p);
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  const refunds: LedgerRefund[] = [];
  const refunded = payments.filter((p) => p.refundedCents > 0);
  for (let i = 0; i < refunded.length; i += REFUND_BATCH) {
    const batch = refunded.slice(i, i + REFUND_BATCH);
    const lists = await Promise.all(
      batch.map((p) =>
        stripeApi<StripeList<StripeRefund>>("GET", "/v1/refunds", { payment_intent: p.id, limit: 100 }),
      ),
    );
    lists.forEach((list, j) => {
      const p = batch[j];
      for (const r of list.data) {
        // Pending refunds have already left the wallet; failed / canceled ones haven't.
        if (r.status === "failed" || r.status === "canceled") continue;
        if (!Number.isInteger(r.amount) || r.amount <= 0) continue;
        refunds.push({
          id: r.id,
          envelopeId: p.envelopeId,
          paymentIntent: p.id,
          cents: r.amount,
          created: r.created,
          requestId: r.metadata?.livento_request || undefined,
        });
      }
    });
  }
  return { payments, refunds };
}

/** Cents held for one envelope. */
export function envelopeCents(ledger: Ledger, envelopeId: string): number {
  const id = envelopeId.toLowerCase();
  const paid = ledger.payments.filter((p) => p.envelopeId === id).reduce((sum, p) => sum + p.cents, 0);
  const back = ledger.refunds.filter((r) => r.envelopeId === id).reduce((sum, r) => sum + r.cents, 0);
  return Math.max(0, paid - back);
}

/** Newest first: by creation time, then by Stripe's own list order. */
export function newestPaymentFirst(a: LedgerPayment, b: LedgerPayment): number {
  return b.created - a.created || a.seq - b.seq;
}

/** Event name from the newest payment of an envelope. */
export function envelopeEventName(ledger: Ledger, envelopeId: string): string | undefined {
  const id = envelopeId.toLowerCase();
  return ledger.payments
    .filter((p) => p.envelopeId === id && p.eventName)
    .sort(newestPaymentFirst)[0]?.eventName;
}

// ---------------------------------------------------------------------------
// Auto-save schedules (Customer metadata)
// ---------------------------------------------------------------------------

export interface Schedule {
  envelopeId: string;
  weeklyCents: number;
  nextDate: string; // YYYY-MM-DD (UTC)
  paymentMethod: string;
  targetCents: number;
  status: "active" | "failed";
}

export function scheduleKey(envelopeId: string): string {
  return `${AUTOSAVE_KEY_PREFIX}${envelopeId.toLowerCase()}`;
}

export function formatSchedule(s: Schedule): string {
  return [s.weeklyCents, s.nextDate, s.paymentMethod, s.targetCents, s.status].join("|");
}

export function parseSchedule(key: string, value: string | undefined): Schedule | null {
  if (!key.startsWith(AUTOSAVE_KEY_PREFIX) || !value) return null;
  const envelopeId = key.slice(AUTOSAVE_KEY_PREFIX.length);
  if (!ENVELOPE_ID.test(envelopeId)) return null;
  const parts = value.split("|");
  if (parts.length !== 5) return null;
  const [weekly, nextDate, paymentMethod, target, status] = parts;
  const weeklyCents = Number(weekly);
  const targetCents = Number(target);
  if (!Number.isInteger(weeklyCents) || weeklyCents < 100 || weeklyCents > 200_000) return null;
  if (!Number.isInteger(targetCents) || targetCents < 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || !/^pm_[A-Za-z0-9_]+$/.test(paymentMethod)) return null;
  if (status !== "active" && status !== "failed") return null;
  return { envelopeId: envelopeId.toLowerCase(), weeklyCents, nextDate, paymentMethod, targetCents, status };
}

export function schedulesOf(metadata: StripeMetadata | undefined): Schedule[] {
  return Object.entries(metadata ?? {})
    .map(([key, value]) => parseSchedule(key, value))
    .filter((s): s is Schedule => s !== null);
}

/**
 * Writes schedule changes (null = remove) and keeps `livento_autosave` in step:
 * "1" while any schedule is active, "" (removed) otherwise. Returns the updated customer.
 */
export async function writeSchedules(
  customerId: string,
  current: StripeMetadata | undefined,
  changes: Record<string, Schedule | null>,
): Promise<StripeCustomer> {
  const metadata: Record<string, string> = {};
  const merged: StripeMetadata = { ...(current ?? {}) };
  for (const [envelopeId, schedule] of Object.entries(changes)) {
    const key = scheduleKey(envelopeId);
    const value = schedule ? formatSchedule(schedule) : "";
    metadata[key] = value;
    if (value) merged[key] = value;
    else delete merged[key];
  }
  const anyActive = schedulesOf(merged).some((s) => s.status === "active");
  metadata[AUTOSAVE_FLAG] = anyActive ? "1" : "";
  return stripeApi<StripeCustomer>("POST", `/v1/customers/${customerId}`, { metadata });
}

/** The next weekly date after `nextDate` that is later than `today` (no catch-up charges). */
export function advanceWeekly(nextDate: string, today: string): string {
  let next = addDays(nextDate, 7);
  while (next <= today) next = addDays(next, 7);
  return next;
}

// ---------------------------------------------------------------------------
// Customer + summary
// ---------------------------------------------------------------------------

/** GET /v1/customers/{id}; a deleted customer is reported like a missing one. */
export async function getCustomer(customerId: string): Promise<StripeCustomer | null> {
  try {
    const customer = await stripeApi<StripeCustomer>("GET", `/v1/customers/${customerId}`);
    return customer.deleted ? null : customer;
  } catch (err) {
    if (isStripeError(err) && err.status === 404) return null;
    throw err;
  }
}

export const WALLET_NOT_FOUND = "This wallet wasn't found. A new wallet will be created when you add money.";

const usd = (cents: number) => Math.round(cents) / 100;

function isoFromUnix(seconds: number): string {
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.now();
  return new Date(ms).toISOString();
}

export function buildSummary(ledger: Ledger, customer: StripeCustomer): WalletSummary {
  type Acc = { cents: number; entries: (WalletEntry & { t: number; rank: number })[]; autosave?: WalletAutosave };
  const map = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = map.get(id);
    if (!a) {
      a = { cents: 0, entries: [] };
      map.set(id, a);
    }
    return a;
  };
  for (const p of ledger.payments) {
    const a = acc(p.envelopeId);
    a.cents += p.cents;
    a.entries.push({ id: p.id, date: isoFromUnix(p.created), amount: usd(p.cents), kind: p.kind, t: p.created, rank: -p.seq });
  }
  for (const r of ledger.refunds) {
    const a = acc(r.envelopeId);
    a.cents -= r.cents;
    a.entries.push({ id: r.id, date: isoFromUnix(r.created), amount: -usd(r.cents), kind: "withdrawal", t: r.created, rank: 1e9 });
  }
  for (const s of schedulesOf(customer.metadata)) {
    acc(s.envelopeId).autosave = { weekly: usd(s.weeklyCents), nextDate: s.nextDate, status: s.status };
  }
  let totalCents = 0;
  const envelopes: Record<string, WalletEnvelope> = {};
  for (const [id, a] of map) {
    const cents = Math.max(0, a.cents);
    totalCents += cents;
    const entries = a.entries
      .sort((x, y) => x.t - y.t || x.rank - y.rank || x.id.localeCompare(y.id))
      .map((e) => ({ id: e.id, date: e.date, amount: e.amount, kind: e.kind }));
    const envelope: WalletEnvelope = { balance: usd(cents), entries };
    const eventName = envelopeEventName(ledger, id);
    if (eventName) envelope.eventName = eventName;
    if (a.autosave) envelope.autosave = a.autosave;
    envelopes[id] = envelope;
  }
  return { testMode: true, total: usd(totalCents), envelopes };
}

/** Loads the ledger and (unless given) the customer, then builds the summary. Null when the customer is gone. */
export async function loadSummary(customerId: string, customer?: StripeCustomer | null): Promise<WalletSummary | null> {
  const [ledger, found] = await Promise.all([
    loadLedger(customerId),
    customer === undefined ? getCustomer(customerId) : Promise.resolve(customer),
  ]);
  return found ? buildSummary(ledger, found) : null;
}
