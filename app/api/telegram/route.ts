import {
  deleteAlert,
  getAlert,
  interestsLabel,
  listAlertIds,
  newAlertId,
  parseStatelessStart,
  picksTelegram,
  saveAlert,
  sendTelegram,
  telegramConfigured,
  type AlertRecord,
} from "@/lib/alerts";
import { apiError, json, readJson, siteOrigin } from "@/lib/http";
import { isKvConfigured } from "@/lib/kv";
import { topPicksFor, type PickTarget } from "@/lib/picks";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

interface TelegramUpdate {
  message?: { text?: unknown; chat?: { id?: unknown } };
  edited_message?: { text?: unknown; chat?: { id?: unknown } };
}

type ChatId = number | string;

/** The stored Telegram subscriptions of one chat (needs storage). */
async function alertsForChat(chatId: ChatId): Promise<AlertRecord[]> {
  if (!isKvConfigured()) return [];
  const out: AlertRecord[] = [];
  for (const id of await listAlertIds()) {
    const rec = await getAlert(id);
    if (rec && rec.channel === "telegram" && String(rec.chatId) === String(chatId)) out.push(rec);
  }
  return out;
}

/** Create or update this chat's subscription so the daily job can send new matches. */
async function subscribeChat(chatId: ChatId, target: PickTarget): Promise<AlertRecord | null> {
  if (!isKvConfigured()) return null;
  const [existing, ...duplicates] = await alertsForChat(chatId);
  for (const dup of duplicates) await deleteAlert(dup.id);
  const rec: AlertRecord = existing
    ? { ...existing, ...target }
    : {
        id: newAlertId(),
        channel: "telegram",
        chatId,
        ...target,
        createdAt: new Date().toISOString(),
        lastSentAt: null,
        sentIds: [],
      };
  await saveAlert(rec);
  return rec;
}

/** Send the current top picks for a subscription, then remember what was sent. */
async function sendPicks(chatId: ChatId, target: PickTarget, site: string, rec: AlertRecord | null) {
  const picks = await topPicksFor(target, 3, rec?.sentIds ?? []);
  const where = `${target.city}${target.stateCode ? `, ${target.stateCode}` : ""}`;
  if (picks.length === 0) {
    await sendTelegram(
      chatId,
      `No new upcoming events match ${interestsLabel(target.interests).toLowerCase()} near ${where} right now. Add more interests on Livento: ${site}/onboarding`,
    );
    return;
  }
  const footer = rec
    ? "You'll also get new matches here once a day. /picks for fresh picks · /stop to unsubscribe."
    : `See everything and plan it on Livento: ${site}/discover`;
  const sent = await sendTelegram(chatId, picksTelegram(`Top picks near ${where} right now`, picks, site, footer));
  if (sent && rec) {
    rec.sentIds = [...picks.map((e) => e.id), ...rec.sentIds].slice(0, 300);
    rec.lastSentAt = new Date().toISOString();
    await saveAlert(rec);
  }
}

function helpText(site: string): string {
  return [
    "<b>Livento</b> finds concerts, shows and trips near you, with the full cost.",
    "",
    `To connect: open ${site}/discover and tap <b>Alerts on Telegram</b>.`,
    "",
    "/picks — your current top picks",
    "/stop — stop alerts",
  ].join("\n");
}

/**
 * POST /api/telegram — Telegram webhook.
 * - `/start p<city>-<interests>`: answers right away with the current top picks (works without storage);
 *   with storage it also subscribes the chat to daily alerts.
 * - `/start <alertId>`: links a chat to a subscription created on the site (storage), then sends picks.
 * - `/picks`, `/stop`, anything else → help.
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
  if (!body.ok) return json({ ok: true });
  const update = body.data as TelegramUpdate;
  const message = update.message ?? update.edited_message;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const chatId = message?.chat?.id;
  if (!text || (typeof chatId !== "number" && typeof chatId !== "string")) return json({ ok: true });
  const site = siteOrigin(request);

  try {
    if (/^\/start\b/.test(text)) {
      const payload = text.split(/\s+/)[1] ?? "";
      const stateless = parseStatelessStart(payload);
      const stored = !stateless && payload && isKvConfigured() ? await getAlert(payload) : null;

      if (stateless) {
        const rec = await subscribeChat(chatId, stateless);
        await sendPicks(chatId, stateless, site, rec);
      } else if (stored && stored.channel === "telegram") {
        stored.chatId = chatId;
        await saveAlert(stored);
        await sendPicks(chatId, stored, site, stored);
      } else {
        await sendTelegram(chatId, helpText(site));
      }
    } else if (/^\/picks\b/.test(text)) {
      const [rec] = await alertsForChat(chatId);
      if (rec) await sendPicks(chatId, rec, site, rec);
      else await sendTelegram(chatId, helpText(site));
    } else if (/^\/stop\b/.test(text)) {
      const recs = await alertsForChat(chatId);
      for (const rec of recs) await deleteAlert(rec.id);
      await sendTelegram(
        chatId,
        recs.length ? "You're unsubscribed from Livento alerts." : "You have no Livento alerts to stop.",
      );
    } else {
      await sendTelegram(chatId, helpText(site));
    }
  } catch {
    console.warn("[telegram] webhook handling failed");
  }
  return json({ ok: true });
}
