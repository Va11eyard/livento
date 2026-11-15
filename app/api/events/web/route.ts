import type { NextRequest } from "next/server";
import { apiError, json } from "@/lib/http";
import { isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, clientIp, rateLimit } from "@/lib/ratelimit";
import type { WebEventsResponse } from "@/lib/types";
import { WebSearchError, searchWebEvents } from "@/lib/webEvents";
import { parseEventsQuery } from "../params";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UNAVAILABLE = "We couldn't search the web right now. Please try again in a few minutes.";

/**
 * GET /api/events/web?<same params as /api/events> — real upcoming events found by
 * AI web search for the interests not searched yet in this city, saved for every
 * visitor; stored results when they're fresh. A new search takes up to ~45 s.
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "events-web", RATE_LIMITS.llm);
  if (limited) return limited;

  const parsed = parseEventsQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return parsed.response;
  const q = parsed.query;
  if (!isLlmConfigured()) return apiError("AI web search isn't connected on this deployment.", 503);
  if (!q.city?.trim()) return apiError("Invalid request: add a city to search near.", 400);

  try {
    const events = await searchWebEvents(
      { city: q.city, state: q.state, lat: q.lat, lng: q.lng, categories: q.categories, from: q.from, to: q.to },
      { ip: clientIp(request) },
    );
    const keyword = q.keyword?.trim().toLowerCase();
    const matching = keyword
      ? events.filter((e) => [e.name, e.venue, e.city, ...e.tags].some((v) => v?.toLowerCase().includes(keyword)))
      : events;
    return json<WebEventsResponse>({ events: matching });
  } catch (err) {
    if (err instanceof WebSearchError) {
      if (err.kind === "off") return apiError("AI web search isn't connected on this deployment.", 503);
      if (err.kind === "budget") {
        return apiError("The web search is busy right now. Please try again later.", 429, { "Retry-After": "600" });
      }
      return apiError(UNAVAILABLE, 503);
    }
    console.error("[events-web] failed", err instanceof Error ? err.name : "");
    return apiError(UNAVAILABLE, 500);
  }
}
