/**
 * Livento shared contract.
 *
 * Every module (API routes, lib helpers, client pages) imports its types from
 * here so the three parallel workstreams stay compatible. Change a type only if
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

export type EventSource = "ticketmaster" | "curated" | "sample";

export interface Presale {
  name: string;
  start: string; // ISO datetime
  end?: string; // ISO datetime
}

/** One thing a user can go to. Named LiventoEvent to avoid clashing with DOM `Event`. */
export interface LiventoEvent {
  id: string; // stable, prefixed by source: "tm_<id>", "cur_<slug>", "smp_<slug>"
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
  image?: string; // remote image URL from the source (Ticketmaster) or a local /assets path
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
  amount: number; // USD, positive = set aside, negative = withdrawn
}

/** A virtual envelope. Money never leaves the user's own bank; this only tracks it. */
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
  anonId: string; // random id for anonymous interaction logging (FR-14)
}

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
export interface EventsResponse {
  events: LiventoEvent[];
  source: "ticketmaster" | "sample" | "mixed"; // "sample" when no key / upstream failure
  notice?: string; // human-readable note shown when falling back
}

// POST /api/recommend
export interface RecommendRequest {
  profile: Profile;
  events: LiventoEvent[];
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

// POST /api/insights  (CSV is read in the browser and sent as text; never stored)
export interface InsightsGoal {
  envelopeId?: string;
  eventName: string;
  target: number; // USD
}
export interface InsightsRequest {
  csv?: string; // raw CSV text, max 1 MB
  sample?: boolean; // true = use data/sample-statement.csv
  goals: InsightsGoal[];
}
export interface InsightsMonth {
  month: string; // "YYYY-MM"
  spendTotal: number; // USD
  impulseTotal: number; // USD
  byCategory: Record<string, number>; // USD per category
  topMerchants: { name: string; amount: number; count: number }[];
}
export interface InsightsResponse {
  months: InsightsMonth[];
  impulseTotal: number; // USD across all months
  monthlyImpulseAverage: number; // USD
  equivalents: { envelopeId?: string; eventName: string; target: number; coveredPct: number }[];
  rowsParsed: number;
  classifier: "rules" | "rules+llm";
  isSample: boolean;
  warnings: string[];
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

// POST /api/log  (FR-14, anonymous)
export type InteractionAction = "open" | "like" | "skip" | "save";
export interface LogRequest {
  anonId: string;
  eventId: string;
  action: InteractionAction;
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

// Local images for categories and sample events (produced by the landing/assets workstream)
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
