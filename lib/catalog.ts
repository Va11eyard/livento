/**
 * Event catalogue (server-only): live Ticketmaster events when a key is set,
 * otherwise labeled sample events; plus the curated big-experiences list.
 * Shared by GET /api/events and the daily alerts job.
 */
import experiencesJson from "@/data/experiences.json";
import sampleEventsJson from "@/data/sample-events.json";
import { findCity } from "./cities";
import { addDays, isoDatePart, todayISO } from "./dates";
import { distanceMiles, isLatLng, type LatLng } from "./geo";
import { EventSchema } from "./schemas";
import {
  getTicketmasterEventById,
  getTicketmasterEvents,
  hasTicketmasterKey,
  ticketmasterIdOf,
} from "./ticketmaster";
import type { Category, EventsResponse, LiventoEvent } from "./types";

export const SAMPLE_NOTICE = "Showing sample events — live data needs a Ticketmaster API key";
const TM_DOWN_NOTICE = "Live events are unavailable right now — showing sample events";
const TM_STALE_NOTICE =
  "Live events are unavailable right now — showing Ticketmaster results saved in the last 24 hours";

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
 * Ticketmaster. Lets /event/[id] and /roadmap/[id] links work in a browser
 * that never opened the event (shared links, alert emails).
 */
export async function findEventById(id: string): Promise<LiventoEvent | null> {
  const local = localEventById(id);
  if (local) return local;
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

  const samples = sampleEvents()
    .filter((e) => matchesCategories(e, categories))
    .filter((e) => !e.date || (e.date >= from && e.date <= to))
    .filter((e) => matchesKeyword(e, keyword))
    .map((e) => withDistance(e, origin))
    .sort(byNearest(city, state));

  return {
    events: [...samples, ...curated.sort(byNearest(city, state))],
    source: "sample",
    notice: hasTicketmasterKey() ? TM_DOWN_NOTICE : SAMPLE_NOTICE,
  };
}
