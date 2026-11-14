import {
  deleteAlert,
  escapeHtml,
  getAlert,
  interestsLabel,
  listAlertIds,
  saveAlert,
  sendTelegram,
  telegramConfigured,
} from "@/lib/alerts";
import { apiError, json, readJson } from "@/lib/http";
import { isKvConfigured } from "@/lib/kv";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

interface TelegramUpdate {
  message?: { text?: unknown; chat?: { id?: unknown } };
  edited_message?: { text?: unknown; chat?: { id?: unknown } };
}

/**
 * POST /api/telegram — Telegram webhook. `/start <alertId>` links a chat to an
 * alert, `/stop` removes that chat's alerts. Always answers 200 to Telegram
 * (except a bad secret) so updates aren't retried forever.
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
  if (!body.ok) return json({ ok: true });
  const update = body.data as TelegramUpdate;
  const message = update.message ?? update.edited_message;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const chatId = message?.chat?.id;
  if (!text || (typeof chatId !== "number" && typeof chatId !== "string")) return json({ ok: true });

  try {
    if (/^\/start\b/.test(text)) {
      const payload = text.split(/\s+/)[1];
      const rec = payload && isKvConfigured() ? await getAlert(payload) : null;
      if (rec && rec.channel === "telegram") {
        rec.chatId = chatId;
        await saveAlert(rec);
        await sendTelegram(
          chatId,
          `You're subscribed to Livento alerts for <b>${escapeHtml(rec.city)}</b> (${escapeHtml(interestsLabel(rec.interests))}). You'll get up to 3 new matching events a day. Send /stop to unsubscribe.`,
        );
      } else {
        await sendTelegram(
          chatId,
          "Hi! To connect alerts, open Livento, choose Telegram alerts and tap the link there.",
        );
      }
    } else if (/^\/stop\b/.test(text)) {
      if (isKvConfigured()) {
        for (const id of await listAlertIds()) {
          const rec = await getAlert(id);
          if (rec && String(rec.chatId) === String(chatId)) await deleteAlert(id);
        }
      }
      await sendTelegram(chatId, "You're unsubscribed from Livento alerts.");
    } else {
      await sendTelegram(chatId, "Livento sends event alerts here. Send /stop to unsubscribe.");
    }
  } catch {
    console.warn("[telegram] webhook handling failed");
  }
  return json({ ok: true });
}
