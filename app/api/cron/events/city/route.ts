import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, json, parseBody } from "@/lib/http";
import { isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { WebSearchError, refreshCityWebEvents } from "@/lib/webEvents";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  city: z.string().trim().min(2).max(60),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
});

/**
 * POST /api/cron/events/city {city, state} — one city's daily refresh, called by
 * GET /api/cron/events. Requires `Authorization: Bearer CRON_SECRET`. Answers 202
 * at once; the search runs after the response, within this function's own budget.
 */
export async function POST(request: NextRequest) {
  // All cities arrive together from the cron function's address: the general limit fits 15.
  const limited = await rateLimit(request, "cron-events-city", RATE_LIMITS.general);
  if (limited) return limited;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("Unauthorized", 401);
  }
  const parsed = await parseBody(request, Body, 1_024);
  if (!parsed.ok) return parsed.response;
  if (!isLlmConfigured()) return apiError("AI web search isn't connected on this deployment.", 503);

  const { city, state } = parsed.data;
  after(async () => {
    try {
      const result = await refreshCityWebEvents(city, state);
      console.info(`[cron-events] ${result.city}: ${result.status}, ${result.events} stored events`);
    } catch (err) {
      console.warn(`[cron-events] ${city}: ${err instanceof WebSearchError ? err.kind : "failed"}`);
    }
  });
  return json({ queued: true, city, state }, 202);
}
