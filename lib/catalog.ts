/**
 * Event catalogue (server-only): live Ticketmaster events when a key is set and
 * answering; otherwise real upcoming sports games from TheSportsDB (free,
 * keyless) plus real events found by AI web search (lib/webEvents, stored per
 * city), and labeled sample events only when neither has anything; plus the
 * curated big-experiences list. Shared by GET /api/events, the assistant and
 * the daily alerts job. Never runs a web search itself: it reads stored
 * results and reports `webSearch: "pending"` so Discover can ask for one.
 */
import experiencesJson from "@/data/experiences.json";
import sampleEventsJson from "@/data/sample-events.json";
import { findCity } from "./cities";
import { addDays, isoDatePart, todayISO } from "./dates";
import { distanceMiles, isLatLng, type LatLng } from "./geo";
import { EventSchema } from "./schemas";
import { getSportsEventById, getSportsEvents, sportsIdOf } from "./thesportsdb";
import { getTicketmasterEventById, getTicketmasterEvents, ticketmasterIdOf } from "./ticketmaster";
import type { Category, EventsResponse, LiventoEvent, WebSearchState } from "./types";
import { cachedWebEvents, getWebEventById, isWebEventId } from "./webEvents";

const TM_STALE_NOTICE =
  "Live events are unavailable right now — showing Ticketmaster results saved in the last 24 hours";
const LIVE_NOTICE =
  "Sports are live from TheSportsDB; concerts, shows and more are found by AI web search — check each official page.";
const WEB_NOTICE = "Concerts, shows and more are found by AI web search — check each official page.";
const SPORTS_ONLY_NOTICE =
  "Real upcoming games from TheSportsDB. Ticket prices aren't listed, so cost plans use labeled estimates.";
const SPORTS_WEB_EMPTY_NOTICE =
  "Sports are live from TheSportsDB. AI web search found no matching concerts or shows nearby yet.";
const WEB_EMPTY_NOTICE = "AI web search found no matching events nearby yet.";
export const SAMPLE_NOTICE = "Showing labeled sample events.";
const SAMPLE_PENDING_NOTICE = "Showing labeled sample events while AI web search looks for real ones near you.";
const SAMPLE_WEB_EMPTY_NOTICE = "Showing labeled sample events: AI web search found no matching events nearby yet.";

/** Discover's note for the no-Ticketmaster mix. Never mentions Ticketmaster. */
function catalogNotice(sports: number, web: number, samples: number, state: WebSearchState): string | undefined {
  if (samples > 0) {
    return state === "off" ? SAMPLE_NOTICE : state === "pending" ? SAMPLE_PENDING_NOTICE : SAMPLE_WEB_EMPTY_NOTICE;
  }
  if (web > 0 || state === "pending") return sports > 0 ? LIVE_NOTICE : WEB_NOTICE;
  if (sports > 0) return state === "off" ? SPORTS_ONLY_NOTICE : SPORTS_WEB_EMPTY_NOTICE;
  return state === "cached" ? WEB_EMPTY_NOTICE : undefined;
}

function loadEvents(raw: unknown, label: string, extra?: (item: Record<string, unknown>) => Partial<LiventoEvent>) {
  const out: LiventoEvent[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = EventSchema.safeParse(item);
    if (!parsed.success) {
      console.warn(`[catalog] skipped an invalid ${label} entry`);
      continue;
    }
    out.push({ ...parsed.data, ...(extra?.(item as Record<string, unknown>) ?? {}) });
  }
  return out;
}

let curatedCache: LiventoEvent[] | undefined;
let sampleCache: LiventoEvent[] | undefined;

/** Curated real experiences (official links; prices/dates only where verified). */
export function curatedEvents(): LiventoEvent[] {
  curatedCache ??= loadEvents(experiencesJson, "curated", (item) => ({
    attribution:
      typeof item.verifiedAt === "string"
        ? `Curated · checked on the official site ${item.verifiedAt}`
        : "Curated · see the official site",
  }));
  return curatedCache;
}

/** Fictional sample events for the judge path (always labeled). */
export function sampleEvents(): LiventoEvent[] {
  sampleCache ??= loadEvents(sampleEventsJson, "sample", () => ({
    attribution: "Sample data — fictional event",
  }));
  return sampleCache;
}

/** Every event we can look up by id without a network call. */
export function localEventById(id: string): LiventoEvent | undefined {
  return curatedEvents().find((e) => e.id === id) ?? sampleEvents().find((e) => e.id === id);
}

/**
 * One event by Livento id: curated and sample events locally, `tm_<id>` from
 * Ticketmaster, `tsdb_<idEvent>` from TheSportsDB, `web_<hash>` from the stored
 * web-search results (until the event date passes). Lets /event/[id] and
 * /roadmap/[id] links work in a browser that never opened the event (shared
 * links, alert emails).
 */
export async function findEventById(id: string): Promise<LiventoEvent | null> {
  const local = localEventById(id);
  if (local) return local;
  if (isWebEventId(id)) return getWebEventById(id);
  const sportsId = sportsIdOf(id);
  if (sportsId) return getSportsEventById(sportsId);
  const tmId = ticketmasterIdOf(id);
  return tmId ? getTicketmasterEventById(tmId) : null;
}

export interface CatalogQuery {
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  categories: Category[];
  from?: string;
  to?: string;
  keyword?: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function withDistance(e: LiventoEvent, origin?: LatLng): LiventoEvent {
  if (origin && isLatLng(e)) {
    return { ...e, distanceMiles: round1(distanceMiles(origin, { lat: e.lat, lng: e.lng })) };
  }
  return e;
}

function matchesKeyword(e: LiventoEvent, keyword?: string): boolean {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return [e.name, e.venue, e.city, e.genre, e.subGenre, ...e.tags].some((v) => v?.toLowerCase().includes(k));
}

function matchesCategories(e: LiventoEvent, categories: Category[]): boolean {
  if (categories.length === 0) return true;
  return categories.includes(e.category) || categories.some((c) => e.tags.includes(c));
}

function sameCity(e: LiventoEvent, city?: string, state?: string): boolean {
  if (!city) return false;
  if (e.city.toLowerCase() !== city.trim().toLowerCase()) return false;
  return !state || !e.state || e.state.toUpperCase() === state.trim().toUpperCase();
}

function byNearest(city?: string, state?: string) {
  return (a: LiventoEvent, b: LiventoEvent) => {
    const da = a.distanceMiles ?? (sameCity(a, city, state) ? 0 : Number.POSITIVE_INFINITY);
    const db = b.distanceMiles ?? (sameCity(b, city, state) ? 0 : Number.POSITIVE_INFINITY);
    if (da !== db) return da - db;
    return (a.date ?? "9999").localeCompare(b.date ?? "9999");
  };
}

/** Curated experiences that match the interests (all of them for "experiences" or no filter). */
export function curatedFor(categories: Category[], keyword: string | undefined, today: string, origin?: LatLng) {
  const wantsAll = categories.length === 0 || categories.includes("experiences");
  return curatedEvents()
    .filter((e) => wantsAll || matchesCategories(e, categories))
    .filter((e) => !e.date || e.date >= today)
    .filter((e) => matchesKeyword(e, keyword))
    .map((e) => withDistance(e, origin));
}

export async function findEvents(q: CatalogQuery, today: string = todayISO()): Promise<EventsResponse> {
  const city = q.city?.trim() || undefined;
  const state = q.state?.trim().toUpperCase() || undefined;
  let origin: LatLng | undefined =
    typeof q.lat === "number" && typeof q.lng === "number" && isLatLng({ lat: q.lat, lng: q.lng })
      ? { lat: q.lat, lng: q.lng }
      : undefined;
  if (!origin && city) {
    const c = findCity(city, state);
    if (c) origin = { lat: c.lat, lng: c.lng };
  }

  const fromRaw = isoDatePart(q.from);
  const from = fromRaw && fromRaw > today ? fromRaw : today;
  const toRaw = isoDatePart(q.to);
  const maxTo = addDays(from, 365);
  const to = toRaw && toRaw >= from ? (toRaw < maxTo ? toRaw : maxTo) : maxTo;
  const categories = [...new Set(q.categories)];
  const keyword = q.keyword?.trim() || undefined;

  const curated = curatedFor(categories, keyword, today, origin);

  const live = await getTicketmasterEvents({
    lat: origin?.lat,
    lng: origin?.lng,
    radiusMiles: q.radius,
    city,
    stateCode: state,
    categories,
    from,
    to,
    keyword,
  });

  if (live !== null) {
    const events = live.events.map((e) => (e.distanceMiles === undefined ? withDistance(e, origin) : e));
    let notice: string | undefined;
    if (live.stale) {
      notice = TM_STALE_NOTICE;
    } else if (events.length === 0) {
      notice = curated.length
        ? "No live events matched these filters — showing big experiences"
        : "No live events matched these filters";
    } else if (categories.includes("cinema")) {
      notice = "Cinema listings aren't available from Ticketmaster";
    }
    return {
      events: [...events, ...curated],
      source: curated.length ? "mixed" : "ticketmaster",
      ...(notice ? { notice } : {}),
    };
  }

  // No Ticketmaster answer: real games from TheSportsDB (home venue within the
  // radius) plus events already found by AI web search for this city. Labeled
  // samples only when neither has anything.
  // "from" goes along only when it's a later day: the server's today can be ahead of the venue's.
  const wantsSports = categories.length === 0 || categories.includes("sports");
  const [games, web] = await Promise.all([
    wantsSports
      ? getSportsEvents({
          lat: origin?.lat,
          lng: origin?.lng,
          city,
          state,
          radiusMiles: q.radius,
          from: from > today ? from : undefined,
          to,
        })
      : Promise.resolve([]),
    cachedWebEvents({ city, state, lat: origin?.lat, lng: origin?.lng, categories, from, to }),
  ]);
  const sports = games.filter((e) => matchesKeyword(e, keyword)).map((e) => withDistance(e, origin));
  const found = web.events.filter((e) => matchesKeyword(e, keyword));

  const samples =
    sports.length > 0 || found.length > 0
      ? []
      : sampleEvents()
          .filter((e) => matchesCategories(e, categories))
          .filter((e) => !e.date || (e.date >= from && e.date <= to))
          .filter((e) => matchesKeyword(e, keyword))
          .map((e) => withDistance(e, origin))
          .sort(byNearest(city, state));

  const notice = catalogNotice(sports.length, found.length, samples.length, web.state);
  return {
    events: [...sports, ...found, ...samples, ...curated.sort(byNearest(city, state))],
    source: samples.length > 0 ? "sample" : "mixed",
    ...(notice ? { notice } : {}),
    webSearch: web.state,
  };
}
