/**
 * Real upcoming events found by Claude's web search (server-only).
 *
 * Claude (`claude-opus-5-5`, effort medium) runs the `web_search_20260209` server
 * tool (at most 4 searches) and answers with a structured list (JSON schema).
 * We fetch nothing ourselves. Every event is validated here and dropped unless
 * it has an https URL whose host appeared in this request's
 * `web_search_tool_result` blocks, a real date inside the searched window and
 * one of the searched categories; repeats (same name + date) are dropped.
 * Prices only when the page or snippet showed one, never invented: without a
 * price the cost plan asks the user to enter it.
 *
 * Store (lib/kv: Upstash Redis when configured, otherwise its per-instance memory):
 * - `webev:v1:city:<city>|<ST>`: one document per city with its upcoming
 *   events (sorted by date, at most 80) and when each category was last
 *   searched. Kept 30 days.
 * - `webev:v1:event:<id>`: each event by id until its date passes (30 days at
 *   most), so /event/[id] and shared links resolve.
 * A searched category stays fresh for 7 days with Redis (the daily cron
 * refreshes the 15 largest cities) and for 12 hours in memory. Only one search
 * per city + categories runs at a time; concurrent callers await the same promise.
 *
 * The request copies lib/llm.ts: lazy client, `fallbacks: "default"` on the
 * `server-side-fallback-2026-07-01` beta with a GA retry on 400, typed SDK
 * errors, one overall deadline. Web search always returns citations, and the
 * API rejects citations next to structured outputs for documents; if it also
 * rejects them here (400), one more attempt asks for plain JSON instead,
 * validated the same way.
 *
 * Gemini backup (lib/gemini.ts; provider choice in lib/llm.ts): when Claude is
 * unavailable or fails for account reasons, Gemini searches with Grounding with
 * Google Search and answers with the same JSON list (JSON schema; plain JSON in
 * the prompt if the schema is refused next to the tool). Same validation, with
 * the allowed hosts taken from the answer's grounding sources: each chunk's
 * title (usually the domain), else its uri's host; a Google grounding redirect
 * is followed (Location header only) just when no domain is given.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { findCity, US_CITIES } from "./cities";
import { DAY_MS, addDays, isoDatePart, isoDateToUTC, todayISO } from "./dates";
import { distanceMiles, isLatLng, type LatLng } from "./geo";
import { isKvConfigured, kvGet, kvIncr, kvSet } from "./kv";
import {
  GeminiError,
  describeGeminiError,
  generateContent,
  geminiConfigured,
  geminiModel,
  geminiSchema,
  geminiText,
  type GeminiGroundingChunk,
  type GeminiResponse,
} from "./gemini";
import { LLM_MODEL, claudeFailedOver, claudeUsable, isClaudeAccountError, isLlmConfigured } from "./llm";
import { CATEGORIES, type Category, type City, type LiventoEvent, type WebSearchState } from "./types";

export const WEB_SEARCH_MODEL = LLM_MODEL;

/** The model that runs the next web search (Claude's, or Gemini's while Claude is unavailable). */
export function webSearchModel(): string {
  return claudeUsable() ? LLM_MODEL : geminiModel();
}
/** Web searches allowed per request (each one is billed). */
export const MAX_WEB_SEARCHES = 4;
/** The 15 largest US cities (lib/cities is ordered by size), refreshed daily by /api/cron/events. */
export const CRON_CITIES: readonly City[] = US_CITIES.slice(0, 15);

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const SEARCH_TIMEOUT_MS = 80_000;
const MAX_TOKENS = 16_000;
const MAX_CONTINUATIONS = 2; // pause_turn resumes per request
const MAX_EVENTS = 12; // per on-demand search
const CRON_MAX_EVENTS = 20; // per daily city refresh
const WINDOW_DAYS = 120;
const CITY_EVENT_CAP = 80;
const MAX_MILES_AWAY = 150;
const CITY_TTL_SECONDS = 30 * 86_400;
const EVENT_TTL_MAX_SECONDS = 30 * 86_400;
const FRESH_MS_REDIS = 7 * DAY_MS;
const FRESH_MS_MEMORY = 12 * 3_600_000;
const CRON_SKIP_MS = 72 * 3_600_000; // cities with events are refreshed every 3 days
const FAILED_RETRY_MS = 2 * 60_000;
const MEMO_MS = 60_000;
const DAILY_SEARCH_CAP = 150; // on-demand searches per day, all visitors together
const IP_HOURLY_SEARCH_CAP = 6; // on-demand searches per visitor IP per hour

/** What the web search looks for. Sports (TheSportsDB) and big experiences (curated) come from elsewhere. */
const CATEGORY_WORDS: Partial<Record<Category, string>> = {
  music: "concerts and live music",
  theatre: "theatre, musicals and plays",
  festivals: "festivals (music, food, arts and culture)",
  comedy: "stand-up comedy shows",
  family: "family shows and kids' events",
  cinema: "film festivals and special screenings",
};
const WEB_CATEGORIES: readonly Category[] = CATEGORIES.filter((c) => CATEGORY_WORDS[c] !== undefined);
const DEFAULT_WEB_CATEGORIES: readonly Category[] = ["music", "theatre", "festivals", "comedy", "family"];

/** Categories the web search covers for these interests (no interests = the default mix). */
export function webCategoriesFor(categories: readonly Category[]): Category[] {
  if (categories.length === 0) return [...DEFAULT_WEB_CATEGORIES];
  return WEB_CATEGORIES.filter((c) => categories.includes(c));
}

export class WebSearchError extends Error {
  constructor(
    readonly kind: "off" | "budget" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

// ---------------------------------------------------------------------------
// Places and small helpers
// ---------------------------------------------------------------------------

interface Place {
  city: string;
  state?: string;
  key: string; // "<city lowercase>|<ST>"
  origin?: LatLng;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function cleanCity(raw: string | undefined): string | undefined {
  const s = tidy((raw ?? "").normalize("NFKC").replace(/[^\p{L}\p{M}\d .'’&-]/gu, " ")).slice(0, 60);
  return /\p{L}{2}/u.test(s) ? s : undefined;
}

function cleanState(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : undefined;
}

function resolvePlace(cityRaw?: string, stateRaw?: string, lat?: number, lng?: number): Place | null {
  const city = cleanCity(cityRaw);
  if (!city) return null;
  const state = cleanState(stateRaw);
  const known = findCity(city, state);
  const name = known?.name ?? city;
  const st = known?.state ?? state;
  const point = { lat, lng };
  const origin = known ? { lat: known.lat, lng: known.lng } : isLatLng(point) ? point : undefined;
  return { city: name, ...(st ? { state: st } : {}), key: `${name.toLowerCase()}|${st ?? ""}`, origin };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function httpsUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return undefined;
    const s = u.toString();
    return s.length <= 2_000 ? s : undefined;
  } catch {
    return undefined;
  }
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function cleanTime(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  let m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  m = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s?m\.?$/.exec(s);
  if (!m) return undefined;
  const hour = (Number(m[1]) % 12) + (m[3] === "p" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${m[2] ?? "00"}`;
}

function cleanPrice(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5_000 ? Math.round(v * 100) / 100 : undefined;
}

function byDate(a: LiventoEvent, b: LiventoEvent): number {
  return (
    (a.date ?? "").localeCompare(b.date ?? "") ||
    (a.time ?? "").localeCompare(b.time ?? "") ||
    a.name.localeCompare(b.name)
  );
}

function dedupe(events: LiventoEvent[]): LiventoEvent[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  return events.filter((e) => {
    const key = `${norm(e.name)}|${e.date}`;
    if (ids.has(e.id) || keys.has(key)) return false;
    ids.add(e.id);
    keys.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Store: one document per city + each event by id (lib/kv), small local memo
// ---------------------------------------------------------------------------

interface Coverage {
  at: number; // epoch ms of the search
  from: string; // searched window, YYYY-MM-DD
  to: string;
}

interface CityDoc {
  v: 1;
  city: string;
  state?: string;
  coverage: Partial<Record<Category, Coverage>>;
  events: LiventoEvent[]; // upcoming, sorted by date
}

interface Inflight {
  categories: readonly Category[];
  promise: Promise<CityDoc>;
}

interface WebMemory {
  memo: Map<string, { doc: CityDoc | null; until: number }>;
  inflight: Map<string, Inflight[]>;
  writes: Map<string, Promise<unknown>>;
  failedUntil: Map<string, number>;
}

// On globalThis so dev reloads keep in-flight searches and the memo.
const mem: WebMemory = ((globalThis as unknown as { __liventoWebEvents?: WebMemory }).__liventoWebEvents ??= {
  memo: new Map(),
  inflight: new Map(),
  writes: new Map(),
  failedUntil: new Map(),
});

const cityKey = (key: string) => `webev:v1:city:${key}`;
const eventKey = (id: string) => `webev:v1:event:${id}`;
const freshMs = () => (isKvConfigured() ? FRESH_MS_REDIS : FRESH_MS_MEMORY);

function asCityDoc(raw: unknown): CityDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<CityDoc>;
  if (d.v !== 1 || !Array.isArray(d.events) || !d.coverage || typeof d.coverage !== "object") return null;
  const events = d.events.filter(
    (e): e is LiventoEvent =>
      !!e && typeof e === "object" && typeof e.id === "string" && e.source === "web" && typeof e.date === "string",
  );
  return { v: 1, city: String(d.city ?? ""), ...(d.state ? { state: d.state } : {}), coverage: d.coverage, events };
}

function remember(key: string, doc: CityDoc | null): void {
  const now = Date.now();
  if (mem.memo.size > 300) for (const [k, v] of mem.memo) if (v.until <= now) mem.memo.delete(k);
  mem.memo.set(key, { doc, until: now + MEMO_MS });
}

async function readCity(key: string): Promise<CityDoc | null> {
  const hit = mem.memo.get(key);
  if (hit && hit.until > Date.now()) return hit.doc;
  try {
    const doc = asCityDoc(await kvGet<unknown>(cityKey(key)));
    remember(key, doc);
    return doc;
  } catch {
    console.warn("[web-events] storage read failed");
    return null;
  }
}

/** Categories that still need a search: never searched, stale, or searched for another window. */
function missing(doc: CityDoc | null, wanted: readonly Category[], from: string): Category[] {
  const now = Date.now();
  const ttl = freshMs();
  return wanted.filter((c) => {
    const cov = doc?.coverage[c];
    return !cov || now - cov.at >= ttl || from < cov.from || from > cov.to;
  });
}

/** Runs one write at a time per city on this instance (read-modify-write of the city document). */
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mem.writes.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  mem.writes.set(key, tail);
  void tail.then(() => {
    if (mem.writes.get(key) === tail) mem.writes.delete(key);
  });
  return next;
}

function eventTtlSeconds(e: LiventoEvent, now: number): number {
  const end = isoDateToUTC(addDays(e.date ?? todayISO(), 2)) ?? now;
  return Math.min(EVENT_TTL_MAX_SECONDS, Math.max(3_600, Math.round((end - now) / 1000)));
}

/** Saves a search: it replaces that city's events for the searched categories and window; the rest stays. */
function saveToCity(
  place: Place,
  categories: readonly Category[],
  window: { from: string; to: string },
  found: LiventoEvent[],
): Promise<CityDoc> {
  return serialize(place.key, async () => {
    mem.memo.delete(place.key);
    const prev = await readCity(place.key);
    const oldest = addDays(todayISO(), -1);
    const kept = (prev?.events ?? []).filter(
      (e) =>
        (e.date ?? "") >= oldest &&
        !(categories.includes(e.category) && (e.date ?? "") >= window.from && (e.date ?? "") <= window.to),
    );
    const at = Date.now();
    const coverage: Partial<Record<Category, Coverage>> = { ...(prev?.coverage ?? {}) };
    for (const c of categories) coverage[c] = { at, from: window.from, to: window.to };
    const doc: CityDoc = {
      v: 1,
      city: place.city,
      ...(place.state ? { state: place.state } : {}),
      coverage,
      events: dedupe([...found, ...kept]).sort(byDate).slice(0, CITY_EVENT_CAP),
    };
    try {
      await Promise.all([
        kvSet(cityKey(place.key), doc, CITY_TTL_SECONDS),
        ...found.map((e) => kvSet(eventKey(e.id), e, eventTtlSeconds(e, at))),
      ]);
    } catch {
      console.warn("[web-events] storage write failed");
    }
    remember(place.key, doc);
    return doc;
  });
}

function findRunning(key: string, need: readonly Category[]): Promise<CityDoc> | undefined {
  return (mem.inflight.get(key) ?? []).find((f) => need.every((c) => f.categories.includes(c)))?.promise;
}

/** Starts a search and registers it before the first await, so concurrent callers can join it. */
function startSearch(
  place: Place,
  categories: readonly Category[],
  from: string,
  maxEvents: number,
  before?: () => Promise<void>,
): Promise<CityDoc> {
  const entry: Inflight = {
    categories,
    promise: (async () => {
      await before?.();
      const window = { from: addDays(from, -1), to: addDays(from, WINDOW_DAYS) }; // a day of slack for time zones
      const found = await runSearch({ place, categories, from, window, maxEvents });
      return saveToCity(place, categories, window, found);
    })(),
  };
  mem.inflight.set(place.key, [...(mem.inflight.get(place.key) ?? []), entry]);
  entry.promise
    .finally(() => {
      const rest = (mem.inflight.get(place.key) ?? []).filter((f) => f !== entry);
      if (rest.length) mem.inflight.set(place.key, rest);
      else mem.inflight.delete(place.key);
    })
    .catch(() => undefined);
  return entry.promise;
}

/** Counts an on-demand search against the daily and per-IP caps; false when over. Fails open on storage errors. */
async function takeBudget(ip?: string): Promise<boolean> {
  try {
    if ((await kvIncr(`webev:budget:${todayISO()}`, 2 * 86_400)) > DAILY_SEARCH_CAP) return false;
    if (ip && ip !== "unknown") {
      const hour = Math.floor(Date.now() / 3_600_000);
      if ((await kvIncr(`webev:budget:ip:${ip}:${hour}`, 3_600)) > IP_HOURLY_SEARCH_CAP) return false;
    }
  } catch {
    // storage hiccup: the route's rate limit still applies
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WebEventsQuery {
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  categories: Category[];
  from?: string;
  to?: string;
}

interface Plan {
  place: Place;
  categories: Category[];
  from: string;
  to: string;
}

function planFor(q: WebEventsQuery): Plan | null {
  if (!isLlmConfigured()) return null;
  const place = resolvePlace(q.city, q.state, q.lat, q.lng);
  const categories = webCategoriesFor(q.categories);
  if (!place || categories.length === 0) return null;
  const today = todayISO();
  const fromRaw = isoDatePart(q.from);
  const from = fromRaw && fromRaw > today ? fromRaw : today;
  const toRaw = isoDatePart(q.to);
  const to = toRaw && toRaw >= from ? toRaw : addDays(from, 365);
  return { place, categories, from, to };
}

function eventsFor(doc: CityDoc | null, plan: Plan): LiventoEvent[] {
  return (doc?.events ?? []).filter(
    (e) => e.date !== undefined && e.date >= plan.from && e.date <= plan.to && plan.categories.includes(e.category),
  );
}

/**
 * Fast and read-only (used by GET /api/events): stored events for the query and
 * whether a search is still needed ("pending") or the web search isn't used ("off").
 */
export async function cachedWebEvents(q: WebEventsQuery): Promise<{ events: LiventoEvent[]; state: WebSearchState }> {
  const plan = planFor(q);
  if (!plan) return { events: [], state: "off" };
  const doc = await readCity(plan.place.key);
  return { events: eventsFor(doc, plan), state: missing(doc, plan.categories, plan.from).length ? "pending" : "cached" };
}

/**
 * Real upcoming events near the city for the query (at most ~12 new per search):
 * reads the store, runs or joins the web search for categories not searched yet,
 * saves the result. Throws WebSearchError ("off" | "budget" | "failed").
 */
export async function searchWebEvents(q: WebEventsQuery, opts: { ip?: string } = {}): Promise<LiventoEvent[]> {
  if (!isLlmConfigured()) throw new WebSearchError("off", "AI web search is off");
  const plan = planFor(q);
  if (!plan) return [];
  const doc = await readCity(plan.place.key);
  const need = missing(doc, plan.categories, plan.from);
  if (need.length === 0) return eventsFor(doc, plan);

  const failKey = `${plan.place.key}|${need.join(",")}`;
  const promise =
    findRunning(plan.place.key, need) ??
    startSearch(plan.place, need, plan.from, MAX_EVENTS, async () => {
      if ((mem.failedUntil.get(failKey) ?? 0) > Date.now()) {
        throw new WebSearchError("failed", "The last web search for this city failed moments ago");
      }
      if (!(await takeBudget(opts.ip))) throw new WebSearchError("budget", "The web search limit is reached for now");
    });
  try {
    return eventsFor(await promise, plan);
  } catch (err) {
    const guarded = (mem.failedUntil.get(failKey) ?? 0) > Date.now();
    if (err instanceof WebSearchError && err.kind === "failed" && !guarded) {
      mem.failedUntil.set(failKey, Date.now() + FAILED_RETRY_MS);
    }
    throw err;
  }
}

/** Daily refresh of one city for the default categories (cron). Skips cities refreshed with events in the last 3 days. */
export async function refreshCityWebEvents(
  cityName: string,
  state?: string,
): Promise<{ city: string; status: "refreshed" | "skipped"; events: number }> {
  if (!isLlmConfigured()) throw new WebSearchError("off", "AI web search is off");
  const place = resolvePlace(cityName, state);
  if (!place) throw new WebSearchError("failed", "Unknown city");
  const label = [place.city, place.state].filter(Boolean).join(", ");
  const doc = await readCity(place.key);
  const now = Date.now();
  const recent = DEFAULT_WEB_CATEGORIES.every((c) => {
    const cov = doc?.coverage[c];
    return cov !== undefined && now - cov.at < CRON_SKIP_MS;
  });
  // An empty result doesn't count as fresh: try again on the next run.
  if (recent && (doc?.events.length ?? 0) > 0) return { city: label, status: "skipped", events: doc?.events.length ?? 0 };
  const updated = await (findRunning(place.key, DEFAULT_WEB_CATEGORIES) ??
    startSearch(place, DEFAULT_WEB_CATEGORIES, todayISO(), CRON_MAX_EVENTS));
  return { city: label, status: "refreshed", events: updated.events.length };
}

const WEB_ID = /^web_[a-f0-9]{16}$/;

export function isWebEventId(id: string): boolean {
  return WEB_ID.test(id);
}

/** A stored web event by id (until its date passes), or null. */
export async function getWebEventById(id: string): Promise<LiventoEvent | null> {
  if (!isWebEventId(id)) return null;
  try {
    const e = await kvGet<LiventoEvent>(eventKey(id));
    return e && e.id === id && e.source === "web" ? e : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The Claude request
// ---------------------------------------------------------------------------

const WebEventItemSchema = z.object({
  name: z.string().describe("Event name as listed"),
  category: z.enum(CATEGORIES).describe("One of the requested category keys"),
  date: z.string().describe("Event date as YYYY-MM-DD"),
  time: z.string().optional().describe("Local start time as 24-hour HH:MM, only if listed"),
  venue: z.string().optional().describe("Venue name, if listed"),
  city: z.string().describe("City of the venue"),
  state: z.string().optional().describe("Two-letter US state code of the venue"),
  url: z.string().describe("https URL of the search-result page that lists this event"),
  priceMin: z.number().optional().describe("Lowest ticket price in USD, only if the page or snippet shows it"),
  priceMax: z.number().optional().describe("Highest ticket price in USD, only if the page or snippet shows it"),
  sourceTitle: z.string().describe("Title of that search-result page"),
});

const WebEventsOutputSchema = z.object({ events: z.array(WebEventItemSchema) });

const INTRO =
  "You find real upcoming live events in US cities for Livento, an app that helps people plan and save for live experiences.";

const RULES = [
  "- Never invent or guess events, dates, times, venues, prices or URLs. Leave an optional field out when the page doesn't show it; leave the event out when its date or page is unclear.",
  "- Only events in or near the requested city (its metro area), between the requested dates, in the requested categories. Use exactly one of the given category keys per event.",
  "- priceMin and priceMax: only when the page or snippet shows a ticket price in US dollars (0 only when it says the event is free). Never estimate a price.",
  "- time: the local start time as 24-hour HH:MM, only when listed.",
  "- sourceTitle: the title of the search result the event came from.",
  "- Prefer a varied mix across the requested categories, soonest first. Return an empty list when nothing qualifies.",
];

const SYSTEM = [
  INTRO,
  "Use web_search for a few targeted searches (venue calendars, promoter and ticketing pages, city event guides and 'things to do this month' lists). Search snippets often lack dates: then use web_fetch on one or two of the most promising listing pages from the results to read the actual dates, and build the list from what those pages show.",
  "Rules:",
  "- Include an event only if a page you saw in this turn (a search result or a page you fetched) shows it with a specific date. url: the https URL of that page (use the listing page's URL when you read the event there).",
  ...RULES,
].join("\n");

/** The same task and rules for Gemini, which searches with Google Search (no page fetch). */
const GEMINI_SYSTEM = [
  INTRO,
  "Use Google Search for a few targeted searches (venue calendars, promoter and ticketing pages, city event guides and 'things to do this month' lists), and build the list from what the results show.",
  "Rules:",
  "- Include an event only if a search result you saw in this turn shows it with a specific date. url: the https URL of that result page (the page itself, never a Google or redirect link).",
  ...RULES,
].join("\n");

const PLAIN_JSON_RULE =
  'Answer with only a JSON object {"events": [...]}. Each event has name, category, date (YYYY-MM-DD), optional time (HH:MM), optional venue, city, optional state (2-letter code), url, optional priceMin and priceMax (USD) and sourceTitle. No other text.';

interface SearchInput {
  place: Place;
  categories: readonly Category[];
  from: string; // first day to search (today or later)
  window: { from: string; to: string }; // accepted dates (one day of slack before `from`)
  maxEvents: number;
}

function userPrompt(input: SearchInput, plainJson: boolean): string {
  const lines = [
    "Find real upcoming events.",
    `City: ${[input.place.city, input.place.state].filter(Boolean).join(", ")} (United States)`,
    `Dates: ${input.from} to ${input.window.to} (today is ${todayISO()})`,
    "Categories (key: what to look for):",
    ...input.categories.map((c) => `- ${c}: ${CATEGORY_WORDS[c] ?? c}`),
    `Return at most ${input.maxEvents} events.`,
  ];
  if (plainJson) lines.push(PLAIN_JSON_RULE);
  return lines.join("\n");
}

/** Reads one or two listing pages from the search results (it can only open URLs already in the conversation). */
const WEB_FETCH_TOOL = {
  type: "web_fetch_20260209" as const,
  name: "web_fetch" as const,
  max_uses: 2,
  max_content_tokens: 12_000,
};

function webSearchTool(place: Place) {
  return {
    type: "web_search_20260209" as const,
    name: "web_search" as const,
    max_uses: MAX_WEB_SEARCHES,
    user_location: {
      type: "approximate" as const,
      city: place.city,
      ...(place.state ? { region: place.state } : {}),
      country: "US",
    },
  };
}

let client: { apiKey: string; baseURL: string; sdk: Anthropic } | undefined;
let betaFallbacksRejected = false;
let jsonFormatRejected = false;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  // A new client when the key (or the test-only ANTHROPIC_BASE_URL) changes, e.g. after a dev env reload.
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() ?? "";
  if (!client || client.apiKey !== apiKey || client.baseURL !== baseURL) {
    client = { apiKey, baseURL, sdk: new Anthropic({ apiKey, maxRetries: 1 }) };
  }
  return client.sdk;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name} ${err.status ?? ""}`.trim();
  if (err instanceof Error) return err.name;
  return "unknown error";
}

/** beta = fallbacks + JSON schema; ga = JSON schema; text = plain JSON asked in the prompt. */
type Mode = "beta" | "ga" | "text";
const MODES: readonly Mode[] = ["beta", "ga", "text"];

type AnyBlock = Anthropic.Beta.BetaContentBlock | Anthropic.ContentBlock;

interface Turn {
  text: string;
  stopReason: string | null;
  hosts: Set<string>; // hosts of every URL in this request's web_search_tool_result blocks
  webSearches: number;
  inputTokens: number;
  outputTokens: number;
}

function absorb(
  turn: Turn,
  content: AnyBlock[],
  usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests: number } | null },
): void {
  for (const block of content) {
    // Pages read with web_fetch count as seen too (web_fetch only opens URLs from the search results).
    if (block.type === "web_fetch_tool_result") {
      const url = (block as { content?: { url?: unknown } }).content?.url;
      const host = typeof url === "string" ? hostOf(url) : null;
      if (host) turn.hosts.add(host);
      continue;
    }
    // A failed search returns an error object instead of a list: nothing to collect.
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      const host = hostOf(result.url);
      if (host) turn.hosts.add(host);
    }
  }
  turn.inputTokens += usage.input_tokens;
  turn.outputTokens += usage.output_tokens;
  turn.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
}

/** The answer: the text blocks after the last tool, result or fallback block. */
function finalText(content: AnyBlock[]): string {
  let start = 0;
  content.forEach((block, i) => {
    if (block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking") start = i + 1;
  });
  const text = (blocks: AnyBlock[]) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  const tail = text(content.slice(start));
  return tail.trim() ? tail : text(content);
}

async function converse(
  anthropic: Anthropic,
  mode: Mode,
  input: SearchInput,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<Turn> {
  const turn: Turn = { text: "", stopReason: null, hosts: new Set(), webSearches: 0, inputTokens: 0, outputTokens: 0 };
  const user = userPrompt(input, mode === "text");
  const tool = webSearchTool(input.place);
  const options = () => ({ timeout: Math.max(1_000, deadlineAt - Date.now()), signal });
  let container: string | undefined;

  if (mode === "beta") {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
    for (let resumes = 0; ; resumes++) {
      const msg = await anthropic.beta.messages.create(
        {
          model: LLM_MODEL,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: SYSTEM,
          messages,
          tools: [tool, WEB_FETCH_TOOL],
          output_config: { effort: "medium", format: betaZodOutputFormat(WebEventsOutputSchema) },
          ...(container ? { container } : {}),
        },
        options(),
      );
      absorb(turn, msg.content, msg.usage);
      container = msg.container?.id ?? container;
      if (msg.stop_reason === "pause_turn" && resumes < MAX_CONTINUATIONS) {
        // Send the paused turn back unchanged; the server continues it.
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      turn.stopReason = msg.stop_reason;
      turn.text = finalText(msg.content);
      return turn;
    }
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
  for (let resumes = 0; ; resumes++) {
    const msg = await anthropic.messages.create(
      {
        model: LLM_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages,
        tools: [tool, WEB_FETCH_TOOL],
        output_config:
          mode === "ga" ? { effort: "medium", format: zodOutputFormat(WebEventsOutputSchema) } : { effort: "medium" },
        ...(container ? { container } : {}),
      },
      options(),
    );
    absorb(turn, msg.content, msg.usage);
    container = msg.container?.id ?? container;
    if (msg.stop_reason === "pause_turn" && resumes < MAX_CONTINUATIONS) {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    turn.stopReason = msg.stop_reason;
    turn.text = finalText(msg.content);
    return turn;
  }
}

function parseEvents(text: string): unknown[] | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let data = tryParse(text.trim());
  if (data === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) data = tryParse(text.slice(start, end + 1));
  }
  const parsed = z.object({ events: z.array(z.unknown()) }).safeParse(data);
  return parsed.success ? parsed.data.events : null;
}

interface Drops {
  invalid: number;
  category: number;
  date: number;
  url: number;
  far: number;
  repeat: number;
}

/** The host was seen, or (subdomains: Gemini's sources are domains) it sits under a seen domain. */
function hostAllowed(host: string, hosts: Set<string>, subdomains: boolean): boolean {
  if (hosts.has(host)) return true;
  if (!subdomains) return false;
  for (let i = host.indexOf("."); i >= 0; i = host.indexOf(".", i + 1)) {
    const parent = host.slice(i + 1);
    if (parent.includes(".") && hosts.has(parent)) return true;
  }
  return false;
}

/** Keeps only events that pass every check; see the file comment. */
function validateEvents(
  items: unknown[],
  input: SearchInput,
  hosts: Set<string>,
  subdomains = false,
): { events: LiventoEvent[]; drops: Drops } {
  const drops: Drops = { invalid: 0, category: 0, date: 0, url: 0, far: 0, repeat: 0 };
  const allowed = new Set(input.categories);
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  const out: LiventoEvent[] = [];

  for (const raw of items) {
    const parsed = WebEventItemSchema.safeParse(raw);
    const name = parsed.success ? tidy(parsed.data.name).slice(0, 200) : "";
    if (!parsed.success || name.length < 2) {
      drops.invalid++;
      continue;
    }
    const item = parsed.data;
    if (!allowed.has(item.category)) {
      drops.category++;
      continue;
    }
    const date = item.date.trim();
    if (isoDatePart(date) !== date || date < input.window.from || date > input.window.to) {
      drops.date++;
      continue;
    }
    const url = httpsUrl(item.url);
    const host = url ? hostOf(url) : undefined;
    if (!url || !host || !hostAllowed(host, hosts, subdomains)) {
      drops.url++;
      continue;
    }
    const city = cleanCity(item.city) ?? input.place.city;
    const state = cleanState(item.state) ?? (norm(city) === norm(input.place.city) ? input.place.state : undefined);
    const known = findCity(city, state);
    if (known && input.place.origin && distanceMiles(input.place.origin, known) > MAX_MILES_AWAY) {
      drops.far++;
      continue;
    }
    const nameKey = norm(name);
    if (seen.has(`${nameKey}|${date}`)) {
      drops.repeat++;
      continue;
    }
    // id from url + date (+ the searched city, so one tour page can't overwrite another city's
    // stored copy); a second event on the same page and date also hashes its name.
    const scope = `${url}|${date}|${input.place.key}`;
    let id = `web_${shortHash(scope)}`;
    if (ids.has(id) && ids.get(id) !== nameKey) id = `web_${shortHash(`${scope}|${nameKey}`)}`;
    if (ids.has(id)) {
      drops.repeat++;
      continue;
    }
    seen.add(`${nameKey}|${date}`);
    ids.set(id, nameKey);

    let priceMin = cleanPrice(item.priceMin);
    let priceMax = cleanPrice(item.priceMax);
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
    const priced = priceMin !== undefined || priceMax !== undefined;
    const time = cleanTime(item.time);
    const venue = item.venue ? tidy(item.venue).slice(0, 160) : "";
    const domain = host.slice(0, 160);

    out.push({
      id,
      source: "web",
      name,
      category: item.category,
      date,
      ...(time ? { time } : {}),
      ...(venue ? { venue } : {}),
      city,
      ...(state ? { state } : {}),
      ...(priceMin !== undefined ? { priceMin } : {}),
      ...(priceMax !== undefined ? { priceMax } : {}),
      ...(priced
        ? { currency: "USD", priceNote: `Price seen on ${domain} by AI web search — an estimate, check the official page` }
        : {}),
      url,
      attribution: `Found by web search · ${domain}`,
      tags: [item.category],
    });
  }
  out.sort(byDate);
  return { events: out.slice(0, input.maxEvents), drops };
}

function dropSummary(drops: Drops): string {
  return Object.entries(drops)
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${why} ${n}`)
    .join(", ");
}

/** One web search within SEARCH_TIMEOUT_MS: Claude first, Gemini when Claude is unavailable. Validated events or WebSearchError. */
async function runSearch(input: SearchInput): Promise<LiventoEvent[]> {
  const started = Date.now();
  const deadlineAt = started + SEARCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const anthropic = claudeUsable() ? getClient() : null;
  if (anthropic) {
    const events = await searchWithClaude(anthropic, input, started, deadlineAt, signal);
    if (events) return events; // null: Claude failed for account reasons and Gemini takes this search
  }
  if (!geminiConfigured()) throw new WebSearchError("off", "AI web search is off");
  return searchWithGemini(input, started, deadlineAt, signal);
}

/** The Claude request (plus pause_turn resumes); null when Claude is unavailable and Gemini should search instead. */
async function searchWithClaude(
  anthropic: Anthropic,
  input: SearchInput,
  started: number,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<LiventoEvent[] | null> {
  const rejected = new Set<Mode>();

  for (const mode of MODES.slice(jsonFormatRejected ? 2 : betaFallbacksRejected ? 1 : 0)) {
    let turn: Turn;
    try {
      turn = await converse(anthropic, mode, input, deadlineAt, signal);
    } catch (err) {
      if (claudeFailedOver(err, "web-events")) return null;
      if (err instanceof Anthropic.BadRequestError && mode !== "text" && !isClaudeAccountError(err)) {
        console.warn(`[web-events] ${mode} request rejected (400); trying the next request shape`);
        rejected.add(mode);
        continue;
      }
      console.warn(`[web-events] search failed: ${describeError(err)}`);
      throw new WebSearchError("failed", "The web search did not finish");
    }
    // A shape worked where the previous one 400'd: skip the rejected shape from now on.
    if (mode === "ga" && rejected.has("beta")) betaFallbacksRejected = true;
    if (mode === "text" && rejected.has("ga")) jsonFormatRejected = true;

    const items = turn.stopReason === "end_turn" ? parseEvents(turn.text) : null;
    if (!items) {
      console.warn(`[web-events] no usable answer (stop: ${turn.stopReason ?? "none"})`);
      throw new WebSearchError("failed", "The web search returned no usable answer");
    }
    const { events, drops } = validateEvents(items, input, turn.hosts);
    const dropped = dropSummary(drops);
    console.info(
      `[web-events] ${mode}: kept ${events.length} of ${items.length}${dropped ? ` (dropped: ${dropped})` : ""}; ` +
        `${turn.webSearches} web searches, ${turn.hosts.size} result hosts, ` +
        `${turn.inputTokens} in / ${turn.outputTokens} out tokens, ${Date.now() - started} ms`,
    );
    return events;
  }
  throw new WebSearchError("failed", "The web search request was rejected");
}

// ---------------------------------------------------------------------------
// The Gemini request (Grounding with Google Search)
// ---------------------------------------------------------------------------

/** Google's grounding redirect host: the real page is in its Location header. */
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_REDIRECTS = 12; // followed per search, only when needed
let geminiJsonRejected = false;

/** A grounding source's title as a host ("ticketmaster.com"), or undefined when it's a page title. */
function domainOf(title: string | undefined): string | undefined {
  const s = (title ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return DOMAIN.test(s) ? s : undefined;
}

const isRedirect = (url: string | undefined) => !!url && hostOf(url) === REDIRECT_HOST;

/** Follows Google grounding redirects (Location header only: the page itself isn't fetched), at most MAX_REDIRECTS. */
function redirectResolver(signal: AbortSignal): (uri: string) => Promise<string | undefined> {
  const seen = new Map<string, Promise<string | undefined>>();
  return (uri) => {
    const url = httpsUrl(uri);
    if (!url || !isRedirect(url)) return Promise.resolve(undefined);
    let found = seen.get(url);
    if (!found) {
      if (seen.size >= MAX_REDIRECTS) return Promise.resolve(undefined);
      found = fetch(url, {
        method: "HEAD",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      })
        .then((res) => {
          const location = res.headers.get("location");
          return location ? httpsUrl(new URL(location, url).toString()) : undefined;
        })
        .catch(() => undefined);
      seen.set(url, found);
    }
    return found;
  };
}

/** Hosts of the answer's grounding sources: the title (usually the domain), else the uri's host, else the redirect's target. */
async function groundingHosts(
  chunks: GeminiGroundingChunk[],
  resolve: (uri: string) => Promise<string | undefined>,
): Promise<Set<string>> {
  const hosts = new Set<string>();
  const unresolved: string[] = [];
  for (const chunk of chunks) {
    const fromTitle = domainOf(chunk.web?.title);
    const uri = chunk.web?.uri;
    const fromUri = uri && !isRedirect(uri) ? hostOf(uri) : undefined;
    if (fromTitle) hosts.add(fromTitle);
    else if (fromUri) hosts.add(fromUri);
    else if (uri) unresolved.push(uri);
  }
  for (const target of await Promise.all(unresolved.map(resolve))) {
    const host = target ? hostOf(target) : undefined;
    if (host) hosts.add(host);
  }
  return hosts;
}

/** An event whose url is a grounding redirect gets the page it points to (only those are followed). */
async function resolveEventUrls(items: unknown[], resolve: (uri: string) => Promise<string | undefined>): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      const event = item as { url?: unknown } | null;
      if (!event || typeof event !== "object" || typeof event.url !== "string" || !isRedirect(event.url)) return;
      const target = await resolve(event.url);
      if (target) event.url = target;
    }),
  );
}

/** One grounded Gemini request; validated events or WebSearchError. */
async function searchWithGemini(
  input: SearchInput,
  started: number,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<LiventoEvent[]> {
  // JSON schema next to Google Search is a Gemini 3+ feature: if it's refused (400), ask for plain JSON instead.
  for (const structured of geminiJsonRejected ? [false] : [true, false]) {
    let res: GeminiResponse;
    try {
      res = await generateContent(
        {
          systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: userPrompt(input, !structured) }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: {
            maxOutputTokens: MAX_TOKENS,
            ...(structured
              ? { responseMimeType: "application/json", responseJsonSchema: geminiSchema(WebEventsOutputSchema) }
              : {}),
          },
        },
        { timeoutMs: Math.max(1_000, deadlineAt - Date.now()), signal },
      );
    } catch (err) {
      if (structured && err instanceof GeminiError && err.kind === "bad_request") {
        console.warn(`[web-events] gemini: JSON schema request rejected (${describeGeminiError(err)}); asking for plain JSON`);
        continue;
      }
      console.warn(`[web-events] gemini search failed: ${describeGeminiError(err)}`);
      throw new WebSearchError("failed", "The web search did not finish");
    }
    if (!structured) geminiJsonRejected = true; // plain JSON worked where the schema was refused

    const candidate = res.candidates?.[0];
    const items = parseEvents(geminiText(res));
    if (!items) {
      const why = res.promptFeedback?.blockReason ?? candidate?.finishReason ?? "none";
      console.warn(`[web-events] gemini: no usable answer (finish: ${why})`);
      throw new WebSearchError("failed", "The web search returned no usable answer");
    }
    const resolve = redirectResolver(signal);
    const hosts = await groundingHosts(candidate?.groundingMetadata?.groundingChunks ?? [], resolve);
    await resolveEventUrls(items, resolve);
    const { events, drops } = validateEvents(items, input, hosts, true);
    const dropped = dropSummary(drops);
    const usage = res.usageMetadata;
    console.info(
      `[web-events] gemini: kept ${events.length} of ${items.length}${dropped ? ` (dropped: ${dropped})` : ""}; ` +
        `${candidate?.groundingMetadata?.webSearchQueries?.length ?? 0} web searches, ${hosts.size} source hosts, ` +
        `${usage?.promptTokenCount ?? 0} in / ${(usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0)} out tokens, ` +
        `${Date.now() - started} ms`,
    );
    return events;
  }
  throw new WebSearchError("failed", "The web search request was rejected");
}

// ---------------------------------------------------------------------------
// Operator import: real events researched by hand (each with its own official page)
// ---------------------------------------------------------------------------

const ImportItemSchema = z.object({
  name: z.string().min(2).max(200),
  category: z.enum(CATEGORIES),
  date: z.string(),
  time: z.string().optional(),
  venue: z.string().max(160).optional(),
  city: z.string().min(2).max(80),
  state: z.string().max(2).optional(),
  url: z.string().max(600),
  image: z.string().max(800).optional(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
});

export interface ImportResult {
  added: number;
  skipped: number;
  cities: Record<string, number>;
}

/**
 * Adds researched events to the shared events database (same store as web search), merged
 * into each city's document without touching its search coverage. Each event needs its own
 * https page; `image` (https) is that page's own picture. Dates must be today to +365 days.
 */
export async function importWebEvents(items: unknown[]): Promise<ImportResult> {
  const today = todayISO();
  const last = addDays(today, 365);
  const byCity = new Map<string, { place: Place; events: LiventoEvent[] }>();
  let skipped = 0;
  for (const raw of items) {
    const parsed = ImportItemSchema.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const item = parsed.data;
    const date = item.date.trim();
    const url = httpsUrl(item.url);
    const host = url ? hostOf(url) : undefined;
    const place = resolvePlace(item.city, item.state);
    if (isoDatePart(date) !== date || date < today || date > last || !url || !host || !place) {
      skipped++;
      continue;
    }
    const image = item.image ? httpsUrl(item.image) : undefined;
    let priceMin = cleanPrice(item.priceMin);
    let priceMax = cleanPrice(item.priceMax);
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
    const priced = priceMin !== undefined || priceMax !== undefined;
    const time = cleanTime(item.time);
    const venue = item.venue ? tidy(item.venue) : "";
    const name = tidy(item.name);
    const event: LiventoEvent = {
      id: `web_${shortHash(`${url}|${date}|${place.key}|${norm(name)}`)}`,
      source: "web",
      name,
      category: item.category,
      date,
      ...(time ? { time } : {}),
      ...(venue ? { venue } : {}),
      city: place.city,
      ...(place.state ? { state: place.state } : {}),
      ...(priceMin !== undefined ? { priceMin } : {}),
      ...(priceMax !== undefined ? { priceMax } : {}),
      ...(priced ? { currency: "USD", priceNote: `Price listed on ${host} — an estimate, check the official page` } : {}),
      url,
      ...(image ? { image, imageCredit: host } : {}),
      attribution: host,
      tags: [item.category],
    };
    const group = byCity.get(place.key) ?? { place, events: [] };
    group.events.push(event);
    byCity.set(place.key, group);
  }

  const cities: Record<string, number> = {};
  let added = 0;
  for (const [key, { place, events }] of byCity) {
    await serialize(key, async () => {
      mem.memo.delete(key);
      const prev = await readCity(key);
      const oldest = addDays(today, -1);
      const kept = (prev?.events ?? []).filter((e) => (e.date ?? "") >= oldest);
      const doc: CityDoc = {
        v: 1,
        city: place.city,
        ...(place.state ? { state: place.state } : {}),
        coverage: prev?.coverage ?? {},
        events: dedupe([...events, ...kept]).sort(byDate).slice(0, CITY_EVENT_CAP),
      };
      const at = Date.now();
      await Promise.all([
        kvSet(cityKey(key), doc, CITY_TTL_SECONDS),
        ...events.map((e) => kvSet(eventKey(e.id), e, eventTtlSeconds(e, at))),
      ]);
      remember(key, doc);
    });
    cities[[place.city, place.state].filter(Boolean).join(", ")] = events.length;
    added += events.length;
  }
  return { added, skipped, cities };
}
