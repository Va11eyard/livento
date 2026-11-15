/**
 * Livento shared contract.
 *
 * Every module (API routes, lib helpers, client pages) imports its types from
 * here so API routes, helpers and screens stay compatible. Change a type only if
 * you update every caller in the same change.
 */

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "music",
  "theatre",
  "festivals",
  "comedy",
  "sports",
  "family",
  "cinema",
  "experiences",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  music: "Concerts",
  theatre: "Theatre",
  festivals: "Festivals",
  comedy: "Comedy",
  sports: "Sports",
  family: "Family & theme parks",
  cinema: "Cinema",
  experiences: "Big experiences",
};

export type EventSource = "ticketmaster" | "thesportsdb" | "curated" | "sample" | "web";

export interface Presale {
  name: string;
  start: string; // ISO datetime
  end?: string; // ISO datetime
}

/** One thing a user can go to. Named LiventoEvent to avoid clashing with DOM `Event`. */
export interface LiventoEvent {
  id: string; // stable, prefixed by source: "tm_<id>", "tsdb_<idEvent>", "cur_<slug>", "smp_<slug>", "web_<hash>"
  source: EventSource;
  name: string;
  category: Category;
  genre?: string;
  subGenre?: string;
  date?: string; // ISO date "YYYY-MM-DD"; undefined for undated curated experiences
  time?: string; // "HH:MM" local time when known
  venue?: string;
  city: string;
  state?: string; // US state code, e.g. "IL"
  lat?: number;
  lng?: number;
  distanceMiles?: number; // from the user's city, when computable
  priceMin?: number; // USD, ticket face value as reported by the source
  priceMax?: number; // USD
  currency?: string; // "USD"
  priceNote?: string; // e.g. "Estimate — check the official site"
  onSaleStart?: string; // ISO datetime of the public on-sale, if known
  presales?: Presale[];
  url: string; // official / ticketing page (outbound link)
  image?: string; // the event's own https image (its page's og:image, TheSportsDB thumb, Ticketmaster) or a local /assets path
  imageCredit?: string; // who the image comes from, shown as "Image: <credit>", e.g. "songkick.com", "TheSportsDB"
  attribution?: string; // e.g. "Event data: Ticketmaster"
  tags: string[]; // lowercase tags used for matching: category, genre, sub-genre, attraction names
}

// ---------------------------------------------------------------------------
// Client state (localStorage key "livento:v1")
// ---------------------------------------------------------------------------

export interface Profile {
  version: 1;
  interests: Category[];
  favourites: string[]; // typed artists, teams, shows
  city: string; // e.g. "Chicago"
  stateCode?: string; // e.g. "IL"
  lat?: number;
  lng?: number;
  radiusMiles: number; // how far the user will go without needing a hotel
  monthlyFunBudget: number; // USD per month the user wants to put toward experiences
  hotelPerNight: number; // USD, user's own estimate
  travelPerTrip: number; // USD, user's own estimate for out-of-radius trips
  vacationDaysLeft: number;
  preferredMonths: number[]; // 1-12
  liked: string[]; // event ids
  skipped: string[]; // event ids
  likedTags: string[]; // tags of liked events, used by the scorer
  isSample: boolean; // true when loaded via "Try with a sample profile"
  createdAt: string; // ISO datetime
}

export interface Deposit {
  date: string; // ISO date
  amount: number; // USD, positive = added to the wallet, negative = withdrawn to the card
  kind?: WalletEntryKind; // set on entries synced from the wallet ledger
  ref?: string; // Stripe object id (pi_… / re_…); only entries with a ref count toward the balance
}

/**
 * A goal's envelope in the Livento wallet. Money is held through Stripe (test mode);
 * `deposits` mirror the Stripe ledger and are replaced by syncEnvelopeLedger().
 */
export interface Envelope {
  id: string;
  eventId: string;
  eventName: string;
  eventDate?: string; // ISO date
  target: number; // USD total from the cost plan
  deadline: string; // ISO date the money is needed by (on-sale or event date)
  deposits: Deposit[];
  createdAt: string; // ISO datetime
}

export type PremiumState = "none" | "demo" | "paid";

export interface AppState {
  profile?: Profile;
  envelopes: Envelope[];
  savedEvents: Record<string, LiventoEvent>; // events the user opened/liked/saved, so detail pages work offline
  premium: PremiumState;
  premiumSession?: string; // Stripe Checkout Session id of a test-mode Premium purchase (lets "Turn off" cancel it)
  anonId: string; // random id for anonymous interaction logging (FR-14)
  wallet?: WalletLink; // Livento wallet linked to this browser (no account)
  insights?: InsightsSummary; // spending summary from /insights (never the raw file)
  social?: ProfileSocial; // name, bio, quote and cover for /profile (photos live under PROFILE_MEDIA_KEY)
  telegram?: TelegramLink; // this browser's link to the user's chat with the Livento bot
}

/** The browser's link to its Livento wallet: "<cus id>.<HMAC>", sent only in POST bodies. */
export interface WalletLink {
  token: string;
  createdAt: string; // ISO datetime
}

/** The browser's link to its Telegram chat with the bot: "<chat id>.<HMAC>", sent only in POST bodies. */
export interface TelegramLink {
  token: string;
  name?: string; // Telegram first name
  username?: string; // without the @
  bot?: string; // the bot's username (for "Open chat"), from POST /api/telegram/link
  linkedAt: string; // ISO datetime
}

// ---------------------------------------------------------------------------
// Social profile (/profile). No accounts: saved in this browser only.
// ---------------------------------------------------------------------------

/** Local cover images (public/assets/trail/<id>.webp). */
export const COVER_PRESETS = ["concert", "theatre", "festival", "cinema"] as const;
export type CoverPreset = (typeof COVER_PRESETS)[number];
/** "auto" follows the top interest; "photo" uses the uploaded cover in ProfileMedia. */
export type CoverChoice = "auto" | CoverPreset | "photo";

export interface ProfileQuote {
  text: string;
  source: "curated" | "custom" | "ai";
  index?: number; // position in QUOTES (lib/quotes.ts) when source is "curated"
}

export interface ProfileSocial {
  displayName: string; // "" until the user adds one
  bio: string; // at most PROFILE_LIMITS.bio characters
  quote?: ProfileQuote; // undefined until the user picks one (a curated line is shown)
  cover: CoverChoice;
}

/** Profile photos as JPEG data URLs, stored under PROFILE_MEDIA_KEY so AppState stays small. */
export interface ProfileMedia {
  avatar?: string; // 256×256
  cover?: string; // 1500×500
}

export const PROFILE_LIMITS = { name: 60, bio: 160, quote: 140 } as const;
export const PROFILE_MEDIA_KEY = "livento:profile-media";

// ---------------------------------------------------------------------------
// Cost plan (FR-6, FR-7)
// ---------------------------------------------------------------------------

export type CostLineKey = "ticket" | "fees" | "travel" | "hotel" | "buffer";

export interface CostLine {
  key: CostLineKey;
  label: string; // e.g. "Tickets (2 × $89)"
  amount: number; // USD
  estimate: boolean; // true = show the "estimate" label
  note?: string; // short explanation of where the number came from
}

/** User edits on the event page. Any field left undefined uses the default rule. */
export interface CostOverrides {
  tickets?: number; // quantity, default 1
  ticketPrice?: number; // USD per ticket
  feesPct?: number; // 0-1, default DEFAULT_FEES_PCT
  travel?: number; // USD
  hotelNights?: number;
  hotelPerNight?: number; // USD
  bufferPct?: number; // 0-1, default DEFAULT_BUFFER_PCT
}

export interface PlanResult {
  lines: CostLine[];
  total: number; // USD, rounded to whole dollars
  deadline: string; // ISO date
  deadlineKind: "on-sale" | "event" | "none";
  weeks: number; // >= 1
  weekly: number; // USD per week still needed, rounded up to whole dollars
  envelopeBalance: number; // USD already set aside
}

// ---------------------------------------------------------------------------
// Spend-vs-save comparator (FR-9)
// ---------------------------------------------------------------------------

export interface ComparatorEvent {
  name: string;
  cost: number; // USD total from its plan
  deadline?: string; // ISO date
}

export interface ComparatorInput {
  balance: number; // USD available in envelopes now
  weeklyContribution: number; // USD per week (monthlyFunBudget / 4.33)
  eventA: ComparatorEvent; // the cheaper / sooner one ("go now")
  eventB: ComparatorEvent; // the bigger one ("save for it")
  today?: string; // ISO date, injectable for tests
}

export interface ComparatorResult {
  goNow: {
    remainingAfterA: number; // balance - costA (can be negative)
    shortfallForA: number; // > 0 if the balance doesn't cover A
    weeksToB: number;
    reachBOn: string; // ISO date
    makesBDeadline: boolean | null; // null when B has no deadline
  };
  skip: {
    weeksToB: number;
    reachBOn: string; // ISO date
    makesBDeadline: boolean | null;
  };
}

// ---------------------------------------------------------------------------
// API contract (all JSON)
// ---------------------------------------------------------------------------

// GET /api/events?city=&state=&lat=&lng=&radius=&categories=music,theatre&from=YYYY-MM-DD&to=YYYY-MM-DD&keyword=
// GET /api/events?id=<event id>  → the same shape with one event (404 when unknown)
export interface EventsResponse {
  events: LiventoEvent[];
  source: "ticketmaster" | "sample" | "mixed"; // "sample" when no key / upstream failure
  notice?: string; // human-readable note shown when falling back
  /**
   * Events found by AI web search (source "web"): "cached" = already included,
   * "pending" = some interests aren't searched yet, call GET /api/events/web,
   * "off" (or absent) = not used (AI off, Ticketmaster live, or nothing to search).
   */
  webSearch?: WebSearchState;
}

export type WebSearchState = "cached" | "pending" | "off";

// GET /api/events/web?<same params as /api/events> — runs the AI web search for
// interests not searched yet (or reads the stored results). Up to ~60 s.
export interface WebEventsResponse {
  events: LiventoEvent[]; // source "web" only, upcoming, matching the query
}

// POST /api/recommend
export interface RecommendRequest {
  profile: Profile;
  events: LiventoEvent[];
  /**
   * Categories of the user's last 3 saved goals (envelopes), oldest first.
   * Drives the novelty factor (spec §6). When omitted, the last 3 liked
   * events stand in for saved goals.
   */
  recentGoalCategories?: Category[];
}
export interface RecommendItem {
  eventId: string;
  score: number; // 0-1
  why: string; // one line, <= 120 chars
  reasons: string[]; // short rule reasons, e.g. ["Matches: indie rock", "Within 15 mi"]
}
export interface RecommendResponse {
  items: RecommendItem[]; // top 8, best first
  ranker: "llm" | "rules";
}

// POST /api/plan
export interface PlanRequest {
  event: LiventoEvent;
  profile: Profile;
  envelopeBalance: number;
  overrides?: CostOverrides;
}
export type PlanResponse = PlanResult;

// POST /api/roadmap
export type RoadmapStepKind = "money" | "tickets" | "vacation" | "travel" | "stay" | "day-of";
export interface RoadmapStep {
  date?: string; // ISO date
  title: string;
  detail: string;
  kind: RoadmapStepKind;
  link?: { label: string; url: string };
}
export interface RoadmapRequest {
  event: LiventoEvent;
  profile: Profile;
  plan: PlanResult;
}
export interface RoadmapResponse {
  steps: RoadmapStep[];
  writer: "llm" | "template";
}

// POST /api/insights  (the CSV is read in the browser, sent as text, parsed in
// memory on the server and discarded; only the summary is kept, in the browser)
export interface InsightsRequest {
  csv?: string; // raw CSV text, max 1 MB
  sample?: boolean; // true = use data/sample-statement.csv
}
/** One calendar month of spending (income and transfers left out). */
export interface InsightsMonth {
  month: string; // "YYYY-MM"
  days: number; // days of this month the statement covers; fewer than the month has = partial month
  spendTotal: number; // USD
  count: number; // purchases
  byCategory: Record<string, number>; // USD per spending category
  topMerchants: { name: string; amount: number; count: number }[]; // up to 10 by amount; bills & rent left out
}
export interface InsightsResponse {
  months: InsightsMonth[]; // oldest first, at most 36
  rowsParsed: number;
  classifier: "rules" | "rules+llm";
  isSample: boolean;
  warnings: string[];
}
/** The analysis summary kept in AppState: never the file. Uploads merge by month (the newer copy of a month wins). */
export interface InsightsSummary {
  version: 1;
  source: "sample" | "upload";
  analyzedAt: string; // ISO datetime of the latest analysis merged in
  classifier: "rules" | "rules+llm"; // "rules+llm" if any merged analysis used AI for unknown merchants
  months: InsightsMonth[]; // oldest first, at most 36
}

// POST /api/alerts
export interface AlertSubscribeRequest {
  channel: "email" | "telegram";
  address?: string; // email address; omitted for telegram
  interests: Category[];
  favourites: string[];
  city: string;
  stateCode?: string;
}
export interface AlertSubscribeResponse {
  ok: boolean;
  id?: string;
  message?: string; // shown to the user (e.g. "Alerts are not configured on this deployment")
  telegramStartUrl?: string; // https://t.me/<bot>?start=<id>
  linkId?: string; // with storage: poll POST /api/telegram/link { action: "status", linkId } until linked
}

// POST /api/telegram/link  (the site ↔ Telegram chat link; 503 when the bot isn't configured)
export type TelegramLinkAction = "link" | "picks" | "unlink" | "status";
export interface TelegramLinkRequest {
  action: TelegramLinkAction;
  token?: string; // link (from ?tg_link=), picks, unlink
  initData?: string; // link from inside the Telegram Mini App (instead of token)
  linkId?: string; // status
  profile?: { city: string; stateCode?: string; interests: Category[] }; // picks: the site profile
}
export interface TelegramLinkResponse {
  ok: boolean;
  status?: "pending" | "linked" | "expired"; // action "status"
  token?: string; // link, and status "linked"
  name?: string;
  username?: string;
  bot?: string; // the bot's username
  message?: string; // a short sentence for the user (always set when ok is false)
}

// POST /api/quote  (profile "About my goals")
export interface QuoteRequest {
  goals: string[]; // envelope event names, up to 5
  interests: string[]; // Category keys
  city?: string;
  name?: string;
}
export interface QuoteResponse {
  text: string;
  source: "ai" | "curated"; // "curated" when the AI is off or failed (a line from lib/quotes.ts)
}

// POST /api/checkout
export interface CheckoutRequest {
  plan: "monthly" | "yearly";
}
export interface CheckoutResponse {
  url?: string; // test-mode checkout URL
  demo?: boolean; // true when payments are not configured -> client offers "Demo unlock"
  message?: string;
}

// POST /api/checkout/session — confirm a finished Premium test checkout, or cancel its subscription
export interface CheckoutSessionRequest {
  sessionId: string; // cs_test_… from the success URL
  action: "confirm" | "cancel";
}
export interface CheckoutSessionResponse {
  ok: boolean;
  paid?: boolean; // confirm: the session is complete and paid
  canceled?: boolean; // cancel: the subscription is canceled (or already was)
  message?: string;
}

// Livento wallet (Stripe TEST MODE only). Every route is POST and takes the wallet
// token in the JSON body, never in the URL. Amounts are USD.
// POST /api/wallet            {}                                   → WalletCreateResponse
// POST /api/wallet/summary    WalletTokenRequest                   → WalletSummary
// POST /api/wallet/deposit    WalletDepositRequest                 → WalletDepositResponse (Stripe Checkout URL)
// POST /api/wallet/confirm    WalletConfirmRequest                 → WalletConfirmResponse (summary + confirmed)
// POST /api/wallet/withdraw   WalletWithdrawRequest                → WalletSummary
// POST /api/wallet/autosave   WalletAutosaveRequest                → WalletSummary
export type WalletEntryKind = "deposit" | "autosave" | "withdrawal";
export interface WalletEntry {
  id: string; // Stripe PaymentIntent (pi_…) or Refund (re_…) id
  date: string; // ISO datetime (UTC) the money moved
  amount: number; // USD, positive = added, negative = withdrawn to the card
  kind: WalletEntryKind;
}
export interface WalletAutosave {
  weekly: number; // USD per week
  nextDate: string; // ISO date (UTC) of the next automatic withdrawal
  status: "active" | "failed";
}
export interface WalletEnvelope {
  balance: number; // USD
  eventName?: string; // from the newest payment, for money whose envelope isn't in this browser
  entries: WalletEntry[]; // oldest first
  autosave?: WalletAutosave;
}
export interface WalletSummary {
  testMode: true;
  total: number; // USD across all envelopes
  envelopes: Record<string, WalletEnvelope>; // keyed by envelope id
}
export interface WalletCreateResponse {
  token: string;
}
export interface WalletTokenRequest {
  token: string;
}
export interface WalletDepositRequest {
  token: string;
  envelopeId: string;
  eventName: string;
  amount: number; // USD 1–2000; with autosave this is the weekly amount and the first withdrawal
  target: number; // USD goal; auto-save stops once the envelope reaches it
  autosave?: boolean; // save the card and withdraw `amount` every week
}
export interface WalletDepositResponse {
  url: string; // Stripe Checkout (test mode)
}
export interface WalletConfirmRequest {
  token: string;
  sessionId: string; // cs_… from the success URL
}
export interface WalletConfirmResponse extends WalletSummary {
  confirmed?: { envelopeId: string; amount: number; autosave: boolean }; // the payment that was just confirmed
}
export interface WalletWithdrawRequest {
  token: string;
  envelopeId: string;
  amount?: number; // USD 1–2000; omitted = the whole envelope balance
  requestId?: string; // same id for retries of one withdrawal, so it never refunds twice
}
export interface WalletAutosaveRequest {
  token: string;
  envelopeId: string; // or "*" with weekly null = stop every auto-save
  weekly: number | null; // null stops; a number changes the weekly amount of an existing schedule
}
export const WALLET_MIN_AMOUNT = 1;
export const WALLET_MAX_AMOUNT = 2000;

// POST /api/log  (FR-14, anonymous)
export type InteractionAction = "open" | "like" | "skip" | "save";
export interface LogRequest {
  anonId: string;
  eventId: string;
  action: InteractionAction;
}

// POST /api/assistant  (Ask Livento chat; GET /api/assistant → AssistantStatusResponse)
// The browser sends the conversation (kept in sessionStorage) plus a summary of
// its AppState. Every number in an answer comes from Livento's calculators via
// tools, and every action link is built by the server, never by the model.
export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string; // ≤ 2,000 characters
}
/** The parts of the Profile the helper's calculators use. */
export interface AssistantProfileSummary {
  city: string;
  stateCode?: string;
  lat?: number;
  lng?: number;
  radiusMiles?: number;
  interests: Category[];
  favourites: string[];
  monthlyFunBudget?: number; // USD
  hotelPerNight?: number; // USD
  travelPerTrip?: number; // USD
  vacationDaysLeft?: number;
  preferredMonths?: number[]; // 1-12
  isSample?: boolean;
}
export interface AssistantEnvelope {
  id: string;
  eventId: string;
  eventName: string;
  eventDate?: string; // ISO date
  target: number; // USD
  balance: number; // USD, envelopeBalance()
  deadline: string; // ISO date
}
/** Category monthly averages from AppState.insights (app/insights/plan.ts categoryTotals). */
export interface AssistantSpending {
  source: "sample" | "upload";
  days: number; // days the saved statements cover
  monthlyAverage?: number; // USD
  categories: { name: string; perMonth: number }[]; // largest first
}
export interface AssistantContext {
  today?: string; // the browser's ISO date
  profile?: AssistantProfileSummary;
  envelopes: AssistantEnvelope[];
  walletTotal?: number; // USD across envelopes (totalSetAside)
  spending?: AssistantSpending;
  currentEventId?: string; // when asked from /event/[id] or /roadmap/[id]
}
export interface AssistantRequest {
  messages: AssistantChatMessage[]; // ≤ 20, the last one from the user
  context?: AssistantContext;
}
/** A button under an answer. `href` is "/path" (in-app) or an https:// search link (external). */
export interface AssistantAction {
  label: string;
  href: string;
  external: boolean;
}
export interface AssistantAnswer {
  off?: false;
  text: string; // plain text: sentences and "- " bullets
  actions: AssistantAction[];
  usedTools: string[];
}
/** No ANTHROPIC_API_KEY on this deployment: the UI says so and hides the input. */
export interface AssistantOff {
  off: true;
  message: string;
}
export type AssistantResponse = AssistantAnswer | AssistantOff;
export type AssistantStatusResponse = { off: false } | AssistantOff;

// GET /api/health  (configuration only — never returns key values)
export type IntegrationState = "live" | "sample" | "off" | "test" | "demo";
export interface IntegrationStatus {
  key: "events" | "sports" | "ai" | "storage" | "telegram" | "email" | "payments" | "cron" | "wallet";
  name: string;
  state: IntegrationState;
  detail: string;
}
export interface HealthResponse {
  ok: true;
  integrations: IntegrationStatus[];
  deployment: {
    environment: string; // "production" | "preview" | "development"
    commit?: string; // short SHA
    commitMessage?: string;
    commitUrl?: string;
    branch?: string;
    region?: string;
  };
  checkedAt: string; // ISO datetime
}

// Error shape for every route
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// Cities (lib/cities.ts exports US_CITIES: City[])
// ---------------------------------------------------------------------------

export interface City {
  name: string; // "Chicago"
  state: string; // "IL"
  lat: number;
  lng: number;
}

// Local images for categories and sample events (credits: public/assets/CREDITS.md)
export const CATEGORY_IMAGES: Record<Category, string> = {
  music: "/assets/trail/concert.webp",
  festivals: "/assets/trail/festival.webp",
  theatre: "/assets/trail/theatre.webp",
  comedy: "/assets/trail/theatre.webp",
  cinema: "/assets/trail/cinema.webp",
  sports: "/assets/trail/festival.webp",
  family: "/assets/trail/festival.webp",
  experiences: "/assets/trail/concert.webp",
};

// ---------------------------------------------------------------------------
// Constants shared by UI and server
// ---------------------------------------------------------------------------

export const PRICING = {
  monthly: 4.99,
  yearly: 39,
  currency: "USD",
} as const;

export const DEFAULT_FEES_PCT = 0.15; // labeled "estimated fees"; user can edit
export const DEFAULT_BUFFER_PCT = 0.1; // labeled "buffer"; user can edit
export const WEEKS_PER_MONTH = 4.33;

export const STORAGE_KEY = "livento:v1";
