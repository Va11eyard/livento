import { after } from "next/server";
import { telegramConfigured } from "@/lib/alerts";
import { apiError, json, readJson, siteOrigin } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { handleTelegramUpdate, type TelegramUpdate } from "@/lib/telegram-bot";

export const dynamic = "force-dynamic";
// Replies run after the 200 (see below); Ask Livento answers can take up to ~25 s.
export const maxDuration = 60;

/**
 * POST /api/telegram — Telegram webhook (setup: scripts/telegram-setup.mjs).
 * Handles `message` and `callback_query` updates; the conversation lives in lib/telegram-bot.
 * The chat's profile is a pinned card in the chat itself (lib/telegram), so it works without
 * storage; with KV the daily-alert subscription is kept in sync.
 * Always answers 200 to Telegram (except a bad secret) so updates aren't retried forever.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "telegram", RATE_LIMITS.webhook);
  if (limited) return limited;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return apiError("Unauthorized", 401);
  }
  if (!telegramConfigured()) return json({ ok: true });

  const body = await readJson(request, 64 * 1024);
  if (!body.ok || typeof body.data !== "object" || body.data === null) return json({ ok: true });
  const update = body.data as TelegramUpdate;
  const site = siteOrigin(request);
  // Answer Telegram right away and reply afterwards, so a slow AI answer never makes Telegram
  // time out and resend the same update.
  after(async () => {
    try {
      await handleTelegramUpdate(update, site);
    } catch {
      console.warn("[telegram] webhook handling failed");
    }
  });
  return json({ ok: true });
}
