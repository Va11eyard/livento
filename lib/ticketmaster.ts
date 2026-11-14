/**
 * Ticketmaster Discovery API v2 client (server-only).
 * Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
 *
 * - Returns null when there is no key or every upstream call fails, so the
 *   caller can fall back to labeled sample events.
 * - Results are cached for 1 hour in lib/kv (key `events:<hash>`), plus a
 *   24-hour backup (`events:<hash>:stale`) used only when Ticketmaster fails.
 * - At most 4 parallel calls per query (Ticketmaster allows 5 requests/second).
 */
import { createHash } from "node:crypto";
import { kvGet, kvSet } from "./kv";
import type { Category, LiventoEvent, Presale } from "./types";

const TM_EVENTS_URL = "https://app.ticketmaster.com/discovery/v2/events.json";
const TM_EVENT_URL = "https://app.ticketmaster.com/discovery/v2/events";
const TIMEOUT_MS = 6_000;
const CACHE_TTL_SECONDS = 3_600;
/** Backup copy used only when Ticketmaster is down. */
const STALE_TTL_SECONDS = 24 * 3_600;
const MAX_EVENTS = 120;

export const TM_ATTRIBUTION = "Event data: Ticketmaster";

export interface TicketmasterQuery {
  lat?: number;
  lng?: number;
  radiusMiles?: number;
  city?: string;
  stateCode?: string;
  /** Categories that Ticketmaster can serve (cinema/experiences are ignored). Empty = all. */
  categories: Category[];
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  keyword?: string;
}

// ---------------------------------------------------------------------------
// Minimal shapes of the Discovery API response (only what we read)
// ---------------------------------------------------------------------------

interface TmNamed {
  name?: string;
}
interface TmClassification {
  primary?: boolean;
  family?: boolean;
  segment?: TmNamed;
  genre?: TmNamed;
  subGenre?: TmNamed;
}
interface TmImage {
  ratio?: string;
  url?: string;
  width?: number;
  height?: number;
  fallback?: boolean;
}
interface TmVenue {
  name?: string;
  city?: TmNamed;
  state?: { name?: string; stateCode?: string };
  location?: { latitude?: string; longitude?: string };
}
interface TmEvent {
  id?: string;
  name?: string;
  url?: string;
  distance?: number;
  images?: TmImage[];
  classifications?: TmClassification[];
  priceRanges?: { type?: string; currency?: string; min?: number; max?: number }[];
  sales?: {
    public?: { startDateTime?: string; startTBD?: boolean; startTBA?: boolean };
    presales?: { name?: string; startDateTime?: string; endDateTime?: string }[];
  };
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
      dateTBD?: boolean;
      dateTBA?: boolean;
      timeTBA?: boolean;
      noSpecificTime?: boolean;
    };
    status?: { code?: string };
  };
  _embedded?: { venues?: TmVenue[]; attractions?: TmNamed[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash encoding (Ticketmaster's `geoPoint` replaces the deprecated `latlong`). */
export function geohash(lat: number, lng: number, precision = 7): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bits = 0;
  let index = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        index = index * 2 + 1;
        lngMin = mid;
      } else {
        index *= 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        index = index * 2 + 1;
        latMin = mid;
      } else {
        index *= 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += GEOHASH_BASE32[index];
      bits = 0;
      index = 0;
    }
  }
  return hash;
}

const clean = (value?: string): string | undefined => {
  const v = value?.trim();
  return v && !/^(undefined|other|n\/a)$/i.test(v) ? v : undefined;
};

function validIsoDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  if (new Date(ms).getUTCFullYear() < 2000) return undefined; // Ticketmaster uses 1900-01-01 for "TBD"
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

function pickImage(images?: TmImage[]): string | undefined {
  const list = (images ?? []).filter((i) => typeof i?.url === "string" && i.url.startsWith("https://"));
  if (!list.length) return undefined;
  const scoreOf = (i: TmImage) =>
    (i.ratio === "16_9" ? 0 : 10_000) + (i.fallback ? 5_000 : 0) + Math.abs((i.width ?? 0) - 640);
  return [...list].sort((a, b) => scoreOf(a) - scoreOf(b))[0].url;
}

interface Group {
  key: string;
  params: Record<string, string>;
  hint?: Category;
}

function groupsFor(categories: Category[], keyword?: string): Group[] {
  const set = new Set(categories);
  if (set.size === 0) return [{ key: "all", params: {} }];
  const groups: Group[] = [];
  if (set.has("music")) groups.push({ key: "music", params: { segmentName: "Music" }, hint: "music" });
  if (set.has("festivals")) {
    groups.push({
      key: "festivals",
      params: { classificationName: "Music", keyword: keyword ? `${keyword} festival` : "festival" },
      hint: "festivals",
    });
  }
  const arts = [set.has("theatre") ? "Theatre" : "", set.has("comedy") ? "Comedy" : ""].filter(Boolean);
  if (arts.length) {
    groups.push({
      key: "arts",
      params: { classificationName: arts.join(",") },
      hint: arts.length === 1 ? (set.has("comedy") ? "comedy" : "theatre") : undefined,
    });
  }
  const sportsFamily = [set.has("sports") ? "Sports" : "", set.has("family") ? "Family" : ""].filter(Boolean);
  if (sportsFamily.length) {
    groups.push({
      key: "sports-family",
      params: { classificationName: sportsFamily.join(",") },
      hint: sportsFamily.length === 1 ? (set.has("family") ? "family" : "sports") : undefined,
    });
  }
  return groups;
}

function categorize(
  segment: string | undefined,
  genre: string | undefined,
  subGenre: string | undefined,
  name: string,
  family: boolean | undefined,
  hint: Category | undefined,
): Category {
  const seg = (segment ?? "").toLowerCase();
  const g = `${genre ?? ""} ${subGenre ?? ""}`.toLowerCase();
  const n = name.toLowerCase();
  if (g.includes("comedy")) return "comedy";
  if (seg === "music") return hint === "festivals" || /\bfest(ival)?\b/.test(n) || g.includes("festival") ? "festivals" : "music";
  if (seg === "sports") return "sports";
  if (seg === "arts & theatre") return g.includes("children") ? "family" : "theatre";
  if (seg === "film") return "cinema";
  if (g.includes("family") || (family && seg === "miscellaneous")) return "family";
  if (/\bfestival\b/.test(n)) return "festivals";
  return hint ?? (family ? "family" : "experiences");
}

function mapEvent(e: TmEvent, hint?: Category): LiventoEvent | null {
  if (!e?.id || !e.name || !e.url) return null;
  const status = e.dates?.status?.code?.toLowerCase();
  if (status === "cancelled" || status === "canceled" || status === "postponed") return null;
  if (/\b(parking|upsell|upgrade|voucher|gift card|add-on)\b/i.test(e.name)) return null;

  const venue = e._embedded?.venues?.[0];
  const city = clean(venue?.city?.name);
  if (!city) return null;

  const cls = (e.classifications ?? []).find((c) => c.primary) ?? e.classifications?.[0];
  const segment = clean(cls?.segment?.name);
  const genre = clean(cls?.genre?.name);
  const subGenre = clean(cls?.subGenre?.name);
  const category = categorize(segment, genre, subGenre, e.name, cls?.family, hint);

  const start = e.dates?.start;
  const date =
    start?.localDate && !start.dateTBD && !start.dateTBA && /^\d{4}-\d{2}-\d{2}$/.test(start.localDate)
      ? start.localDate
      : undefined;
  const time =
    date && start?.localTime && !start.timeTBA && !start.noSpecificTime ? start.localTime.slice(0, 5) : undefined;

  const prices = (e.priceRanges ?? []).filter(
    (p) => typeof p.min === "number" || typeof p.max === "number",
  );
  const mins = prices.map((p) => p.min).filter((v): v is number => typeof v === "number" && v >= 0);
  const maxs = prices.map((p) => p.max ?? p.min).filter((v): v is number => typeof v === "number" && v >= 0);
  const priceMin = mins.length ? Math.round(Math.min(...mins) * 100) / 100 : undefined;
  const priceMax = maxs.length ? Math.round(Math.max(...maxs) * 100) / 100 : undefined;

  const pub = e.sales?.public;
  const onSaleStart = pub && !pub.startTBD && !pub.startTBA ? validIsoDateTime(pub.startDateTime) : undefined;
  const presales: Presale[] = (e.sales?.presales ?? [])
    .map((p) => ({
      name: clean(p.name) ?? "Presale",
      start: validIsoDateTime(p.startDateTime) ?? "",
      end: validIsoDateTime(p.endDateTime),
    }))
    .filter((p) => p.start)
    .slice(0, 6)
    .map((p) => (p.end ? p : { name: p.name, start: p.start }));

  const lat = Number.parseFloat(venue?.location?.latitude ?? "");
  const lng = Number.parseFloat(venue?.location?.longitude ?? "");
  const attractions = (e._embedded?.attractions ?? [])
    .map((a) => clean(a.name))
    .filter((v): v is string => Boolean(v))
    .slice(0, 5);

  const tags = [
    ...new Set(
      [category, segment, genre, subGenre, ...attractions]
        .filter((v): v is string => Boolean(v))
        .map((v) => v.toLowerCase()),
    ),
  ];

  return {
    id: `tm_${e.id}`,
    source: "ticketmaster",
    name: e.name.trim(),
    category,
    genre,
    subGenre,
    date,
    time,
    venue: clean(venue?.name),
    city,
    state: clean(venue?.state?.stateCode),
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
    distanceMiles:
      typeof e.distance === "number" && Number.isFinite(e.distance) ? Math.round(e.distance * 10) / 10 : undefined,
    priceMin,
    priceMax,
    currency: prices[0]?.currency ?? (priceMin !== undefined ? "USD" : undefined),
    priceNote:
      priceMin !== undefined || priceMax !== undefined
        ? "Face value from Ticketmaster — fees extra"
        : "Price not listed — check Ticketmaster",
    onSaleStart,
    presales: presales.length ? presales : undefined,
    url: e.url,
    image: pickImage(e.images),
    attribution: TM_ATTRIBUTION,
    tags,
  };
}

async function fetchGroup(apiKey: string, q: TicketmasterQuery, group: Group): Promise<LiventoEvent[]> {
  const params = new URLSearchParams({
    apikey: apiKey,
    countryCode: "US",
    sort: "date,asc",
    size: group.key === "all" ? "60" : "30",
    startDateTime: `${q.from}T00:00:00Z`,
    endDateTime: `${q.to}T23:59:59Z`,
    ...group.params,
  });
  if (typeof q.lat === "number" && typeof q.lng === "number") {
    params.set("geoPoint", geohash(q.lat, q.lng, 7));
    params.set("radius", String(Math.round(Math.min(500, Math.max(5, q.radiusMiles ?? 50)))));
    params.set("unit", "miles");
  } else {
    if (q.city) params.set("city", q.city);
    if (q.stateCode) params.set("stateCode", q.stateCode);
  }
  if (q.keyword && !group.params.keyword) params.set("keyword", q.keyword);

  const res = await fetch(`${TM_EVENTS_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ticketmaster HTTP ${res.status}`);
  const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
  const raw = data?._embedded?.events ?? [];
  return raw.map((e) => mapEvent(e, group.hint)).filter((e): e is LiventoEvent => e !== null);
}

function cacheKey(q: TicketmasterQuery): string {
  const normalized = {
    lat: typeof q.lat === "number" ? Math.round(q.lat * 100) / 100 : null,
    lng: typeof q.lng === "number" ? Math.round(q.lng * 100) / 100 : null,
    r: q.radiusMiles ? Math.round(q.radiusMiles) : null,
    city: q.city?.toLowerCase().trim() ?? null,
    st: q.stateCode?.toUpperCase().trim() ?? null,
    cats: [...new Set(q.categories)].sort(),
    from: q.from,
    to: q.to,
    kw: q.keyword?.toLowerCase().trim() ?? null,
  };
  return `events:${createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 24)}`;
}

export function hasTicketmasterKey(): boolean {
  return Boolean(process.env.TICKETMASTER_API_KEY?.trim());
}

export interface TicketmasterResult {
  events: LiventoEvent[];
  /** true when Ticketmaster failed and these come from the last good answer (≤ 24 h old). */
  stale: boolean;
}

/**
 * Live events for a query, or null when there is no key / every call failed
 * and there is no recent copy. An empty list means Ticketmaster answered but
 * found nothing. Fresh answers are cached 1 hour; a backup copy is kept for
 * 24 hours so an outage falls back to cached events before sample events.
 */
export async function getTicketmasterEvents(q: TicketmasterQuery): Promise<TicketmasterResult | null> {
  const apiKey = process.env.TICKETMASTER_API_KEY?.trim();
  if (!apiKey) return null;

  const tmCategories = q.categories.filter((c) => c !== "cinema" && c !== "experiences");
  if (q.categories.length > 0 && tmCategories.length === 0) return { events: [], stale: false };
  const query: TicketmasterQuery = { ...q, categories: tmCategories };

  const key = cacheKey(query);
  const staleKey = `${key}:stale`;
  try {
    const cached = await kvGet<LiventoEvent[]>(key);
    if (Array.isArray(cached)) return { events: cached, stale: false };
  } catch {
    // cache unavailable — continue live
  }

  const groups = groupsFor(query.categories, query.keyword).slice(0, 4);
  const settled = await Promise.allSettled(groups.map((g) => fetchGroup(apiKey, query, g)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<LiventoEvent[]> => s.status === "fulfilled");
  if (ok.length === 0) {
    console.warn("[ticketmaster] all requests failed");
    try {
      const backup = await kvGet<LiventoEvent[]>(staleKey);
      if (Array.isArray(backup) && backup.length) return { events: backup, stale: true };
    } catch {
      // no backup either
    }
    return null;
  }

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const events: LiventoEvent[] = [];
  for (const e of ok.flatMap((s) => s.value)) {
    const dupKey = `${e.name.toLowerCase()}|${e.date ?? ""}|${(e.venue ?? e.city).toLowerCase()}`;
    if (seenIds.has(e.id) || seenKeys.has(dupKey)) continue;
    seenIds.add(e.id);
    seenKeys.add(dupKey);
    events.push(e);
  }
  events.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  const result = events.slice(0, MAX_EVENTS);

  try {
    await kvSet(key, result, CACHE_TTL_SECONDS);
    await kvSet(staleKey, result, STALE_TTL_SECONDS);
  } catch {
    // ignore cache write failures
  }
  return { events: result, stale: false };
}

/** Ticketmaster's own event id from a Livento id ("tm_<id>"), or null. */
export function ticketmasterIdOf(liventoId: string): string | null {
  const m = /^tm_([A-Za-z0-9_-]{1,64})$/.exec(liventoId);
  return m ? m[1] : null;
}

/**
 * One event by Ticketmaster id (GET /discovery/v2/events/{id}), cached 1 hour.
 * Null when there is no key, the event is gone/cancelled, or the call fails.
 */
export async function getTicketmasterEventById(tmId: string): Promise<LiventoEvent | null> {
  const apiKey = process.env.TICKETMASTER_API_KEY?.trim();
  if (!apiKey || !/^[A-Za-z0-9_-]{1,64}$/.test(tmId)) return null;
  const key = `event:tm:${tmId}`;
  try {
    const cached = await kvGet<LiventoEvent>(key);
    if (cached && typeof cached === "object" && cached.id) return cached;
  } catch {
    // cache unavailable — continue live
  }
  try {
    const params = new URLSearchParams({ apikey: apiKey });
    const res = await fetch(`${TM_EVENT_URL}/${encodeURIComponent(tmId)}.json?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[ticketmaster] event lookup HTTP ${res.status}`);
      return null;
    }
    const event = mapEvent((await res.json()) as TmEvent);
    if (event) {
      try {
        await kvSet(key, event, CACHE_TTL_SECONDS);
      } catch {
        // ignore cache write failures
      }
    }
    return event;
  } catch {
    console.warn("[ticketmaster] event lookup failed");
    return null;
  }
}
