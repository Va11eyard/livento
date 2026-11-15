/**
 * Real places near a city, venue or event from OpenStreetMap's Nominatim (no key
 * needed): geocodes a place name, then lists restaurants, cafés, bars, museums,
 * parks and more inside a small box around it. Server-only. Cached in KV for a day
 * to stay well inside Nominatim's fair-use policy (≤ 1 request per second).
 * OpenStreetMap has no prices, so nothing here carries one.
 */
import { findCity } from "./cities";
import { distanceMiles } from "./geo";
import { kvGet, kvSet } from "./kv";

const USER_AGENT = "Livento/1.0 (event planning app; https://livento-lilac.vercel.app)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const CACHE_SECONDS = 86_400;

export const PLACE_KINDS = [
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "dessert",
  "museum",
  "gallery",
  "park",
  "attraction",
  "cinema",
  "theatre",
  "nightclub",
  "bowling",
  "zoo",
  "aquarium",
  "hotel",
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** Nominatim search phrase per kind (OpenStreetMap special phrases, e.g. "restaurant", "museum"). */
const PHRASES: Record<PlaceKind, string> = {
  restaurant: "restaurant",
  cafe: "cafe",
  bar: "bar",
  fast_food: "fast food",
  dessert: "ice cream",
  museum: "museum",
  gallery: "gallery",
  park: "park",
  attraction: "attraction",
  cinema: "cinema",
  theatre: "theatre",
  nightclub: "nightclub",
  bowling: "bowling alley",
  zoo: "zoo",
  aquarium: "aquarium",
  hotel: "hotel",
};

export interface Place {
  name: string;
  kind: PlaceKind;
  cuisine?: string;
  address?: string;
  website?: string;
  hours?: string;
  milesAway: number;
  mapUrl: string;
}

interface LatLng {
  lat: number;
  lng: number;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await kvGet<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch {
    // cache is best effort
  }
  const value = await load();
  try {
    await kvSet(key, value, CACHE_SECONDS);
  } catch {
    // ignore
  }
  return value;
}

/** Coordinates for "venue, city, state" or a city: built-in US cities first, then Nominatim. */
export async function geocode(query: string, city?: string, state?: string): Promise<LatLng | null> {
  const known = !query.trim() || query.trim().toLowerCase() === (city ?? "").toLowerCase() ? findCity(city ?? "", state) : null;
  if (known) return { lat: known.lat, lng: known.lng };
  const q = [query, city, state, "USA"].filter(Boolean).join(", ");
  return cached(`geo:v1:${q.toLowerCase()}`, async () => {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const rows = (await res.json()) as { lat?: string; lon?: string }[];
    const lat = Number(rows[0]?.lat);
    const lng = Number(rows[0]?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  });
}

interface NominatimRow {
  name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
}

function addressOf(a: Record<string, string> | undefined): string | undefined {
  if (!a) return undefined;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const line = [street, a.city ?? a.town ?? a.village ?? a.suburb].filter(Boolean).join(", ");
  return line || undefined;
}

async function nominatimBox(phrase: string, at: LatLng, radius: number): Promise<NominatimRow[]> {
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.max(0.2, Math.cos((at.lat * Math.PI) / 180)));
  const box = [at.lng - dLng, at.lat + dLat, at.lng + dLng, at.lat - dLat].map((n) => n.toFixed(5)).join(",");
  const url =
    `${NOMINATIM}?format=jsonv2&limit=40&addressdetails=1&extratags=1&bounded=1&countrycodes=us` +
    `&viewbox=${box}&q=${encodeURIComponent(phrase)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Map data is unavailable right now (${res.status}).`);
  return ((await res.json()) as NominatimRow[]).filter((r) => r.name);
}

/** Up to `limit` named places of one kind around a point, nearest first. */
export async function findPlaces(
  kind: PlaceKind,
  at: LatLng,
  opts: { radiusMeters?: number; cuisine?: string; limit?: number } = {},
): Promise<Place[]> {
  const radius = Math.min(5_000, Math.max(300, Math.round(opts.radiusMeters ?? 1_600)));
  const limit = Math.min(8, Math.max(1, opts.limit ?? 6));
  const cuisine = opts.cuisine?.toLowerCase().replace(/[^a-z -]/g, "").trim().slice(0, 30) || undefined;
  const key = `places:v2:${kind}:${at.lat.toFixed(3)},${at.lng.toFixed(3)}:${radius}:${cuisine ?? ""}`;
  const rows = await cached(key, async () => {
    const all = await nominatimBox(PHRASES[kind], at, radius);
    if (!cuisine) return all;
    const matching = all.filter((r) => (r.extratags?.cuisine ?? "").toLowerCase().includes(cuisine.replace(/ /g, "_")));
    // No cuisine tag matched: fall back to places named after it (e.g. "Pizza Brain").
    return matching.length ? matching : await nominatimBox(`${cuisine} ${PHRASES[kind]}`, at, radius).catch(() => []);
  });

  const seen = new Set<string>();
  const places: Place[] = [];
  for (const r of rows) {
    const pLat = Number(r.lat);
    const pLng = Number(r.lon);
    const name = (r.name ?? "").trim();
    if (!name || !Number.isFinite(pLat) || !Number.isFinite(pLng) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const tags = r.extratags ?? {};
    const address = addressOf(r.address);
    const site = tags.website ?? tags["contact:website"] ?? "";
    places.push({
      name,
      kind,
      ...(tags.cuisine ? { cuisine: tags.cuisine.replace(/;/g, ", ").replace(/_/g, " ") } : {}),
      ...(address ? { address } : {}),
      ...(/^https?:\/\//.test(site) ? { website: site } : {}),
      ...(tags.opening_hours ? { hours: tags.opening_hours.slice(0, 80) } : {}),
      milesAway: Math.round(distanceMiles({ lat: at.lat, lng: at.lng }, { lat: pLat, lng: pLng }) * 10) / 10,
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, address].filter(Boolean).join(", "))}`,
    });
  }
  return places.sort((a, b) => a.milesAway - b.milesAway).slice(0, limit);
}
