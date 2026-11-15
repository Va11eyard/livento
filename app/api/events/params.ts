import type { CatalogQuery } from "@/lib/catalog";
import { apiError } from "@/lib/http";
import { CATEGORIES, type Category } from "@/lib/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query string shared by GET /api/events and GET /api/events/web:
 * city, state, lat, lng, radius, categories (comma list), from, to (YYYY-MM-DD), keyword.
 * Returns the parsed query or a 400 response.
 */
export function parseEventsQuery(
  sp: URLSearchParams,
): { ok: true; query: CatalogQuery } | { ok: false; response: Response } {
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
    return { ok: false, response: apiError("Invalid request: lat, lng and radius must be numbers.", 400) };
  }
  if ((lat !== undefined && Math.abs(lat) > 90) || (lng !== undefined && Math.abs(lng) > 180)) {
    return { ok: false, response: apiError("Invalid request: coordinates are out of range.", 400) };
  }
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    return { ok: false, response: apiError("Invalid request: dates must look like YYYY-MM-DD.", 400) };
  }
  const categories = (sp.get("categories") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));

  return {
    ok: true,
    query: {
      city: sp.get("city")?.slice(0, 100),
      state: sp.get("state")?.slice(0, 10),
      lat,
      lng,
      radius: radius === undefined ? undefined : Math.min(500, Math.max(1, radius)),
      categories,
      from,
      to,
      keyword: sp.get("keyword")?.slice(0, 100),
    },
  };
}
