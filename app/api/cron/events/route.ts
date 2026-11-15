import type { NextRequest } from "next/server";
import { apiError, json, siteOrigin } from "@/lib/http";
import { isKvConfigured } from "@/lib/kv";
import { isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { CRON_CITIES, MAX_WEB_SEARCHES, WEB_SEARCH_MODEL } from "@/lib/webEvents";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/events — daily refresh of AI web-search events for the 15 largest
 * US cities (Vercel Cron, 13:00 UTC). Safe to call once by hand after a deploy to
 * pre-fill the store. Requires `Authorization: Bearer CRON_SECRET`.
 *
 * Fans out one POST per city to /api/cron/events/city, so every search runs in
 * its own function with its own time budget (never one long sequential call).
 * Cities refreshed in the last 20 hours are skipped there. Cost per run: at most
 * one Claude request with up to 4 web searches per city.
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "cron-events", RATE_LIMITS.cron);
  if (limited) return limited;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("Unauthorized", 401);
  }
  if (!isLlmConfigured()) {
    return json({ ok: false, queued: 0, note: "AI web search is off: ANTHROPIC_API_KEY is not set" });
  }
  // On Vercel the results must land in Redis to be shared; locally the dev server's memory is enough.
  if (!isKvConfigured() && process.env.VERCEL) {
    return json({ ok: false, queued: 0, note: "Storage is not configured, so found events would not be shared" });
  }

  const target = `${siteOrigin(request)}/api/cron/events/city`;
  const cities = await Promise.all(
    CRON_CITIES.map(async (c) => {
      const city = `${c.name}, ${c.state}`;
      try {
        const res = await fetch(target, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ city: c.name, state: c.state }),
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        return { city, queued: res.status === 202, status: res.status };
      } catch {
        return { city, queued: false, status: 0 };
      }
    }),
  );
  const queued = cities.filter((c) => c.queued).length;
  console.info(`[cron-events] queued ${queued} of ${cities.length} cities`);

  return json({
    ok: queued > 0,
    queued,
    model: WEB_SEARCH_MODEL,
    maxWebSearchesPerCity: MAX_WEB_SEARCHES,
    maxWebSearchesThisRun: queued * MAX_WEB_SEARCHES,
    storage: isKvConfigured() ? "redis" : "memory",
    note: "Each city searches in its own function; cities refreshed in the last 20 hours are skipped.",
    cities,
  });
}
