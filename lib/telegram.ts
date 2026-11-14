/**
 * Livento Telegram bot building blocks (server-only): Bot API shapes, the callback_data
 * scheme, shared keyboards and the per-chat profile store.
 *
 * Profile store without a database: the bot keeps one pinned "profile card" message in the
 * private chat. The card's "Top picks" button carries the profile payload
 * (lib/telegram-payload, e.g. "pk:p2-9"), and getChat returns the chat's most recent pinned
 * message with its reply_markup, so the profile is read back from Telegram itself. Changes
 * edit the card in place. With KV configured the AlertRecord subscription (daily alerts)
 * is kept in sync, and it is the fallback when no card is found.
 */
import {
  deleteAlert,
  escapeHtml,
  interestsLabel,
  listAlertIds,
  getAlert,
  newAlertId,
  saveAlert,
  telegramCall,
  type AlertRecord,
} from "./alerts";
import { isKvConfigured } from "./kv";
import type { PickTarget } from "./picks";
import { parseTgPayload, tgPayloadFor, type TgPayloadTarget } from "./telegram-payload";
import { CATEGORIES, type Category } from "./types";

export type ChatId = number | string;

export interface TgInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface TgInlineMarkup {
  inline_keyboard: TgInlineButton[][];
}

export interface TgMessage {
  message_id: number;
  date?: number;
  chat?: { id?: ChatId; type?: string };
  from?: { id?: number; is_bot?: boolean };
  via_bot?: unknown;
  text?: string;
  reply_markup?: TgInlineMarkup;
  reply_to_message?: TgMessage;
}

/**
 * callback_data = "<action>" or "<action>:<arg>" (Telegram allows 1-64 bytes; the longest
 * here, "pk:p2s-73", is 9). <payload> is lib/telegram-payload's "p<city>-<interests>".
 */
export const CB = {
  picks: "pk", // "pk" picks for the saved profile · "pk:<payload>" on the profile card (the store)
  profile: "pf", // send the profile view
  changeCity: "cc", // turn this message into the city picker
  changeInterests: "ci", // turn this message into the interests picker for the saved profile
  city: "c", // "c:<city index, base 36>" a city button
  otherCity: "co", // ask the user to type a city (force reply)
  toggle: "t", // "t:<payload after the toggle>" (only the keyboard is re-rendered)
  done: "d", // "d:<payload>" save the interests
  quote: "q", // "q:<shown quote index>" another quote (/quote message)
  profileQuote: "pq", // "pq:<shown quote index>" new quote inside the profile view
} as const;

// ---------------------------------------------------------------------------
// Shared text and buttons
// ---------------------------------------------------------------------------

export function placeLabel(t: Pick<PickTarget, "city" | "stateCode">): string {
  return t.stateCode ? `${t.city}, ${t.stateCode}` : t.city;
}

export function interestsText(interests: readonly Category[]): string {
  return interests.length === 0 || interests.length === CATEGORIES.length
    ? "All kinds of events"
    : interestsLabel([...interests]);
}

/** "Chicago, IL · Concerts, Comedy" */
export function profileLine(t: PickTarget): string {
  return `${placeLabel(t)} · ${interestsText(t.interests)}`;
}

/**
 * "Open Livento" as a Mini App button (web_app: private chats only, HTTPS only), opening
 * onboarding prefilled with the profile when there is one. On an http origin it falls back to
 * a plain link, and to no button on a local host (Telegram rejects both of those otherwise).
 */
export function openLiventoButton(site: string, payload: string | null, text = "Open Livento"): TgInlineButton | null {
  const url = payload ? `${site}/onboarding?tg=${encodeURIComponent(payload)}` : `${site}/`;
  if (url.startsWith("https://")) return { text, web_app: { url } };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return host.includes(".") && !/^[\d.]+$/.test(host) ? { text, url } : null;
}

/** An inline keyboard without the buttons that aren't available (null) or empty rows. */
export function keyboard(rows: (TgInlineButton | null)[][]): TgInlineMarkup {
  return {
    inline_keyboard: rows
      .map((row) => row.filter((b): b is TgInlineButton => b !== null))
      .filter((row) => row.length > 0),
  };
}

function profileCardText(t: PickTarget): string {
  return [
    `<b>Your Livento profile:</b> ${escapeHtml(profileLine(t))}`,
    "",
    "Pinned so the bot remembers you. /profile to change it, /stop to remove it.",
  ].join("\n");
}

function profileCardKeyboard(payload: string, site: string): TgInlineMarkup {
  return keyboard([
    [
      { text: "🎟 Top picks", callback_data: `${CB.picks}:${payload}` },
      { text: "⚙️ Profile", callback_data: CB.profile },
    ],
    [openLiventoButton(site, payload)],
  ]);
}

// ---------------------------------------------------------------------------
// KV subscription (daily alerts), only when storage is configured
// ---------------------------------------------------------------------------

/** The stored Telegram subscriptions of one chat. */
export async function alertsForChat(chatId: ChatId): Promise<AlertRecord[]> {
  if (!isKvConfigured()) return [];
  const out: AlertRecord[] = [];
  for (const id of await listAlertIds()) {
    const rec = await getAlert(id);
    if (rec && rec.channel === "telegram" && String(rec.chatId) === String(chatId)) out.push(rec);
  }
  return out;
}

/** Create or update this chat's subscription so the daily job can send new matches (KV only). */
export async function subscribeChat(chatId: ChatId, target: PickTarget): Promise<AlertRecord | null> {
  if (!isKvConfigured()) return null;
  const [existing, ...duplicates] = await alertsForChat(chatId);
  for (const dup of duplicates) await deleteAlert(dup.id);
  const { city, stateCode, interests, favourites } = target;
  const rec: AlertRecord = existing
    ? { ...existing, city, stateCode, interests, favourites }
    : {
        id: newAlertId(),
        channel: "telegram",
        chatId,
        city,
        stateCode,
        interests,
        favourites,
        createdAt: new Date().toISOString(),
        lastSentAt: null,
        sentIds: [],
      };
  await saveAlert(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// Profile store: the pinned card
// ---------------------------------------------------------------------------

export interface ChatProfile extends PickTarget {
  /** Null only for a KV subscription whose city isn't in US_CITIES. */
  payload: string | null;
  /** The pinned card, when there is one. */
  cardMessageId: number | null;
}

/** A pick target from a payload; no interests selected means every category. */
export function targetFromPayload(t: TgPayloadTarget, favourites: string[] = []): PickTarget {
  return {
    city: t.city.name,
    stateCode: t.city.state,
    interests: t.interests.length ? t.interests : [...CATEGORIES],
    favourites,
  };
}

/** The pinned profile card of a chat: a bot message whose "pk:<payload>" button parses. */
async function findProfileCard(chatId: ChatId): Promise<{ messageId: number; target: TgPayloadTarget } | null> {
  const res = await telegramCall<{ pinned_message?: TgMessage }>("getChat", { chat_id: chatId });
  const pinned = res.ok ? res.result?.pinned_message : undefined;
  if (!pinned || typeof pinned.message_id !== "number" || pinned.from?.is_bot === false || pinned.via_bot) return null;
  for (const row of pinned.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) {
      const data = button.callback_data ?? "";
      if (!data.startsWith(`${CB.picks}:`)) continue;
      const target = parseTgPayload(data.slice(CB.picks.length + 1));
      if (target) return { messageId: pinned.message_id, target };
    }
  }
  return null;
}

/** This chat's Livento profile: the pinned card first, else the KV subscription; null if none. */
export async function getChatProfile(chatId: ChatId): Promise<ChatProfile | null> {
  const card = await findProfileCard(chatId);
  if (card) return { ...targetFromPayload(card.target), payload: card.target.payload, cardMessageId: card.messageId };
  const [rec] = await alertsForChat(chatId);
  if (!rec) return null;
  const { city, stateCode, interests, favourites } = rec;
  return {
    city,
    stateCode,
    interests,
    favourites,
    payload: tgPayloadFor(city, stateCode, interests),
    cardMessageId: null,
  };
}

export interface SavedProfile extends ChatProfile {
  /** True when a new card was pinned (first save); false when the existing card was edited. */
  created: boolean;
}

/**
 * Saves the profile: edits the pinned card in place, or pins a new one (turning
 * `reuseMessageId`, e.g. the onboarding message, into the card when given). With KV it also
 * creates or updates the daily-alert subscription. Null when nothing could be stored.
 */
export async function saveChatProfile(
  chatId: ChatId,
  target: PickTarget,
  site: string,
  reuseMessageId?: number,
): Promise<SavedProfile | null> {
  const payload = tgPayloadFor(target.city, target.stateCode, target.interests);
  let cardMessageId: number | null = null;
  let created = false;
  if (payload) {
    const card = {
      text: profileCardText(target),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: profileCardKeyboard(payload, site),
    };
    const existing = await findProfileCard(chatId);
    const editId = existing?.messageId ?? reuseMessageId;
    if (editId !== undefined) {
      const res = await telegramCall("editMessageText", { chat_id: chatId, message_id: editId, ...card });
      if (res.ok || /not modified/i.test(res.description ?? "")) {
        cardMessageId = editId;
        created = !existing;
      }
    }
    if (cardMessageId === null) {
      const sent = await telegramCall<TgMessage>("sendMessage", { chat_id: chatId, ...card });
      if (sent.ok && sent.result) {
        cardMessageId = sent.result.message_id;
        created = true;
      }
    }
    if (created && cardMessageId !== null) {
      const pin = await telegramCall("pinChatMessage", {
        chat_id: chatId,
        message_id: cardMessageId,
        disable_notification: true,
      });
      if (!pin.ok) cardMessageId = null;
    }
  }
  const record = await subscribeChat(chatId, target);
  if (cardMessageId === null && !record) return null;
  return { ...target, payload, cardMessageId, created };
}

/**
 * /stop: unpins the card (and strips its payload so it can't be read back), and deletes
 * the KV subscription. Returns how many cards and subscriptions were removed.
 */
export async function clearChatProfile(chatId: ChatId): Promise<{ cards: number; alerts: number }> {
  let cards = 0;
  // A few rounds in case older cards are still pinned underneath.
  for (let round = 0; round < 3; round++) {
    const card = await findProfileCard(chatId);
    if (!card) break;
    await telegramCall("editMessageText", {
      chat_id: chatId,
      message_id: card.messageId,
      text: `Livento profile removed (${escapeHtml(profileLine(targetFromPayload(card.target)))}). Send /start to set it up again.`,
      parse_mode: "HTML",
    });
    const unpinned = await telegramCall("unpinChatMessage", { chat_id: chatId, message_id: card.messageId });
    cards++;
    if (!unpinned.ok) break;
  }
  const records = await alertsForChat(chatId);
  for (const rec of records) await deleteAlert(rec.id);
  return { cards, alerts: records.length };
}
