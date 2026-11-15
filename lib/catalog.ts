/**
 * Event catalogue (server-only): live Ticketmaster events when a key is set and
 * answering; otherwise real upcoming sports games from TheSportsDB (free,
 * keyless) plus real events found by AI web search (lib/webEvents, stored per
 * city); plus the curated big-experiences list. Only real events are listed:
 * when nothing is found the notice says so (sample events are never listed;
 * they only resolve by id for links saved earlier). Web and curated events get
 * their page's preview image (lib/eventImages). Shared by GET /api/events, the
 * assistant, the daily alerts job and the Telegram picks. Never runs a web
 * search itself: it reads stored results and reports `webSearch: "pending"`
 * so Discover can ask for one.
 */
import { after } from "next/server";
import experiencesJson from "@/data/experiences.json";
import sampleEventsJson from "@/data/sample-events.json";
import { findCity } from "./cities";
import { addDays, isoDatePart, todayISO } from "./dates";
import { previewImages } from "./eventImages";
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

/** Same wording as Discover's empty state. */
const noEventsNotice = (city?: string) =>
  `No events found ${city ? `near ${city}` : "nearby"} yet. Try a bigger travel radius or more interests.`;

/** Discover's note for the no-Ticketmaster mix. Never mentions Ticketmaster. */
function catalogNotice(sports: number, web: number, state: WebSearchState, city?: string): string {
  if (web > 0 || state === "pending") return sports > 0 ? LIVE_NOTICE : WEB_NOTICE;
  if (sports > 0) return state === "off" ? SPORTS_ONLY_NOTICE : SPORTS_WEB_EMPTY_NOTICE;
  return noEventsNotice(city);
}

const IMAGE_FETCHES_PER_REQUEST = 12;
const IMAGE_WAIT_MS = 1_200;
/** A site's logo or default share picture isn't the event's own image. */
const GENERIC_IMAGE = /(^|[/_.-])(logos?|default|placeholder|favicon)([/_.-]|$)/i;

function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || undefined;
  } catch {
    return undefined;
  }
}

function isGenericImage(url: string): boolean {
  try {
    return GENERIC_IMAGE.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

/**
 * Gives web and curated events without an image of their own the preview image
 * of their page (og:image), credited to the page's site. A web page shared by
 * several events is a listing, so its image isn't any one event's: skipped.
 * Time-boxed: pages not answered in time keep the local photo now and are
 * cached (the fetch keeps running after the response) for the next request.
 */
async function withPreviewImages(events: LiventoEvent[]): Promise<LiventoEvent[]> {
  const namesByUrl = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.source === "web") namesByUrl.set(e.url, (namesByUrl.get(e.url) ?? new Set()).add(e.name.toLowerCase()));
  }
  const wants = (e: LiventoEvent) =>
    (!e.image || e.image.startsWith("/")) &&
    (e.source === "curated" || (e.source === "web" && (namesByUrl.get(e.url)?.size ?? 0) <= 1));
  const urls = events.filter(wants).map((e) => e.url);
  if (urls.length === 0) return events;
  const { images, rest } = await previewImages(urls, IMAGE_FETCHES_PER_REQUEST, IMAGE_WAIT_MS);
  if (rest) {
    try {
      after(() => rest);
    } catch {
      // Outside a request (scripts): nothing to keep alive.
    }
  }
  return events.map((e) => {
    const image = wants(e) ? images.get(e.url) : undefined;
    if (!image || isGenericImage(image)) return e;
    const credit = siteOf(e.url);
    return { ...e, image, ...(credit ? { imageCredit: credit } : {}) };
  });
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

/**
 * Fictional sample events (always labeled). Never listed any more: kept only so
 * `smp_` ids saved earlier still resolve in findEventById.
 */
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
  if (local) return local.source === "curated" ? ((await withPreviewImages([local]))[0] ?? local) : local;
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
      events: [...events, ...(await withPreviewImages(curated))],
      source: curated.length ? "mixed" : "ticketmaster",
      ...(notice ? { notice } : {}),
    };
  }

  // No Ticketmaster answer: real games from TheSportsDB (home venue within the
  // radius) plus events already found by AI web search for this city. Nothing
  // else: when both are empty the notice says no events were found.
  // "from" goes along only when it's a later day: the server's today can be ahead of the venue's.
  const wantsSports = categories.length === 0 || categories.includes("sports");
  const gamesTask: Promise<LiventoEvent[]> = wantsSports
    ? getSportsEvents({
        lat: origin?.lat,
        lng: origin?.lng,
        city,
        state,
        radiusMiles: q.radius,
        from: from > today ? from : undefined,
        to,
      })
    : Promise.resolve([]);
  const web = await cachedWebEvents({ city, state, lat: origin?.lat, lng: origin?.lng, categories, from, to });
  const found = web.events.filter((e) => matchesKeyword(e, keyword));
  // Preview images load while the sports lookup is still running.
  const [games, pictured] = await Promise.all([
    gamesTask,
    withPreviewImages([...found, ...curated.sort(byNearest(city, state))]),
  ]);
  const sports = games.filter((e) => matchesKeyword(e, keyword)).map((e) => withDistance(e, origin));

  return {
    events: [...sports, ...pictured],
    source: "mixed",
    notice: catalogNotice(sports.length, found.length, web.state, city),
    webSearch: web.state,
  };
}
