import { telegramConfigured } from "@/lib/alerts";
import { apiError, json, parseBody, siteOrigin } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { TelegramLinkSchema } from "@/lib/schemas";
import { getChatIdentity } from "@/lib/telegram";
import { disconnectFromSite, sendPicksFromSite } from "@/lib/telegram-bot";
import { readPendingLink, tgLinkToken, verifyTgLinkToken, verifyWebAppInitData } from "@/lib/telegram-link";
import { CATEGORIES, type TelegramLinkResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
// "picks" searches events before it sends.
export const maxDuration = 30;

const BAD_TOKEN = "This Telegram link isn't valid anymore. In the bot, send /profile and tap “✓ Show on Livento”.";
const BAD_INIT_DATA = "Telegram couldn't confirm this session. Close Livento and open it again from the bot.";
const UNREACHABLE =
  "Telegram says the bot can't reach this chat (blocked or deleted). Open the bot, tap Start, then try again.";
const TELEGRAM_DOWN = "Couldn't reach Telegram right now. Please try again.";

function botUsername(): string | undefined {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return bot && /^[A-Za-z0-9_]{1,32}$/.test(bot) ? bot : undefined;
}

/**
 * POST /api/telegram/link — the website side of the Telegram link (lib/telegram-link).
 * - link: { token } (from ?tg_link=) or { initData } (Mini App) → { ok, token, name, username?, bot }
 * - picks: { token, profile? } → sends the top picks to the chat (site profile, else the chat's own)
 * - unlink: { token } → removes the chat's pinned profile and says so in the chat
 * - status: { linkId } → pending / linked (+ token, once) / expired, for Connect Telegram with storage
 * 401 for a token or initData that doesn't verify; 503 when the bot isn't configured.
 * Never returns or logs the bot token.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "telegram-link", RATE_LIMITS.general);
  if (limited) return limited;
  if (!telegramConfigured()) return apiError("Telegram isn't set up on this deployment yet.", 503);
  const body = await parseBody(request, TelegramLinkSchema, 8 * 1024);
  if (!body.ok) return body.response;
  const req = body.data;
  const bot = botUsername();

  if (req.action === "status") {
    if (!req.linkId) return apiError('Invalid request: check "linkId".', 400);
    try {
      const link = await readPendingLink(req.linkId);
      if (link.status !== "linked") return json<TelegramLinkResponse>({ ok: true, status: link.status });
      return json<TelegramLinkResponse>({
        ok: true,
        status: "linked",
        token: link.token,
        name: link.name,
        username: link.username,
        bot,
      });
    } catch {
      return apiError("Couldn't check the Telegram link right now. Please try again.", 503);
    }
  }

  // Every other action needs the chat: a link token, or (link only) Mini App init data.
  let chatId: number | null = null;
  if (req.token) {
    chatId = verifyTgLinkToken(req.token);
    if (chatId === null) return apiError(BAD_TOKEN, 401);
  } else if (req.action === "link" && req.initData) {
    chatId = verifyWebAppInitData(req.initData)?.id ?? null;
    if (chatId === null) return apiError(BAD_INIT_DATA, 401);
  } else {
    return apiError('Invalid request: check "token".', 400);
  }

  if (req.action === "link") {
    const token = tgLinkToken(chatId);
    const who = await getChatIdentity(chatId);
    if (!who.ok) {
      return who.unreachable ? json<TelegramLinkResponse>({ ok: false, message: UNREACHABLE }) : apiError(TELEGRAM_DOWN, 502);
    }
    if (!token) return apiError(TELEGRAM_DOWN, 502);
    return json<TelegramLinkResponse>({ ok: true, token, name: who.name, username: who.username, bot });
  }

  if (req.action === "picks") {
    const picksLimited = await rateLimit(request, "telegram-picks", RATE_LIMITS.heavy);
    if (picksLimited) return picksLimited;
    const target = req.profile
      ? {
          city: req.profile.city,
          stateCode: req.profile.stateCode?.toUpperCase(),
          interests: req.profile.interests.length ? req.profile.interests : [...CATEGORIES],
          favourites: [],
        }
      : null;
    const result = await sendPicksFromSite(chatId, target, siteOrigin(request));
    if (result === "sent") return json<TelegramLinkResponse>({ ok: true, message: "Sent. Your top picks are in Telegram." });
    return json<TelegramLinkResponse>({
      ok: false,
      message:
        result === "no-profile"
          ? "Add your city on Livento first, then try again."
          : "Telegram didn't take the message. If you blocked the bot, unblock it, send /start and try again.",
    });
  }

  await disconnectFromSite(chatId);
  return json<TelegramLinkResponse>({ ok: true, message: "Disconnected from Telegram." });
}
