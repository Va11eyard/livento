/**
 * Stripe REST client (server-only, TEST MODE ONLY).
 *
 * - Talks to the documented REST API with form-encoded bodies (no SDK).
 * - Pins `Stripe-Version: 2024-06-20` so field shapes stay stable.
 * - Refuses anything but a test key (`sk_test_` / `rk_test_`): live keys are never used.
 * - `STRIPE_API_BASE` may point at a local mock (scripts/stripe-mock.mjs); only
 *   loopback addresses are accepted so the key can't be sent to another host.
 * - Never logs or returns the key. Errors carry Stripe's `error.code` / `error.message`.
 */

export const STRIPE_API_VERSION = "2024-06-20";
const DEFAULT_BASE = "https://api.stripe.com";
const TIMEOUT_MS = 10_000;
const TEST_KEY = /^(sk|rk)_test_/;

/** The configured Stripe key when it is a test key, otherwise null. */
export function stripeTestKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key && TEST_KEY.test(key) ? key : null;
}

let warnedBase = false;

function apiBase(): string {
  const override = process.env.STRIPE_API_BASE?.trim();
  if (!override) return DEFAULT_BASE;
  try {
    const url = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) return url.origin;
  } catch {
    // fall through
  }
  if (!warnedBase) {
    warnedBase = true;
    console.warn("[stripe] STRIPE_API_BASE ignored: only a local mock address is allowed");
  }
  return DEFAULT_BASE;
}

/** Removes anything that looks like an API key from a message before it is kept or logged. */
function scrub(text: string): string {
  return text.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, "[key]").slice(0, 300);
}

export class StripeError extends Error {
  /** HTTP status from Stripe; 0 for timeouts, network failures and missing configuration. */
  readonly status: number;
  /** Stripe `error.code` (e.g. "card_declined", "resource_missing"), or a local code. */
  readonly code?: string;
  /** Stripe `error.type` (e.g. "card_error", "invalid_request_error", "idempotency_error"). */
  readonly type?: string;
  readonly declineCode?: string;

  constructor(message: string, status: number, code?: string, type?: string, declineCode?: string) {
    super(scrub(message));
    this.name = "StripeError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.declineCode = declineCode;
  }
}

export function isStripeError(err: unknown): err is StripeError {
  return err instanceof StripeError;
}

type ParamValue = string | number | boolean | null | undefined | ParamValue[] | { [key: string]: ParamValue };
export type StripeParams = Record<string, ParamValue>;

/** Stripe's bracket encoding: `a[b][c]=v`, arrays as `a[0]=v` (what the official SDKs send). */
export function encodeParams(params: StripeParams, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === undefined || item === null) return;
        if (typeof item === "object") encodeParams(item as StripeParams, `${name}[${index}]`, out);
        else out.append(`${name}[${index}]`, String(item));
      });
    } else if (typeof value === "object") {
      encodeParams(value as StripeParams, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

/**
 * One Stripe API call. GET params go in the query string, POST params in the body.
 * Throws StripeError on any failure (never returns a partial answer).
 */
export async function stripeApi<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: StripeParams,
  opts: StripeRequestOptions = {},
): Promise<T> {
  const key = stripeTestKey();
  if (!key) throw new StripeError("Stripe test mode is not configured.", 0, "not_configured");
  const encoded = params ? encodeParams(params).toString() : "";
  const url = `${apiBase()}${path}${method !== "POST" && encoded ? `?${encoded}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey.slice(0, 255);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? encoded : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new StripeError(
      timedOut ? "Stripe did not answer in time." : "Could not reach Stripe.",
      0,
      timedOut ? "timeout" : "network",
    );
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const e = (data?.error ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    throw new StripeError(
      str(e.message) ?? `Stripe HTTP ${res.status}`,
      res.status,
      str(e.code),
      str(e.type),
      str(e.decline_code),
    );
  }
  if (!data || typeof data !== "object") {
    throw new StripeError("Stripe sent an unexpected answer.", res.status, "invalid_response");
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// The few object shapes Livento reads (API version 2024-06-20)
// ---------------------------------------------------------------------------

export type StripeMetadata = Record<string, string>;

export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface StripeSearchResult<T> {
  object: "search_result";
  data: T[];
  has_more: boolean;
  next_page?: string | null;
}

export interface StripeCustomer {
  id: string;
  object: "customer";
  deleted?: boolean;
  metadata?: StripeMetadata;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
}

export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  created: number; // unix seconds
  customer: string | { id: string } | null;
  payment_method: string | { id: string } | null;
  latest_charge: string | StripeCharge | null;
  metadata?: StripeMetadata;
}

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  created: number;
  status: string | null;
  payment_intent: string | { id: string } | null;
  metadata?: StripeMetadata;
}

export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  url: string | null;
  created: number;
  customer: string | { id: string } | null;
  payment_status: string;
  status: string | null;
  metadata?: StripeMetadata | null;
  payment_intent: string | StripePaymentIntent | null;
}

/** The id of a field that is either an id string or an expanded object. */
export function stripeId(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : typeof value.id === "string" ? value.id : undefined;
}
