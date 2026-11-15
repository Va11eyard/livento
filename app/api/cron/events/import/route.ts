import { apiError, json, readJson } from "@/lib/http";
import { importWebEvents } from "@/lib/webEvents";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/cron/events/import — operator-only (Bearer CRON_SECRET): adds researched real
 * events, each with its own official page and picture, to the shared events database.
 * Body: { events: [{ name, category, date, time?, venue?, city, state?, url, image?, priceMin?, priceMax? }] }
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("Unauthorized", 401);
  }
  const body = await readJson(request, 512 * 1024);
  const events = body.ok && typeof body.data === "object" && body.data !== null ? (body.data as { events?: unknown }).events : undefined;
  if (!Array.isArray(events) || events.length === 0 || events.length > 300) {
    return apiError("Send { events: [...] } with 1–300 events.", 400);
  }
  const result = await importWebEvents(events);
  return json({ ok: true, ...result });
}
