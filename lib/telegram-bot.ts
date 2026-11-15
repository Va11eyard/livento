/**
 * Livento Telegram bot conversation (server-only), called by app/api/telegram.
 *
 * Website → bot: /start p<city>-<interests> saves the profile (pinned card) and sends picks.
 * Bot first: /start without a payload → welcome back + picks, or a two-step onboarding
 * (city buttons or typed city, then interest toggles) that ends with picks and "Open Livento".
 * Commands: /picks, /profile, /quote, /stop. Any other text → handleFreeText().
 * Site link: /start replies and the /profile view carry "✓ Show on Livento" (lib/telegram-link);
 * with storage, a "_<link id>" on the /start payload also tells the waiting site directly.
 */
import { findCity, US_CITIES } from "./cities";
import { escapeHtml, getAlert, parseStatelessStart, picksTelegram, saveAlert, sendTelegram, telegramCall } from "./alerts";
import { answerForTelegram } from "./assistant";
import { isKvConfigured } from "./kv";
import { isLlmConfigured } from "./llm";
import { topPicksFor, type PickTarget } from "./picks";
import { randomQuote } from "./quotes";
import {
  alertsForChat,
  CB,
  clearChatProfile,
  getChatProfile,
  interestsText,
  keyboard,
  openLiventoButton,
  placeLabel,
  profileLine,
  saveChatProfile,
  showOnLiventoButton,
  subscribeChat,
  targetFromPayload,
  type ChatId,
  type ChatProfile,
  type TgInlineButton,
  type TgInlineMarkup,
  type TgMessage,
} from "./telegram";
import { completePendingLink, splitStartArg } from "./telegram-link";
import { encodeTgPayload, interestsMask, parseTgPayload, tgPayloadFor } from "./telegram-payload";
import { CATEGORIES, CATEGORY_LABELS, type City } from "./types";

export interface TelegramUpdate {
  message?: TgMessage;
  callback_query?: {
    id?: unknown;
    from?: { id?: number };
    message?: TgMessage;
    data?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Free text: the extension point
// ---------------------------------------------------------------------------

function helpText(hasProfile: boolean): string {
  return [
    "<b>Livento</b> finds concerts, shows, sports and trips near you, with the full cost, so you can save for the ones you love.",
    "",
    hasProfile ? "Your profile is pinned at the top of this chat." : "Send /start to set your city and interests.",
    "",
    "/picks — top picks near you",
    "/profile — your profile and a quote",
    "/quote — a little motivation",
    "/stop — remove your profile and alerts",
  ].join("\n");
}

/**
 * The reply (Telegram HTML) to any text that isn't a command or a typed city: Ask Livento
 * (lib/assistant) answers with numbers from Livento's calculators and links from its tools.
 * Without an AI key, or for a one-word message, the help text. `profile` is null until the chat has one.
 */
export async function handleFreeText(chatId: ChatId, text: string, profile: ChatProfile | null): Promise<string> {
  const question = text.trim();
  if (!isLlmConfigured() || question.length < 3) return helpText(profile !== null);
  void telegramCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  const answer = await answerForTelegram(
    question,
    profile
      ? { city: profile.city, stateCode: profile.stateCode, interests: profile.interests, favourites: profile.favourites }
      : null,
  );
  if (answer.status === "off") return helpText(profile !== null);
  const links = answer.actions
    .filter((a) => /^https:\/\//.test(a.href))
    .map((a) => `• <a href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`)
    .join("\n");
  return [
    escapeHtml(answer.text),
    links,
    "<i>Ask Livento · AI helper · numbers from Livento's calculators · not financial advice</i>",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Messages and keyboards
// ---------------------------------------------------------------------------

const POPULAR_CITIES = [
  "New York",
  "Los Angeles",
  "Chicago",
  "Houston",
  "Austin",
  "Dallas",
  "San Francisco",
  "Seattle",
  "Denver",
  "Boston",
  "Nashville",
  "Miami",
]
  .map((name) => US_CITIES.findIndex((c) => c.name === name))
  .filter((i) => i >= 0);

/** Plain text (no tags): replies are recognised by it (reply_to_message.text has no HTML). */
const CITY_PROMPT = "Type your city (US), for example: Denver or St. Louis, MO";

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

/** The city buttons; with `site` (onboarding) also "Open Livento" for people who'd rather use the app. */
function cityKeyboard(site?: string): TgInlineMarkup {
  const rows: (TgInlineButton | null)[][] = [];
  POPULAR_CITIES.forEach((index, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: US_CITIES[index].name, callback_data: `${CB.city}:${index.toString(36)}` });
  });
  rows.push([{ text: "Other — type your city", callback_data: CB.otherCity }]);
  if (site) rows.push([openLiventoButton(site, null)]);
  return keyboard(rows);
}

function cityPickerText(profile: ChatProfile | null): string {
  if (profile) return `<b>Change city</b>\nNow: ${escapeHtml(placeLabel(profile))}. Where are you based?`;
  return [
    "<b>Welcome to Livento!</b> I find concerts, shows, sports and trips near you, with the full cost, and send your top picks right here.",
    "",
    "<b>Step 1 of 2.</b> Where are you based?",
  ].join("\n");
}

function interestsKeyboard(cityIndex: number, mask: number): TgInlineMarkup {
  const rows: TgInlineMarkup["inline_keyboard"] = [];
  CATEGORIES.forEach((category, i) => {
    if (i % 2 === 0) rows.push([]);
    const on = (mask & (1 << i)) !== 0;
    rows[rows.length - 1].push({
      text: `${on ? "✓ " : ""}${CATEGORY_LABELS[category]}`,
      callback_data: `${CB.toggle}:${encodeTgPayload(cityIndex, mask ^ (1 << i))}`,
    });
  });
  rows.push([{ text: "Done", callback_data: `${CB.done}:${encodeTgPayload(cityIndex, mask)}` }]);
  return { inline_keyboard: rows };
}

function interestsPickerText(city: City, onboarding: boolean): string {
  const where = escapeHtml(`${city.name}, ${city.state}`);
  return onboarding
    ? `<b>Step 2 of 2.</b> What are you into?\n📍 ${where}\nTap everything you like, then Done.`
    : `<b>Change interests</b>\n📍 ${where}\nTap to switch them on or off, then Done.`;
}

function profileView(chatId: ChatId, profile: PickTarget & { payload: string | null }, site: string, excludeQuote?: number) {
  const quote = randomQuote(excludeQuote);
  const text = [
    "<b>Your Livento profile</b>",
    `📍 ${escapeHtml(placeLabel(profile))}`,
    `🎟 ${escapeHtml(interestsText(profile.interests))}`,
    "",
    `<i>${escapeHtml(quote.text)}</i>`,
    "",
    "Open Livento to add your budget and favourites.",
  ].join("\n");
  const reply_markup = keyboard([
    [{ text: "🎟 Top picks", callback_data: CB.picks }],
    [
      { text: "📍 Change city", callback_data: CB.changeCity },
      { text: "✨ Change interests", callback_data: CB.changeInterests },
    ],
    [{ text: "💬 New quote", callback_data: `${CB.profileQuote}:${quote.index}` }],
    [openLiventoButton(site, profile.payload)],
    [showOnLiventoButton(site, chatId)],
  ]);
  return { text, reply_markup };
}

const shownQuote = (arg: string) => (/^\d{1,3}$/.test(arg) ? Number(arg) : undefined);

function quoteView(excludeQuote?: number) {
  const quote = randomQuote(excludeQuote);
  return {
    text: `💬 <i>${escapeHtml(quote.text)}</i>`,
    reply_markup: { inline_keyboard: [[{ text: "Another one", callback_data: `${CB.quote}:${quote.index}` }]] },
  };
}

/** Edits a message when there is one to edit (falling back to a new message), else sends one. */
async function show(chatId: ChatId, messageId: number | null, text: string, reply_markup?: TgInlineMarkup) {
  if (messageId !== null) {
    const res = await telegramCall("editMessageText", { chat_id: chatId, message_id: messageId, text, ...HTML, reply_markup });
    if (res.ok || /not modified/i.test(res.description ?? "")) return;
  }
  await sendTelegram(chatId, text, reply_markup ? { reply_markup } : {});
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * Sends the current top picks (KV: skips what was already sent and remembers the new ones).
 * `withLink` adds "✓ Show on Livento" (after /start and onboarding). False when Telegram refused.
 */
async function sendPicks(chatId: ChatId, target: PickTarget, site: string, intro?: string, withLink = false): Promise<boolean> {
  // With KV, a profile always has a daily-alert subscription (e.g. after storage was added later).
  const rec = (await alertsForChat(chatId))[0] ?? (await subscribeChat(chatId, target));
  const picks = await topPicksFor(target, 3, rec?.sentIds ?? []);
  const payload = tgPayloadFor(target.city, target.stateCode, target.interests);
  const reply_markup = keyboard([
    [openLiventoButton(site, payload)],
    withLink ? [showOnLiventoButton(site, chatId)] : [],
    [{ text: "⚙️ Your profile", callback_data: CB.profile }],
  ]);
  const lead = intro ? `${intro}\n\n` : "";
  if (picks.length === 0) {
    return sendTelegram(
      chatId,
      `${lead}No new upcoming events match ${escapeHtml(interestsText(target.interests).toLowerCase())} near ${escapeHtml(placeLabel(target))} right now. Try more interests in /profile.`,
      { reply_markup },
    );
  }
  const footer = rec
    ? "You'll also get new matches here once a day. /picks for fresh picks · /stop to unsubscribe."
    : "Prices are estimates. Tap an event for its full cost.";
  const html = picksTelegram(`Top picks near ${placeLabel(target)} right now`, picks, site, footer);
  const sent = await sendTelegram(chatId, `${lead}${html}`, { reply_markup });
  if (sent && rec) {
    rec.sentIds = [...picks.map((e) => e.id), ...rec.sentIds].slice(0, 300);
    rec.lastSentAt = new Date().toISOString();
    await saveAlert(rec);
  }
  return sent;
}

async function startOnboarding(chatId: ChatId, site: string, messageId: number | null = null) {
  await show(chatId, messageId, cityPickerText(null), cityKeyboard(site));
}

async function sendProfileView(chatId: ChatId, site: string) {
  const profile = await getChatProfile(chatId);
  if (!profile) return startOnboarding(chatId, site);
  const view = profileView(chatId, profile, site);
  await sendTelegram(chatId, view.text, { reply_markup: view.reply_markup });
}

/** A city was picked (button) or typed: change it on the saved profile, or go to step 2. */
async function chooseCity(chatId: ChatId, cityIndex: number, site: string, messageId: number | null): Promise<string | undefined> {
  const city = US_CITIES[cityIndex];
  if (!city) return "That city isn't available. Pick another one.";
  const profile = await getChatProfile(chatId);
  if (!profile) {
    await show(chatId, messageId, interestsPickerText(city, true), interestsKeyboard(cityIndex, 0));
    return undefined;
  }
  const saved = await saveChatProfile(chatId, { ...profile, city: city.name, stateCode: city.state }, site);
  if (!saved) return "Couldn't save that. Please try again.";
  const view = profileView(chatId, saved, site);
  await show(chatId, messageId, view.text, view.reply_markup);
  return `Saved: ${city.name}, ${city.state}`;
}

async function finishInterests(chatId: ChatId, payload: string, site: string, messageId: number | null) {
  const chosen = parseTgPayload(payload);
  if (!chosen) return "This button is out of date. Send /start.";
  if (chosen.mask === 0) return "Pick at least one interest.";
  const before = await getChatProfile(chatId);
  const target = targetFromPayload(chosen, before?.favourites ?? []);
  // First save: the onboarding message itself becomes the pinned profile card.
  const saved = await saveChatProfile(chatId, target, site, before ? undefined : (messageId ?? undefined));
  if (!saved) return "Couldn't save that. Please try again.";
  if (before) {
    const view = profileView(chatId, saved, site);
    await show(chatId, messageId, view.text, view.reply_markup);
    return "Saved";
  }
  await sendPicks(
    chatId,
    target,
    site,
    "<b>You're all set.</b> Your profile is pinned at the top of this chat. Open Livento to finish it with your budget and favourites.",
    true,
  );
  return "Profile saved";
}

async function startCommand(chatId: ChatId, rawArg: string, site: string, from?: TgMessage["from"]) {
  // "<payload>_<link id>": the site is waiting for this chat (storage only); tell it first.
  const { base: arg, linkId } = splitStartArg(rawArg);
  if (linkId) await completePendingLink(linkId, chatId, { name: from?.first_name, username: from?.username });
  // Website → bot: the deep link carries the profile.
  const fromSite = parseStatelessStart(arg);
  if (fromSite) {
    const saved = await saveChatProfile(chatId, fromSite, site);
    const intro = !saved
      ? undefined
      : saved.created
        ? "<b>Connected.</b> Your Livento profile is pinned at the top of this chat."
        : `<b>Profile updated:</b> ${escapeHtml(profileLine(fromSite))}`;
    await sendPicks(chatId, fromSite, site, intro, true);
    return;
  }
  // A subscription created on the site (storage only).
  const stored = arg && isKvConfigured() ? await getAlert(arg) : null;
  if (stored && stored.channel === "telegram") {
    stored.chatId = chatId;
    await saveAlert(stored);
    await saveChatProfile(chatId, stored, site);
    await sendPicks(chatId, stored, site, "<b>Connected.</b> You'll get new matches here once a day.", true);
    return;
  }
  // Bot first.
  const profile = await getChatProfile(chatId);
  if (profile) await sendPicks(chatId, profile, site, `<b>Welcome back!</b> ${escapeHtml(profileLine(profile))}`, true);
  else await startOnboarding(chatId, site);
}

async function stopCommand(chatId: ChatId) {
  const { cards, alerts } = await clearChatProfile(chatId);
  await sendTelegram(
    chatId,
    cards || alerts
      ? "Done. Your Livento profile is removed and alerts are off. Send /start any time to set it up again."
      : "There's no Livento profile or alert here to stop. Send /start to set one up.",
  );
}

/** A typed city: the reply to the city prompt, or plain text before there's a profile. */
async function cityTyped(chatId: ChatId, text: string, site: string) {
  const city = findCity(text);
  const index = city ? US_CITIES.indexOf(city) : -1;
  if (index < 0) {
    await sendTelegram(
      chatId,
      `I couldn't find “${escapeHtml(text.slice(0, 40))}” among the US cities Livento covers yet. Pick one below or try another spelling.`,
      { reply_markup: cityKeyboard() },
    );
    return;
  }
  await chooseCity(chatId, index, site, null);
}

function isCityPromptReply(msg: TgMessage): boolean {
  const original = msg.reply_to_message;
  return Boolean(original?.from?.is_bot && original.text?.startsWith(CITY_PROMPT.slice(0, 14)));
}

async function onMessage(msg: TgMessage, site: string) {
  const chatId = msg.chat?.id;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if ((typeof chatId !== "number" && typeof chatId !== "string") || !text) return;
  if (msg.chat?.type && msg.chat.type !== "private") {
    if (text.startsWith("/")) await sendTelegram(chatId, "Livento works in a private chat. Open the bot and tap Start.");
    return;
  }

  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  switch (command?.[1].toLowerCase()) {
    case "start":
      return startCommand(chatId, (command?.[2] ?? "").trim().split(/\s+/)[0] ?? "", site, msg.from);
    case "picks": {
      const profile = await getChatProfile(chatId);
      if (profile) await sendPicks(chatId, profile, site);
      else await startOnboarding(chatId, site);
      return;
    }
    case "profile":
      return sendProfileView(chatId, site);
    case "quote": {
      const view = quoteView();
      await sendTelegram(chatId, view.text, { reply_markup: view.reply_markup });
      return;
    }
    case "stop":
      return stopCommand(chatId);
  }

  if (isCityPromptReply(msg)) return cityTyped(chatId, text, site);
  const profile = await getChatProfile(chatId);
  if (!profile && !text.startsWith("/") && findCity(text)) return cityTyped(chatId, text, site);
  await sendTelegram(chatId, await handleFreeText(chatId, text, profile));
}

async function onCallback(query: NonNullable<TelegramUpdate["callback_query"]>, site: string) {
  if (typeof query.id !== "string") return;
  const queryId = query.id;
  let answered = false;
  const answer = async (text?: string) => {
    if (answered) return;
    answered = true;
    await telegramCall("answerCallbackQuery", { callback_query_id: queryId, ...(text ? { text } : {}) });
  };

  try {
    const chatId = query.message?.chat?.id ?? query.from?.id;
    if (typeof chatId !== "number" && typeof chatId !== "string") return;
    if (query.message?.chat?.type && query.message.chat.type !== "private") return;
    // An inaccessible message has date 0; then answers go out as new messages.
    const messageId = query.message?.date && typeof query.message.message_id === "number" ? query.message.message_id : null;
    const data = typeof query.data === "string" ? query.data : "";
    const sep = data.indexOf(":");
    const action = sep < 0 ? data : data.slice(0, sep);
    const arg = sep < 0 ? "" : data.slice(sep + 1);

    switch (action) {
      case CB.picks: {
        await answer("Finding your picks…");
        const fromCard = parseTgPayload(arg);
        const profile = fromCard ? targetFromPayload(fromCard) : await getChatProfile(chatId);
        if (profile) await sendPicks(chatId, profile, site);
        else await startOnboarding(chatId, site);
        return;
      }
      case CB.profile:
        await answer();
        return sendProfileView(chatId, site);
      case CB.changeCity: {
        const profile = await getChatProfile(chatId);
        await show(chatId, messageId, cityPickerText(profile), cityKeyboard());
        return;
      }
      case CB.changeInterests: {
        const profile = await getChatProfile(chatId);
        const parsed = profile?.payload ? parseTgPayload(profile.payload) : null;
        if (!parsed) return startOnboarding(chatId, site, messageId);
        await show(
          chatId,
          messageId,
          interestsPickerText(parsed.city, false),
          interestsKeyboard(parsed.cityIndex, interestsMask(profile?.interests ?? [])),
        );
        return;
      }
      case CB.city: {
        const index = /^[0-9a-z]{1,3}$/.test(arg) ? parseInt(arg, 36) : -1;
        return answer(await chooseCity(chatId, index, site, messageId));
      }
      case CB.otherCity:
        await answer();
        await telegramCall("sendMessage", {
          chat_id: chatId,
          text: CITY_PROMPT,
          reply_markup: { force_reply: true, input_field_placeholder: "Your city, e.g. Denver" },
        });
        return;
      case CB.toggle: {
        const next = parseTgPayload(arg);
        if (!next || messageId === null) return answer("This button is out of date. Send /start.");
        await telegramCall("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: interestsKeyboard(next.cityIndex, next.mask),
        });
        return;
      }
      case CB.done:
        return answer(await finishInterests(chatId, arg, site, messageId));
      case CB.quote: {
        const view = quoteView(shownQuote(arg));
        await show(chatId, messageId, view.text, view.reply_markup);
        return;
      }
      case CB.profileQuote: {
        const profile = await getChatProfile(chatId);
        if (!profile) return startOnboarding(chatId, site, messageId);
        const view = profileView(chatId, profile, site, shownQuote(arg));
        await show(chatId, messageId, view.text, view.reply_markup);
        return;
      }
      default:
        return answer("This button is out of date. Send /start.");
    }
  } finally {
    await answer();
  }
}

// ---------------------------------------------------------------------------
// Actions from the website (app/api/telegram/link)
// ---------------------------------------------------------------------------

/** "Send my picks to Telegram": the site's profile, else the chat's saved one. */
export async function sendPicksFromSite(
  chatId: ChatId,
  target: PickTarget | null,
  site: string,
): Promise<"sent" | "no-profile" | "failed"> {
  const profile = target ?? (await getChatProfile(chatId));
  if (!profile) return "no-profile";
  return (await sendPicks(chatId, profile, site, "<b>Sent from Livento on the web.</b>")) ? "sent" : "failed";
}

/** "Disconnect" on the site: removes the pinned profile (and KV alerts) and says so in the chat. */
export async function disconnectFromSite(chatId: ChatId): Promise<void> {
  await clearChatProfile(chatId);
  await sendTelegram(chatId, "Disconnected from Livento on the web. Send /start to connect again.");
}

/** Handles one webhook update. Errors are caught by the caller, which always answers 200. */
export async function handleTelegramUpdate(update: TelegramUpdate, site: string): Promise<void> {
  if (update.callback_query) return onCallback(update.callback_query, site);
  if (update.message) return onMessage(update.message, site);
}
