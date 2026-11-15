"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { eventHref } from "@/components/app/EventCard";
import { formatDate, safeExternalUrl, usd, usd0 } from "@/components/app/format";
import { PremiumGate } from "@/components/app/PremiumGate";
import { weeklySavings } from "@/components/app/savings";
import { NoProfile, Notice, PageSkeleton } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import {
  ClientApiError,
  createWallet,
  errorMessage,
  getHealth,
  isAbortError,
  walletAutosave,
  walletConfirm,
  walletDeposit,
  walletSummary,
  walletWithdraw,
} from "@/lib/client-api";
import {
  clearWallet,
  envelopeBalance,
  goalCoverage,
  getAppState,
  hasPremium,
  removeEnvelope,
  setWallet,
  syncEnvelopeLedger,
  useAppState,
  walletUnassigned,
  useHydrated,
  walletTotal,
} from "@/lib/storage";
import { todayISO } from "@/lib/dates";
import {
  GENERAL_ENVELOPE_ID,
  GENERAL_ENVELOPE_NAME,
  WALLET_MAX_AMOUNT,
  WALLET_MIN_AMOUNT,
  type AppState,
  type Envelope,
  type LiventoEvent,
  type WalletEntryKind,
  type WalletEnvelope,
  type WalletSummary,
} from "@/lib/types";
import styles from "./envelopes.module.css";

type Live = "checking" | "live" | "off" | "error";
/** full = add money + auto-save + withdraw; withdraw = money out only (no Premium); readonly = no money buttons. */
type CardMode = "full" | "withdraw" | "readonly";
type Arrival = { kind: "return"; sessionId: string } | { kind: "cancel" } | null;

const KIND_LABEL: Record<WalletEntryKind, string> = {
  deposit: "Added by card",
  autosave: "Automatic weekly withdrawal",
  withdrawal: "Withdrawn to card",
};

const SESSION_ID = /^cs_[A-Za-z0-9_]{6,250}$/;
const EMPTY_SUMMARY: WalletSummary = { testMode: true, total: 0, envelopes: {} };
const HISTORY_LIMIT = 12;

const round = (n: number) => Math.round(n * 100) / 100;

function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** The weekly savings rule, kept inside what one wallet payment may be. */
function weeklyFor(envelope: Envelope, balance: number): number {
  const { weekly } = weeklySavings(envelope.target, balance, envelope.deadline);
  return weekly > 0 ? Math.min(WALLET_MAX_AMOUNT, Math.max(WALLET_MIN_AMOUNT, weekly)) : 0;
}

/** 401/404: the server no longer accepts this browser's wallet link. */
function isWalletGone(err: unknown): boolean {
  return err instanceof ClientApiError && (err.status === 401 || err.status === 404);
}

/** Where added money goes: a goal's envelope, or the general balance (no goal, no target). */
type DepositTarget = { id: string; eventName: string; target?: number };

/** One row of an envelope's history, newest first. */
type HistoryItem = { key: string; date: string; kind: WalletEntryKind; amount: number };

function History({ items }: { items: HistoryItem[] }) {
  return (
    <details className={styles.history}>
      <summary>
        History ({items.length} {items.length === 1 ? "entry" : "entries"})
      </summary>
      <ul className={ui.plainList}>
        {items.slice(0, HISTORY_LIMIT).map((d) => (
          <li key={d.key}>
            <span>{formatDate(d.date, "medium")}</span>
            <span>{KIND_LABEL[d.kind]}</span>
            <span className={styles.amount}>
              {d.amount >= 0 ? "+" : "−"}
              {usd(Math.abs(d.amount))}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

interface WalletActions {
  busy: string | null;
  /** Opens Stripe Checkout; resolves with an error message when it couldn't. */
  addMoney: (to: DepositTarget, amount: number, autosave: boolean) => Promise<string | null>;
  stopAutosave: (envelopeId: string, name: string) => void;
  /** `version` = entries in the envelope's ledger: the same view retried gives the same request id. */
  withdraw: (envelopeId: string, name: string, amount: number, version: number) => void;
}

function WithdrawButton({
  envelopeId,
  name,
  balance,
  autosaveOn,
  version,
  actions,
}: {
  envelopeId: string;
  name: string;
  balance: number;
  autosaveOn: boolean;
  version: number;
  actions: WalletActions;
}) {
  const working = actions.busy === `withdraw:${envelopeId}`;
  return (
    <ConfirmDialog
      triggerLabel={working ? "Withdrawing…" : "Withdraw to card"}
      triggerClassName="pill small alt"
      triggerAriaLabel={`Withdraw ${usd(balance)} for ${name} to your card`}
      title={`Withdraw ${usd(balance)} to your card?`}
      description={`It goes back to the card it came from.${
        autosaveOn ? " Auto-save stays on; stop it if you don't want more weekly withdrawals." : ""
      }`}
      confirmLabel={`Withdraw ${usd(balance)}`}
      cancelLabel="Keep it"
      onConfirm={() => actions.withdraw(envelopeId, name, balance, version)}
    />
  );
}

function EnvelopeCard({
  envelope,
  event,
  wallet,
  mode,
  actions,
}: {
  envelope: Envelope;
  event?: LiventoEvent;
  wallet?: WalletEnvelope;
  mode: CardMode;
  actions: WalletActions;
}) {
  const id = useId();
  const notify = useToast();
  const coverage = goalCoverage(useAppState()).get(envelope.id);
  const balance = coverage?.covered ?? envelopeBalance(envelope);
  const weekly = weeklyFor(envelope, balance);
  const [amount, setAmount] = useState(weekly > 0 ? String(weekly) : "");
  const [error, setError] = useState<string | null>(null);
  const autosave = wallet?.autosave;
  const history = envelope.deposits.filter((d) => d.ref).reverse();
  const busy = actions.busy !== null;
  const name = envelope.eventName;
  const restartWeekly = weekly > 0 ? weekly : autosave ? Math.min(WALLET_MAX_AMOUNT, autosave.weekly) : 0;

  const startCheckout = async (value: number, withAutosave: boolean) => {
    setError(null);
    const message = await actions.addMoney(envelope, value, withAutosave);
    if (message) setError(message);
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const value = parseAmount(amount);
    if (value === null || value < WALLET_MIN_AMOUNT || value > WALLET_MAX_AMOUNT) {
      setError(`Enter an amount from ${usd(WALLET_MIN_AMOUNT)} to ${usd0(WALLET_MAX_AMOUNT)}.`);
      return;
    }
    void startCheckout(value, false);
  };

  const blockDelete = balance > 0 ? "money" : autosave?.status === "active" ? "autosave" : null;

  return (
    <article className={styles.card} aria-labelledby={`${id}-title`}>
      <div className={styles.cardHead}>
        <div className={styles.cardIntro}>
          <h2 id={`${id}-title`} className={styles.cardTitle}>
            {event ? <Link href={eventHref(envelope.eventId)}>{name}</Link> : name}
          </h2>
          <p className={ui.meta}>
            {envelope.eventDate ? `Event ${formatDate(envelope.eventDate, "medium")} · ` : ""}
            Needed by {formatDate(envelope.deadline, "medium")} · Goal {usd0(envelope.target)}{" "}
            <span className="tag estimate">Estimate</span>
          </p>
        </div>
        {blockDelete ? (
          <button
            type="button"
            className={styles.delete}
            aria-label={`Delete the envelope for ${name}`}
            onClick={() =>
              blockDelete === "money"
                ? notify(
                    "Withdraw the money first.",
                    `This envelope holds ${usd(balance)}. Withdraw it to your card, then delete the envelope.`,
                  )
                : notify("Stop auto-save first.", "Auto-save would keep adding money to this envelope.")
            }
          >
            Delete
          </button>
        ) : (
          <ConfirmDialog
            triggerLabel="Delete"
            triggerAriaLabel={`Delete the envelope for ${name}`}
            triggerClassName={styles.delete}
            title="Delete this envelope?"
            description={`This removes the ${name} envelope from this browser. It holds no money.`}
            confirmLabel="Delete envelope"
            cancelLabel="Keep it"
            onConfirm={() => {
              removeEnvelope(envelope.id);
              notify("Envelope deleted");
            }}
          />
        )}
      </div>

      <EnvelopeBar balance={balance} target={envelope.target} label={`In your wallet for ${name}`} />
      {coverage && coverage.fromWallet > 0 ? (
        <p className={ui.meta}>Includes {usd0(coverage.fromWallet)} from your wallet balance.</p>
      ) : null}

      {mode === "full" ? (
        <div className={styles.cardBody}>
          <form className={styles.block} onSubmit={onAdd} noValidate>
            <div className="field">
              <label htmlFor={`${id}-amount`}>Add money ($)</label>
              <div className={styles.amountRow}>
                <input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  placeholder="e.g. 25"
                  value={amount}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : `${id}-help`}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setError(null);
                  }}
                />
                <button type="submit" className="pill small" disabled={busy}>
                  {actions.busy === `add:${envelope.id}` ? "Opening checkout…" : "Add money"}{" "}
                  <span aria-hidden="true">↗</span>
                </button>
              </div>
            </div>
            {error ? (
              <p id={`${id}-error`} className={ui.error} role="alert">
                {error}
              </p>
            ) : (
              <p id={`${id}-help`} className="help">
                {weekly > 0 ? `${usd0(weekly)} a week reaches the goal by ${formatDate(envelope.deadline, "medium")}. ` : ""}
                You pay by card on Stripe&rsquo;s checkout page.
              </p>
            )}
          </form>

          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Auto-save</h3>
            {autosave?.status === "active" ? (
              <>
                <p className={styles.autoOn}>
                  <strong>Auto-save on: {usd(autosave.weekly)} every week</strong> · next withdrawal{" "}
                  {formatDate(autosave.nextDate, "medium")}
                </p>
                <div className={ui.actions}>
                  <button
                    type="button"
                    className="pill small alt"
                    disabled={busy}
                    onClick={() => actions.stopAutosave(envelope.id, name)}
                  >
                    {actions.busy === `stop:${envelope.id}` ? "Stopping…" : "Stop"}
                  </button>
                </div>
              </>
            ) : autosave?.status === "failed" ? (
              <>
                <p className={styles.autoFailed}>The last automatic withdrawal failed</p>
                <p className="help">
                  The card was declined or needs confirming. Turning it on again withdraws {usd0(restartWeekly)} now, then
                  every week.
                </p>
                <div className={ui.actions}>
                  <button
                    type="button"
                    className="pill small"
                    disabled={busy || restartWeekly <= 0}
                    onClick={() => void startCheckout(restartWeekly, true)}
                  >
                    {actions.busy === `autosave:${envelope.id}` ? "Opening checkout…" : "Turn on again"}
                  </button>
                </div>
              </>
            ) : weekly > 0 ? (
              <>
                <div className={ui.actions}>
                  <button
                    type="button"
                    className="pill small"
                    disabled={busy}
                    onClick={() => void startCheckout(weekly, true)}
                  >
                    {actions.busy === `autosave:${envelope.id}` ? "Opening checkout…" : `Turn on auto-save · ${usd0(weekly)}/week`}
                  </button>
                </div>
                <p className="help">
                  The first {usd0(weekly)} is withdrawn from your card now, then {usd0(weekly)} every week until the goal is
                  reached. Stop anytime.
                </p>
              </>
            ) : (
              <p className={ui.meta}>Goal reached, so auto-save isn&rsquo;t needed.</p>
            )}
          </div>
        </div>
      ) : null}

      {mode === "withdraw" && autosave?.status === "active" ? (
        <div className={styles.cardFoot}>
          <p className={styles.autoOn}>
            <strong>Auto-save on: {usd(autosave.weekly)} every week</strong> · next withdrawal{" "}
            {formatDate(autosave.nextDate, "medium")}
          </p>
          <button
            type="button"
            className="pill small alt"
            disabled={busy}
            onClick={() => actions.stopAutosave(envelope.id, name)}
          >
            {actions.busy === `stop:${envelope.id}` ? "Stopping…" : "Stop auto-save"}
          </button>
        </div>
      ) : null}

      {(mode !== "readonly" && balance > 0) || history.length ? (
        <div className={styles.cardFoot}>
          {mode !== "readonly" && balance > 0 ? (
            <WithdrawButton
              envelopeId={envelope.id}
              name={name}
              balance={balance}
              autosaveOn={autosave?.status === "active"}
              version={wallet?.entries.length ?? history.length}
              actions={actions}
            />
          ) : null}
          {history.length ? (
            <History
              items={history.map((d) => ({
                key: d.ref ?? `${d.date}-${d.amount}`,
                date: d.date,
                kind: d.kind ?? (d.amount < 0 ? "withdrawal" : "deposit"),
                amount: d.amount,
              }))}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The general balance: money added with no goal. `canAdd` (Premium) shows the amount
 * field; withdrawing never needs Premium.
 */
function GeneralCard({
  wallet,
  fallbackBalance,
  canAdd,
  actions,
}: {
  wallet?: WalletEnvelope;
  fallbackBalance: number;
  canAdd: boolean;
  actions: WalletActions;
}) {
  const id = useId();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const balance = wallet ? wallet.balance : fallbackBalance;
  const unassigned = walletUnassigned(useAppState());
  const history: HistoryItem[] = (wallet?.entries ?? [])
    .map((entry) => ({
      key: entry.id,
      date: todayISO(new Date(entry.date)), // the viewer's calendar date
      kind: entry.kind,
      amount: entry.amount,
    }))
    .reverse();
  const busy = actions.busy !== null;

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseAmount(amount);
    if (value === null || value < WALLET_MIN_AMOUNT || value > WALLET_MAX_AMOUNT) {
      setError(`Enter an amount from ${usd(WALLET_MIN_AMOUNT)} to ${usd0(WALLET_MAX_AMOUNT)}.`);
      return;
    }
    setError(null);
    const message = await actions.addMoney({ id: GENERAL_ENVELOPE_ID, eventName: GENERAL_ENVELOPE_NAME }, value, false);
    if (message) setError(message);
  };

  return (
    <section className={`${styles.card} ${styles.addCard}`} aria-labelledby={`${id}-title`}>
      <div className={styles.cardHead}>
        <div className={styles.cardIntro}>
          <h2 id={`${id}-title`} className={styles.cardTitle}>
            {canAdd ? "Add money" : "Wallet balance"}
          </h2>
          <p className={ui.meta}>
            No goal needed: it counts toward your goals, soonest first, and stays in your wallet until you withdraw it
            to your card.
            {unassigned < balance ? ` ${usd0(round(balance - unassigned))} of it is covering your goals now.` : ""}
          </p>
        </div>
        <p className={styles.addBalance}>
          <span className={styles.totalLabel}>Balance</span>
          <strong>{usd(balance)}</strong>
        </p>
      </div>

      {canAdd ? (
        <form className={styles.block} onSubmit={(e) => void onAdd(e)} noValidate>
          <div className="field">
            <label htmlFor={`${id}-amount`}>Amount ($)</label>
            <div className={styles.amountRow}>
              <input
                id={`${id}-amount`}
                inputMode="decimal"
                placeholder="e.g. 50"
                value={amount}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : `${id}-help`}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
              />
              <button type="submit" className="pill" disabled={busy}>
                {actions.busy === `add:${GENERAL_ENVELOPE_ID}` ? "Opening checkout…" : "Add money"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
          {error ? (
            <p id={`${id}-error`} className={ui.error} role="alert">
              {error}
            </p>
          ) : (
            <p id={`${id}-help`} className="help">
              You pay by card on Stripe&rsquo;s checkout page.
            </p>
          )}
        </form>
      ) : null}

      {(wallet && balance > 0) || history.length ? (
        <div className={styles.cardFoot}>
          {wallet && balance > 0 ? (
            <WithdrawButton
              envelopeId={GENERAL_ENVELOPE_ID}
              name="your wallet balance"
              balance={balance}
              autosaveOn={false}
              version={wallet?.entries.length ?? 0}
              actions={actions}
            />
          ) : null}
          {history.length ? <History items={history} /> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Wallet money whose envelope isn't in this browser's list (e.g. deleted elsewhere). */
function OtherMoney({ items, actions }: { items: [string, WalletEnvelope][]; actions: WalletActions }) {
  return (
    <section className={styles.others} aria-labelledby="other-money-title">
      <h2 id="other-money-title" className={ui.smallTitle}>
        Other money in your wallet
      </h2>
      <p className={ui.meta}>For goals that aren&rsquo;t in this browser&rsquo;s list anymore.</p>
      <ul className={ui.plainList}>
        {items.map(([envelopeId, w]) => {
          const name = w.eventName ?? "A removed goal";
          return (
            <li key={envelopeId} className={styles.otherRow}>
              <span className={styles.otherName}>{name}</span>
              <strong className={styles.amount}>{usd(w.balance)}</strong>
              <span className={ui.actions}>
                {w.autosave?.status === "active" ? (
                  <button
                    type="button"
                    className="pill small alt"
                    disabled={actions.busy !== null}
                    onClick={() => actions.stopAutosave(envelopeId, name)}
                  >
                    Stop auto-save
                  </button>
                ) : null}
                {w.balance > 0 ? (
                  <WithdrawButton
                    envelopeId={envelopeId}
                    name={name}
                    balance={w.balance}
                    autosaveOn={w.autosave?.status === "active"}
                    version={w.entries.length}
                    actions={actions}
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useWalletLive(): Live {
  const [live, setLive] = useState<Live>("checking");
  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((h) => setLive(h.integrations.some((i) => i.key === "wallet" && i.state === "test") ? "live" : "off"))
      .catch((err) => {
        if (!isAbortError(err)) setLive("error");
      });
    return () => controller.abort();
  }, []);
  return live;
}

function Wallet({ state }: { state: AppState }) {
  const notify = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const live = useWalletLive();
  const token = state.wallet?.token;
  const premium = hasPremium(state);

  // Why we arrived (Stripe Checkout return / cancel), remembered after the URL is cleaned.
  const [arrival] = useState<Arrival>(() => {
    const kind = params.get("wallet");
    const sessionId = params.get("session_id") ?? "";
    if (kind === "return" && SESSION_ID.test(sessionId)) return { kind: "return", sessionId };
    if (kind === "cancel") return { kind: "cancel" };
    return null;
  });
  const [pendingSession, setPendingSession] = useState(arrival?.kind === "return" ? arrival.sessionId : null);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const cancelHandled = useRef(false);

  const apply = (next: WalletSummary) => {
    syncEnvelopeLedger(next);
    setSummary(next);
    setLoadError(null);
  };

  const forgetWallet = () => {
    clearWallet();
    syncEnvelopeLedger(EMPTY_SUMMARY);
    setSummary(null);
    notify("Your wallet link no longer works here", "A new wallet will be created when you add money.");
  };

  // Load balances from Stripe (skipped while a checkout return is being confirmed).
  useEffect(() => {
    if (live !== "live" || !token || pendingSession) return;
    const controller = new AbortController();
    walletSummary(token, controller.signal)
      .then((next) => {
        syncEnvelopeLedger(next);
        setSummary(next);
        setLoadError(null);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        if (isWalletGone(err)) {
          clearWallet();
          syncEnvelopeLedger(EMPTY_SUMMARY);
          setSummary(null);
          return;
        }
        setLoadError(errorMessage(err));
      });
    return () => controller.abort();
  }, [live, token, pendingSession, attempt]);

  // Back from Stripe Checkout: confirm (idempotent), toast, sync, then clean the URL.
  useEffect(() => {
    if (live !== "live" || !pendingSession || !token) return;
    const controller = new AbortController();
    walletConfirm({ token, sessionId: pendingSession }, controller.signal)
      .then((next) => {
        syncEnvelopeLedger(next);
        setSummary(next);
        setLoadError(null);
        const done = next.confirmed;
        if (done?.autosave) {
          const schedule = next.envelopes[done.envelopeId]?.autosave;
          notify(
            `Auto-save is on: ${usd(done.amount)} a week`,
            schedule?.status === "active"
              ? `The first ${usd(done.amount)} is in your wallet. Next withdrawal ${formatDate(schedule.nextDate, "medium")}.`
              : `The first ${usd(done.amount)} is in your wallet and covers the goal.`,
          );
        } else if (done) {
          notify(`Added ${usd(done.amount)} to your wallet`);
        } else {
          notify("Your wallet is up to date");
        }
        setPendingSession(null);
        router.replace("/envelopes", { scroll: false });
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        if (isWalletGone(err) || (err instanceof ClientApiError && (err.status === 403 || err.status === 409))) {
          if (isWalletGone(err)) {
            clearWallet();
            syncEnvelopeLedger(EMPTY_SUMMARY);
          }
          notify("Nothing was added", errorMessage(err));
          setPendingSession(null);
          router.replace("/envelopes", { scroll: false });
          return;
        }
        setLoadError(errorMessage(err));
      });
    return () => controller.abort();
  }, [live, pendingSession, token, attempt, notify, router]);

  // Checkout canceled: a neutral note, then clean the URL.
  useEffect(() => {
    if (arrival?.kind !== "cancel" || cancelHandled.current) return;
    cancelHandled.current = true;
    notify("Checkout canceled", "Nothing was charged.");
    router.replace("/envelopes", { scroll: false });
  }, [arrival, notify, router]);

  const actions: WalletActions = {
    busy,
    addMoney: async (to, amount, autosave) => {
      setBusy(`${autosave ? "autosave" : "add"}:${to.id}`);
      const open = async (fresh: boolean) => {
        let current = fresh ? undefined : getAppState().wallet?.token;
        if (!current) {
          current = (await createWallet()).token;
          setWallet(current);
        }
        return walletDeposit({
          token: current,
          envelopeId: to.id,
          eventName: to.eventName,
          amount,
          target: to.target,
          autosave,
        });
      };
      try {
        let res;
        try {
          res = await open(false);
        } catch (err) {
          if (!isWalletGone(err)) throw err;
          clearWallet();
          res = await open(true); // the old link is unusable: start a new wallet once
        }
        const url = safeExternalUrl(res.url);
        if (!url) throw new ClientApiError("We got an unexpected answer from the server. Please try again.", "invalid");
        window.location.assign(url);
        return null; // stay busy while the browser leaves for Checkout
      } catch (err) {
        setBusy(null);
        return errorMessage(err);
      }
    },
    stopAutosave: (envelopeId, name) => {
      const current = getAppState().wallet?.token;
      if (!current) return;
      setBusy(`stop:${envelopeId}`);
      walletAutosave({ token: current, envelopeId, weekly: null })
        .then((next) => {
          apply(next);
          notify("Auto-save stopped", `No more weekly withdrawals for ${name}. The money saved stays in your wallet.`);
        })
        .catch((err) => (isWalletGone(err) ? forgetWallet() : notify("Auto-save is still on", errorMessage(err))))
        .finally(() => setBusy(null));
    },
    withdraw: (envelopeId, name, amount, version) => {
      const current = getAppState().wallet?.token;
      if (!current) return;
      setBusy(`withdraw:${envelopeId}`);
      const requestId = `${envelopeId}-${version}-${Math.round(amount * 100)}`;
      walletWithdraw({ token: current, envelopeId, requestId })
        .then((next) => {
          apply(next);
          notify(`Withdrawn to your card: ${usd(amount)}`, `From ${name}.`);
        })
        .catch((err) => {
          if (isWalletGone(err)) return forgetWallet();
          notify("The withdrawal didn't finish", errorMessage(err));
          setAttempt((n) => n + 1); // reload balances: part of it may have gone through
        })
        .finally(() => setBusy(null));
    },
  };

  const walletLive = live === "live";
  const localIds = new Set(state.envelopes.map((e) => e.id.toLowerCase()));
  const others = summary
    ? Object.entries(summary.envelopes).filter(
        ([envelopeId, w]) =>
          envelopeId !== GENERAL_ENVELOPE_ID &&
          !localIds.has(envelopeId) &&
          (w.balance > 0 || w.autosave?.status === "active"),
      )
    : [];
  const total = summary ? summary.total : walletTotal(state);
  const generalWallet = summary?.envelopes[GENERAL_ENVELOPE_ID];
  const generalBalance = generalWallet ? generalWallet.balance : (state.walletGeneral ?? 0);
  // The general balance: always with Premium (it's where "Add money" lives), otherwise only while it holds money.
  const showGeneral = walletLive && (premium || generalBalance > 0);
  const goals = state.envelopes.reduce((sum, e) => sum + e.target, 0);
  const autosaveOn = (envelopeId: string) => summary?.envelopes[envelopeId.toLowerCase()]?.autosave?.status === "active";
  const cardMode: CardMode = !walletLive ? "readonly" : premium ? "full" : "withdraw";
  // Without Premium, show only what still needs the user: money to withdraw or an auto-save to stop.
  const shownEnvelopes = premium
    ? state.envelopes
    : state.envelopes.filter((e) => envelopeBalance(e) > 0 || autosaveOn(e.id));
  const hasMoney = total > 0 || others.length > 0 || (!premium && shownEnvelopes.length > 0);
  const showList = premium || (walletLive && hasMoney);

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">02 / Wallet</p>
        <div className={ui.headRow}>
          <h1 className="title">Your Livento wallet</h1>
          {walletLive && (premium || hasMoney) ? (
            <div className={styles.total}>
              <span className={styles.totalLabel}>Wallet total</span>
              <span className={ui.figure}>{usd(total)}</span>
              {goals > 0 ? <span className={ui.meta}>toward {usd0(goals)} in goals</span> : null}
            </div>
          ) : null}
        </div>
        <p className="lead muted">
          Add money by card, keep an envelope for each goal, and save a set amount every week automatically. Withdraw to
          your card anytime.
        </p>
      </header>

      <div className={styles.status}>
        {live === "checking" ? (
          <p className={ui.status} role="status">
            Checking the wallet…
          </p>
        ) : live === "error" ? (
          <Notice tone="error">We couldn&rsquo;t check the wallet right now. Reload the page to try again.</Notice>
        ) : live === "off" ? (
          <Notice label="Wallet">The wallet isn&rsquo;t connected on this deployment yet, so money can&rsquo;t be added.</Notice>
        ) : (
          <p className={ui.meta}>Your wallet is linked to this browser, no account needed.</p>
        )}
        {walletLive && pendingSession && !token ? (
          <Notice tone="error">This payment was made from another browser&rsquo;s wallet, so it can&rsquo;t be shown here.</Notice>
        ) : null}
        {walletLive && pendingSession && token && !loadError ? (
          <p className={ui.status} role="status">
            Confirming your payment with Stripe…
          </p>
        ) : null}
        {walletLive && loadError ? (
          <Notice
            tone="error"
            action={
              <button type="button" className="pill small alt" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            }
          >
            {loadError}
          </Notice>
        ) : null}
      </div>

      {!premium ? (
        <PremiumGate
          title="The wallet is Premium"
          description="Add money to your Livento wallet by card, keep an envelope for each goal, save automatically every week, and withdraw to your card anytime."
        />
      ) : null}

      {showList ? (
        <div className={`${styles.list} ${!premium ? styles.listAfterGate : ""}`}>
          {!premium && (shownEnvelopes.length || showGeneral) ? (
            <h2 className={ui.smallTitle}>Money in your wallet</h2>
          ) : null}
          {showGeneral ? (
            <GeneralCard wallet={generalWallet} fallbackBalance={generalBalance} canAdd={premium} actions={actions} />
          ) : null}
          {premium && state.envelopes.length === 0 ? (
            <div className={ui.outline}>
              <h2 className={ui.smallTitle}>No goals yet</h2>
              <p className={styles.emptyText}>
                {walletLive
                  ? "Add money now, or pick an event and tap Save for it to save toward a goal."
                  : "Pick an event and tap Save for it to save toward a goal."}
              </p>
              <Link href="/discover" className="pill">
                Find an event <span aria-hidden="true">↗</span>
              </Link>
            </div>
          ) : null}
          {shownEnvelopes.map((envelope) => (
            <EnvelopeCard
              key={envelope.id}
              envelope={envelope}
              event={state.savedEvents[envelope.eventId]}
              wallet={summary?.envelopes[envelope.id.toLowerCase()]}
              mode={cardMode}
              actions={actions}
            />
          ))}
          {walletLive && others.length ? <OtherMoney items={others} actions={actions} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** /envelopes — the Livento wallet: balances, add money by card, weekly auto-save, withdraw to card. */
export function EnvelopesView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading your wallet…" />;
  if (!state.profile && state.envelopes.length === 0 && !state.wallet) {
    return <NoProfile text="Set up a quick profile (or use the sample), then pick an event and tap Save for it." />;
  }
  return <Wallet state={state} />;
}
