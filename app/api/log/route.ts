import { todayISO } from "@/lib/dates";
import { apiError, json, parseBody } from "@/lib/http";
import { kvLpush } from "@/lib/kv";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { LogRequestSchema } from "@/lib/schemas";

const NINETY_DAYS = 90 * 24 * 60 * 60;

/** POST /api/log — anonymous interaction log (FR-14): `ix:<YYYY-MM-DD>` list, 90-day TTL. */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "log", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, LogRequestSchema, 4 * 1024);
  if (!body.ok) return body.response;
  try {
    const { anonId, eventId, action } = body.data;
    await kvLpush(`ix:${todayISO()}`, { anonId, eventId, action, at: new Date().toISOString() }, NINETY_DAYS);
    return json({ ok: true });
  } catch {
    return apiError("Logging is unavailable right now.", 503);
  }
}
