/**
 * Typed fetch wrappers for every Livento API route (spec §7).
 *
 * - Each call has an AbortController timeout (events 10 s, LLM routes 25 s).
 * - Pass your own AbortSignal to cancel on unmount; a cancel rethrows the
 *   AbortError (check with `isAbortError`) so callers can ignore it.
 * - Every other failure becomes a ClientApiError with a friendly message that
 *   is safe to show. Raw upstream errors never reach the UI.
 */
import type {
  AlertSubscribeRequest,
  AlertSubscribeResponse,
  AssistantRequest,
  AssistantResponse,
  AssistantStatusResponse,
  Category,
  CheckoutRequest,
  CheckoutResponse,
  CheckoutSessionRequest,
  CheckoutSessionResponse,
  EventsResponse,
  HealthResponse,
  InsightsRequest,
  InsightsResponse,
  LogRequest,
  PlanRequest,
  PlanResponse,
  Profile,
  QuoteRequest,
  QuoteResponse,
  RecommendRequest,
  RecommendResponse,
  RoadmapRequest,
  RoadmapResponse,
  WalletAutosaveRequest,
  WalletConfirmRequest,
  WalletConfirmResponse,
  WalletCreateResponse,
  WalletDepositRequest,
  WalletDepositResponse,
  WalletSummary,
  WalletWithdrawRequest,
} from "@/lib/types";

export const TIMEOUTS = {
  events: 10_000,
  llm: 25_000,
  standard: 10_000,
  log: 5_000,
} as const;

export type ClientApiErrorKind = "timeout" | "network" | "http" | "invalid";

export class ClientApiError extends Error {
  readonly kind: ClientApiErrorKind;
  /** HTTP status, 0 for timeouts and network failures. */
  readonly status: number;

  constructor(message: string, kind: ClientApiErrorKind, status = 0) {
    super(message);
    this.name = "ClientApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** True when the request was cancelled by the caller (unmount, newer request). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/** A message that is always safe to show to the user. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ClientApiError) return err.message;
  return fallback;
}

const MESSAGES = {
  timeout: "This is taking longer than usual. Please try again in a moment.",
  network: "We couldn't reach Livento. Check your connection and try again.",
  invalid: "We got an unexpected answer from the server. Please try again.",
  tooMany: "Lots of requests right now. Wait a few seconds and try again.",
  tooLarge: "That file is too large. The limit is 1 MB.",
  badRequest: "Something in that request didn't look right. Please check it and try again.",
  server: "Something went wrong on our side. Please try again.",
} as const;

function statusMessage(status: number): string {
  if (status === 429) return MESSAGES.tooMany;
  if (status === 413) return MESSAGES.tooLarge;
  if (status >= 400 && status < 500) return MESSAGES.badRequest;
  return MESSAGES.server;
}

/** Server error text is shown only when it is a short, plain sentence. */
function safeServerMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  const text = (data as { error?: unknown }).error;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 220 || /[<>{}]/.test(trimmed)) return undefined;
  return trimmed;
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  keepalive?: boolean;
}

async function call<T>(path: string, opts: CallOptions, validate: (data: unknown) => data is T): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method: opts.method ?? "GET",
        headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        keepalive: opts.keepalive,
        cache: "no-store",
      });
    } catch (err) {
      if (timedOut) throw new ClientApiError(MESSAGES.timeout, "timeout");
      if (external?.aborted || isAbortError(err)) throw err;
      throw new ClientApiError(MESSAGES.network, "network");
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch (err) {
      if (timedOut) throw new ClientApiError(MESSAGES.timeout, "timeout");
      if (external?.aborted) throw err;
      data = null;
    }

    if (!res.ok) {
      throw new ClientApiError(safeServerMessage(data) ?? statusMessage(res.status), "http", res.status);
    }
    if (!validate(data)) throw new ClientApiError(MESSAGES.invalid, "invalid", res.status);
    return data;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Shape guards (light: enough to never crash a page on an unexpected answer)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isEventsResponse = (d: unknown): d is EventsResponse => isObject(d) && Array.isArray(d.events);
const isRecommendResponse = (d: unknown): d is RecommendResponse => isObject(d) && Array.isArray(d.items);
const isPlanResponse = (d: unknown): d is PlanResponse =>
  isObject(d) && Array.isArray(d.lines) && typeof d.total === "number";
const isRoadmapResponse = (d: unknown): d is RoadmapResponse => isObject(d) && Array.isArray(d.steps);
const isInsightsResponse = (d: unknown): d is InsightsResponse => isObject(d) && Array.isArray(d.months);
const isAlertResponse = (d: unknown): d is AlertSubscribeResponse => isObject(d) && typeof d.ok === "boolean";
const isCheckoutResponse = (d: unknown): d is CheckoutResponse => isObject(d);
const isHealthResponse = (d: unknown): d is HealthResponse => isObject(d) && Array.isArray(d.integrations);
/** /api/log answers are ignored; any body (or none) is fine. */
const isAnything = (d: unknown): d is unknown => d !== undefined;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface EventsQuery {
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  categories?: Category[];
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  keyword?: string;
}

/** The events query that matches a profile. */
export function eventsQueryFromProfile(profile: Profile): EventsQuery {
  return {
    city: profile.city,
    state: profile.stateCode,
    lat: profile.lat,
    lng: profile.lng,
    radius: profile.radiusMiles,
    categories: [...profile.interests].sort(),
  };
}

export function eventsSearchParams(query: EventsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.city) params.set("city", query.city);
  if (query.state) params.set("state", query.state);
  if (typeof query.lat === "number" && Number.isFinite(query.lat)) params.set("lat", String(query.lat));
  if (typeof query.lng === "number" && Number.isFinite(query.lng)) params.set("lng", String(query.lng));
  if (typeof query.radius === "number" && Number.isFinite(query.radius)) params.set("radius", String(query.radius));
  if (query.categories && query.categories.length) params.set("categories", query.categories.join(","));
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.keyword) params.set("keyword", query.keyword);
  return params;
}

/** GET /api/events — live listings, or labeled sample events (`source: "sample"` + notice). */
export function getEvents(query: EventsQuery, signal?: AbortSignal): Promise<EventsResponse> {
  const qs = eventsSearchParams(query).toString();
  return call(`/api/events${qs ? `?${qs}` : ""}`, { timeoutMs: TIMEOUTS.events, signal }, isEventsResponse);
}

/** GET /api/events?id= — one event by id, for links opened in a browser that never saw it. */
export function getEventById(id: string, signal?: AbortSignal): Promise<EventsResponse> {
  const qs = new URLSearchParams({ id }).toString();
  return call(`/api/events?${qs}`, { timeoutMs: TIMEOUTS.events, signal }, isEventsResponse);
}

/** POST /api/recommend — top 8 with a "why this" line. */
export function recommend(req: RecommendRequest, signal?: AbortSignal): Promise<RecommendResponse> {
  return call("/api/recommend", { method: "POST", body: req, timeoutMs: TIMEOUTS.llm, signal }, isRecommendResponse);
}

/** POST /api/plan — the same rules as lib/cost buildPlan, computed on the server. */
export function plan(req: PlanRequest, signal?: AbortSignal): Promise<PlanResponse> {
  return call("/api/plan", { method: "POST", body: req, timeoutMs: TIMEOUTS.standard, signal }, isPlanResponse);
}

/** POST /api/roadmap — dated steps for one event. */
export function roadmap(req: RoadmapRequest, signal?: AbortSignal): Promise<RoadmapResponse> {
  return call("/api/roadmap", { method: "POST", body: req, timeoutMs: TIMEOUTS.llm, signal }, isRoadmapResponse);
}

/** POST /api/insights — CSV text (read in the browser, never stored) or the labeled sample statement. */
export function insights(req: InsightsRequest, signal?: AbortSignal): Promise<InsightsResponse> {
  return call("/api/insights", { method: "POST", body: req, timeoutMs: TIMEOUTS.llm, signal }, isInsightsResponse);
}

/** POST /api/alerts — email or Telegram alerts. `ok: false` + message when not configured. */
export function subscribeAlerts(req: AlertSubscribeRequest, signal?: AbortSignal): Promise<AlertSubscribeResponse> {
  return call("/api/alerts", { method: "POST", body: req, timeoutMs: TIMEOUTS.standard, signal }, isAlertResponse);
}

/** POST /api/checkout — test-mode checkout URL, or `{ demo: true }` when payments are not configured. */
export function checkout(req: CheckoutRequest, signal?: AbortSignal): Promise<CheckoutResponse> {
  return call("/api/checkout", { method: "POST", body: req, timeoutMs: TIMEOUTS.standard, signal }, isCheckoutResponse);
}

const isCheckoutSessionResponse = (d: unknown): d is CheckoutSessionResponse =>
  isObject(d) && typeof d.ok === "boolean";

/** POST /api/checkout/session — confirm a finished Premium test checkout, or cancel its subscription. */
export function checkoutSession(req: CheckoutSessionRequest, signal?: AbortSignal): Promise<CheckoutSessionResponse> {
  return call(
    "/api/checkout/session",
    { method: "POST", body: req, timeoutMs: TIMEOUTS.standard, signal },
    isCheckoutSessionResponse,
  );
}

/** GET /api/health — which integrations are configured on this deployment (no key values). */
export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return call("/api/health", { timeoutMs: TIMEOUTS.standard, signal }, isHealthResponse);
}

const isQuoteResponse = (d: unknown): d is QuoteResponse =>
  isObject(d) && typeof d.text === "string" && d.text.trim() !== "" && (d.source === "ai" || d.source === "curated");

/** POST /api/quote — a short motivational line about the user's goals (AI, or a curated line as fallback). */
export function quoteForGoals(req: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse> {
  return call("/api/quote", { method: "POST", body: req, timeoutMs: TIMEOUTS.llm, signal }, isQuoteResponse);
}

/** Ask Livento runs a few calculator rounds per answer (server deadline 45 s), so it gets a longer timeout. */
const ASSISTANT_TIMEOUT_MS = 60_000;

const isAssistantResponse = (d: unknown): d is AssistantResponse =>
  isObject(d) &&
  (d.off === true
    ? typeof d.message === "string"
    : typeof d.text === "string" && Array.isArray(d.actions) && Array.isArray(d.usedTools));
const isAssistantStatus = (d: unknown): d is AssistantStatusResponse =>
  isObject(d) && (d.off === false || (d.off === true && typeof d.message === "string"));

/** POST /api/assistant — one Ask Livento turn: plain-text answer + server-built action links, or `{ off: true }`. */
export function askAssistant(req: AssistantRequest, signal?: AbortSignal): Promise<AssistantResponse> {
  return call("/api/assistant", { method: "POST", body: req, timeoutMs: ASSISTANT_TIMEOUT_MS, signal }, isAssistantResponse);
}

/** GET /api/assistant — whether Ask Livento is connected on this deployment (no AI call). */
export function assistantStatus(signal?: AbortSignal): Promise<AssistantStatusResponse> {
  return call("/api/assistant", { timeoutMs: TIMEOUTS.standard, signal }, isAssistantStatus);
}

/** POST /api/log — anonymous like/skip/save/open (FR-14). Fire-and-forget: never throws, never blocks the UI. */
export function logInteraction(req: LogRequest): void {
  if (!req.anonId || !req.eventId) return;
  call("/api/log", { method: "POST", body: req, timeoutMs: TIMEOUTS.log, keepalive: true }, isAnything).catch(() => {
    // Logging is best-effort by design.
  });
}

// ---------------------------------------------------------------------------
// Livento wallet (Stripe test mode). The token goes in the POST body only.
// ---------------------------------------------------------------------------

/** Wallet routes make several Stripe calls in a row, so they get a longer timeout. */
const WALLET_TIMEOUT_MS = 30_000;

const isWalletSummary = (d: unknown): d is WalletSummary =>
  isObject(d) && d.testMode === true && typeof d.total === "number" && isObject(d.envelopes);
const isWalletToken = (d: unknown): d is WalletCreateResponse => isObject(d) && typeof d.token === "string";
const isWalletUrl = (d: unknown): d is WalletDepositResponse => isObject(d) && typeof d.url === "string";

function walletCall<T>(path: string, body: unknown, validate: (d: unknown) => d is T, signal?: AbortSignal): Promise<T> {
  return call(path, { method: "POST", body, timeoutMs: WALLET_TIMEOUT_MS, signal }, validate);
}

/** POST /api/wallet — creates this browser's wallet (a Stripe test-mode customer). */
export function createWallet(signal?: AbortSignal): Promise<WalletCreateResponse> {
  return walletCall("/api/wallet", {}, isWalletToken, signal);
}

/** POST /api/wallet/summary — balances, history and auto-save per envelope. */
export function walletSummary(token: string, signal?: AbortSignal): Promise<WalletSummary> {
  return walletCall("/api/wallet/summary", { token }, isWalletSummary, signal);
}

/** POST /api/wallet/deposit — Stripe Checkout URL that adds money (and, with autosave, saves the card). */
export function walletDeposit(req: WalletDepositRequest, signal?: AbortSignal): Promise<WalletDepositResponse> {
  return walletCall("/api/wallet/deposit", req, isWalletUrl, signal);
}

/** POST /api/wallet/confirm — after Checkout returns; idempotent. */
export function walletConfirm(req: WalletConfirmRequest, signal?: AbortSignal): Promise<WalletConfirmResponse> {
  return walletCall("/api/wallet/confirm", req, isWalletSummary as (d: unknown) => d is WalletConfirmResponse, signal);
}

/** POST /api/wallet/withdraw — refunds to the card; amount omitted = the whole envelope. */
export function walletWithdraw(req: WalletWithdrawRequest, signal?: AbortSignal): Promise<WalletSummary> {
  return walletCall("/api/wallet/withdraw", req, isWalletSummary, signal);
}

/** POST /api/wallet/autosave — weekly null stops; a number changes an existing schedule's amount. */
export function walletAutosave(req: WalletAutosaveRequest, signal?: AbortSignal): Promise<WalletSummary> {
  return walletCall("/api/wallet/autosave", req, isWalletSummary, signal);
}

/** Stops every auto-save of the wallet (e.g. when Premium is turned off). Money already saved stays. */
export function stopAllAutosaves(token: string, signal?: AbortSignal): Promise<WalletSummary> {
  return walletAutosave({ token, envelopeId: "*", weekly: null }, signal);
}
