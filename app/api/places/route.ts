import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json } from "@/lib/http";
import { findPlaces, geocode, PLACE_KINDS } from "@/lib/places";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Query = z.object({
  kind: z.enum(PLACE_KINDS),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  near: z.string().trim().max(160).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(10).optional(),
  radius: z.coerce.number().min(300).max(8000).optional(), // meters
});

/**
 * GET /api/places?kind=hotel&near=<venue>&city=&state= (or &lat=&lng=) — real places around a
 * venue or point from OpenStreetMap, nearest first (no prices: map data has none).
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "places", RATE_LIMITS.general);
  if (limited) return limited;
  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return apiError("Invalid place search.", 400);
  const q = parsed.data;
  try {
    const at =
      q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : await geocode(q.near ?? "", q.city, q.state);
    if (!at) return json({ places: [] });
    const places = await findPlaces(q.kind, at, { radiusMeters: q.radius ?? 3_000, limit: 6 });
    return json({ places }, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return apiError("Map data is unavailable right now.", 503);
  }
}
