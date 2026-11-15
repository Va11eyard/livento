import type { NextRequest } from "next/server";
import { findEventById, findEvents } from "@/lib/catalog";
import { apiError, json } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import type { EventsResponse } from "@/lib/types";
import { parseEventsQuery } from "./params";

export const dynamic = "force-dynamic";

/**
 * GET /api/events?city=&state=&lat=&lng=&radius=&categories=&from=&to=&keyword=  ·  GET /api/events?id=<event id>
 * Fast: sports, curated and already-stored web events. `webSearch: "pending"` means
 * GET /api/events/web (same params) can still find more.
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "events", RATE_LIMITS.general);
  if (limited) return limited;

  const sp = request.nextUrl.searchParams;

  // ?id=<livento id> — one event (shared links, alert emails); same response shape.
  const id = sp.get("id")?.trim();
  if (id !== undefined) {
    if (!/^(tm|tsdb|cur|smp|web)_[\w-]{1,120}$/.test(id)) return apiError("Invalid request: check \"id\".", 400);
    try {
      const event = await findEventById(id);
      if (!event) return apiError("We couldn't find that event. It may have ended or been removed.", 404);
      return json<EventsResponse>({
        events: [event],
        source: event.source === "ticketmaster" ? "ticketmaster" : event.source === "sample" ? "sample" : "mixed",
        ...(event.source === "sample" ? { notice: "Sample data — fictional event" } : {}),
      });
    } catch (err) {
      console.error("[events] lookup failed", err instanceof Error ? err.name : "");
      return apiError("This event is unavailable right now. Please try again.", 500);
    }
  }

  const parsed = parseEventsQuery(sp);
  if (!parsed.ok) return parsed.response;

  try {
    const result: EventsResponse = await findEvents(parsed.query);
    return json(result);
  } catch (err) {
    console.error("[events] failed", err instanceof Error ? err.name : "");
    return apiError("Events are unavailable right now. Please try again.", 500);
  }
}
