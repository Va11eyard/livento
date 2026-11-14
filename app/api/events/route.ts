import type { NextRequest } from "next/server";
import { findEvents } from "@/lib/catalog";
import { apiError, json } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { CATEGORIES, type Category, type EventsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/events?city=&state=&lat=&lng=&radius=&categories=&from=&to=&keyword= */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "events", RATE_LIMITS.general);
  if (limited) return limited;

  const sp = request.nextUrl.searchParams;
  const num = (key: string): number | undefined | null => {
    const raw = sp.get(key);
    if (raw === null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const lat = num("lat");
  const lng = num("lng");
  const radius = num("radius");
  if (lat === null || lng === null || radius === null) {
    return apiError("Invalid request: lat, lng and radius must be numbers.", 400);
  }
  if ((lat !== undefined && Math.abs(lat) > 90) || (lng !== undefined && Math.abs(lng) > 180)) {
    return apiError("Invalid request: coordinates are out of range.", 400);
  }
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    return apiError("Invalid request: dates must look like YYYY-MM-DD.", 400);
  }
  const categories = (sp.get("categories") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));

  try {
    const result: EventsResponse = await findEvents({
      city: sp.get("city")?.slice(0, 100),
      state: sp.get("state")?.slice(0, 10),
      lat,
      lng,
      radius: radius === undefined ? undefined : Math.min(500, Math.max(1, radius)),
      categories,
      from,
      to,
      keyword: sp.get("keyword")?.slice(0, 100),
    });
    return json(result);
  } catch (err) {
    console.error("[events] failed", err instanceof Error ? err.name : "");
    return apiError("Events are unavailable right now. Please try again.", 500);
  }
}
