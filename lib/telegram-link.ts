/**
 * Telegram ↔ website link (server-only), without accounts or a database.
 *
 * - Chat token "<chat id>.<mac>": mac = base64url(HMAC-SHA256(key = TELEGRAM_BOT_TOKEN,
 *   "livento-tg-link:<chat id>")) cut to 32 characters. The bot puts it in its
 *   "✓ Show on Livento" button (/profile?tg_link=<token>); the site keeps it in localStorage
 *   and sends it back in POST bodies to /api/telegram/link. Holding it only lets you send that
 *   chat its picks or disconnect it. It is derived from the chat id, so it can't be revoked
 *   one by one (rotating the bot token invalidates all of them).
 * - Mini App: verifyWebAppInitData() checks Telegram.WebApp.initData (the page gets it in the
 *   #tgWebAppData hash) as https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * - Pending links (storage only): "Connect Telegram" creates a random link id that rides in the
 *   /start payload ("p2-9_<id>"); the bot marks it linked and the site polls for it, so the
 *   site notices the link without the button.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isKvConfigured, kvDel, kvGet, kvSet } from "./kv";

const MAC_CHARS = 32;
const CHAT_ID = /^[1-9]\d{0,19}$/;
const TOKEN = /^([1-9]\d{0,19})\.([A-Za-z0-9_-]{32})$/;

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function linkMac(chatId: string, key: string): string {
  return createHmac("sha256", key).update(`livento-tg-link:${chatId}`).digest("base64url").slice(0, MAC_CHARS);
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The link token of a private chat; null without a bot token or for a non-user chat id. */
export function tgLinkToken(chatId: number | string): string | null {
  const key = botToken();
  const id = String(chatId);
  if (!key || !CHAT_ID.test(id)) return null;
  return `${id}.${linkMac(id, key)}`;
}

/** The chat id a token was issued for, or null when it doesn't verify. */
export function verifyTgLinkToken(token: unknown): number | null {
  const key = botToken();
  if (!key || typeof token !== "string") return null;
  const match = TOKEN.exec(token.trim());
  if (!match || !sameBytes(Buffer.from(linkMac(match[1], key)), Buffer.from(match[2]))) return null;
  const chatId = Number(match[1]);
  return Number.isSafeInteger(chatId) ? chatId : null;
}

// ---------------------------------------------------------------------------
// Mini App init data
// ---------------------------------------------------------------------------

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  username?: string;
}

const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;
const CLOCK_SKEW_S = 5 * 60;

const optionalText = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Checks Telegram.WebApp.initData: secret_key = HMAC_SHA256(key "WebAppData", bot token);
 * hash must equal hex(HMAC_SHA256(secret_key, data_check_string)), where data_check_string is
 * every received field except hash, sorted by name, as "name=value" lines. Rejects an
 * auth_date older than 24 h. Returns the Telegram user, or null.
 */
export function verifyWebAppInitData(initData: unknown, nowMs = Date.now()): TelegramWebAppUser | null {
  const key = botToken();
  if (!key || typeof initData !== "string" || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  const dataCheckString = [...params.entries()]
    .filter(([name]) => name !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(key).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  if (!sameBytes(expected, Buffer.from(hash, "hex"))) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(nowMs / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || now - authDate > INIT_DATA_MAX_AGE_S || authDate - now > CLOCK_SKEW_S) {
    return null;
  }
  let user: unknown;
  try {
    user = JSON.parse(params.get("user") ?? "");
  } catch {
    return null;
  }
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  if (typeof u.id !== "number" || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
  return { id: u.id, first_name: optionalText(u.first_name, 64), username: optionalText(u.username, 32) };
}

// ---------------------------------------------------------------------------
// Pending links: the site notices the link by itself (storage only)
// ---------------------------------------------------------------------------

export const LINK_ID_PATTERN = /^[0-9a-f]{20}$/;
const PENDING_TTL_S = 15 * 60;
const linkKey = (linkId: string) => `tglink:${linkId}`;

type StoredLink =
  | { status: "pending"; createdAt: string }
  | { status: "linked"; token: string; name?: string; username?: string; linkedAt: string };

export type LinkStatus =
  | { status: "pending" | "expired" }
  | { status: "linked"; token: string; name?: string; username?: string };

/**
 * Pending links need a store every server instance shares: KV. `next dev` is a single process,
 * so there lib/kv's in-memory fallback works too (that is how it is tested locally).
 */
export function pendingLinksAvailable(): boolean {
  return isKvConfigured() || process.env.NODE_ENV === "development";
}

/** A new pending link id (kept ~15 minutes), or null without storage. */
async function createPendingLink(): Promise<string | null> {
  if (!pendingLinksAvailable()) return null;
  const linkId = randomBytes(10).toString("hex");
  try {
    await kvSet(linkKey(linkId), { status: "pending", createdAt: new Date().toISOString() } satisfies StoredLink, PENDING_TTL_S);
    return linkId;
  } catch {
    return null;
  }
}

/**
 * The /start parameter for "Connect Telegram": with storage "<base>_<new link id>" (e.g.
 * "p2-9_<id>"; Telegram allows 64 characters of [A-Za-z0-9_-]) plus the id the site polls;
 * otherwise just the base.
 */
export async function startWithPendingLink(base: string): Promise<{ arg: string; linkId?: string }> {
  if (base.length + 21 > 64) return { arg: base };
  const linkId = await createPendingLink();
  return linkId ? { arg: `${base}_${linkId}`, linkId } : { arg: base };
}

/** "p2-9_<id>" → { base: "p2-9", linkId }; any other /start parameter → { base: arg, linkId: null }. */
export function splitStartArg(arg: string): { base: string; linkId: string | null } {
  const match = /^(.*)_([0-9a-f]{20})$/.exec(arg);
  return match ? { base: match[1], linkId: match[2] } : { base: arg, linkId: null };
}

/** The bot got /start with a link id: mark it linked to this chat (only while it is pending). */
export async function completePendingLink(
  linkId: string,
  chatId: number | string,
  who: { name?: string; username?: string },
): Promise<boolean> {
  const token = tgLinkToken(chatId);
  if (!token || !LINK_ID_PATTERN.test(linkId) || !pendingLinksAvailable()) return false;
  try {
    const current = await kvGet<StoredLink>(linkKey(linkId));
    if (current?.status !== "pending") return false;
    const linked: StoredLink = {
      status: "linked",
      token,
      name: optionalText(who.name, 64),
      username: optionalText(who.username, 32),
      linkedAt: new Date().toISOString(),
    };
    await kvSet(linkKey(linkId), linked, PENDING_TTL_S);
    return true;
  } catch {
    return false;
  }
}

/** Status for the site's poll. A linked result is handed out once. Storage errors throw. */
export async function readPendingLink(linkId: string): Promise<LinkStatus> {
  if (!LINK_ID_PATTERN.test(linkId) || !pendingLinksAvailable()) return { status: "expired" };
  const current = await kvGet<StoredLink>(linkKey(linkId));
  if (!current || (current.status !== "pending" && current.status !== "linked")) return { status: "expired" };
  if (current.status === "pending") return { status: "pending" };
  if (!verifyTgLinkToken(current.token)) return { status: "expired" };
  await kvDel(linkKey(linkId)).catch(() => undefined);
  return { status: "linked", token: current.token, name: current.name, username: current.username };
}
