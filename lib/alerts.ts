/**
 * Event alerts (FR-5), server-only: subscription records in lib/kv, delivery
 * through the Telegram Bot API and the Resend email API (plain fetch).
 */
import { randomBytes } from "node:crypto";
import { findCity } from "./cities";
import { kvDel, kvGet, kvSadd, kvSet, kvSmembers, kvSrem } from "./kv";
import { formatDate } from "./roadmap";
import { parseTgPayload, tgPayloadFor } from "./telegram-payload";
import { CATEGORIES, CATEGORY_LABELS, type Category, type LiventoEvent, type Profile } from "./types";

export interface AlertRecord {
  id: string;
  channel: "email" | "telegram";
  address?: string;
  chatId?: number | string;
  interests: Category[];
  favourites: string[];
  city: string;
  stateCode?: string;
  createdAt: string;
  lastSentAt: string | null;
  sentIds: string[]; // event ids already sent (newest first), so nothing repeats
}

export const ALERTS_INDEX = "alerts:index";
const alertKey = (id: string) => `alert:${id}`;
const ID_PATTERN = /^[\w-]{8,64}$/;

/** 16 URL-safe chars — valid as a Telegram /start payload. */
export function newAlertId(): string {
  return randomBytes(12).toString("base64url");
}

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_BOT_USERNAME?.trim());
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.ALERTS_FROM_EMAIL?.trim());
}

export function telegramStartUrl(id: string): string {
  const bot = (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
  return `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(id)}`;
}

export async function saveAlert(rec: AlertRecord): Promise<void> {
  await kvSet(alertKey(rec.id), rec);
  await kvSadd(ALERTS_INDEX, rec.id);
}

export async function getAlert(id: string): Promise<AlertRecord | null> {
  if (!ID_PATTERN.test(id)) return null;
  return kvGet<AlertRecord>(alertKey(id));
}

export async function deleteAlert(id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) return;
  await kvDel(alertKey(id));
  await kvSrem(ALERTS_INDEX, id);
}

export async function listAlertIds(): Promise<string[]> {
  return kvSmembers(ALERTS_INDEX);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Bot API origin. TELEGRAM_API_BASE (e.g. http://127.0.0.1:8790 for scripts/telegram-mock.mjs)
 * is honoured outside production only, so the token can't be sent anywhere else in production.
 */
export function telegramApiBase(): string {
  const override = process.env.TELEGRAM_API_BASE?.trim().replace(/\/+$/, "");
  if (override && process.env.NODE_ENV !== "production" && /^https?:\/\//.test(override)) return override;
  return "https://api.telegram.org";
}

export interface TelegramResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** One Bot API call (JSON body). Never throws and never logs the token. */
export async function telegramCall<T = unknown>(method: string, params: Record<string, unknown>): Promise<TelegramResult<T>> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN is not set" };
  try {
    const res = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    const data = (await res.json().catch(() => null)) as TelegramResult<T> | null;
    if (res.ok && data?.ok) return { ok: true, result: data.result };
    const description = typeof data?.description === "string" ? data.description.slice(0, 200) : `HTTP ${res.status}`;
    // "message is not modified" is the normal outcome of re-rendering identical content.
    if (!/not modified/i.test(description)) console.warn(`[telegram] ${method} failed: ${description}`);
    return { ok: false, description };
  } catch {
    console.warn(`[telegram] ${method} request failed`);
    return { ok: false, description: "request failed" };
  }
}

/** Sends an HTML message; extra adds Bot API fields such as reply_markup. */
export async function sendTelegram(
  chatId: number | string,
  html: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const res = await telegramCall("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
  return res.ok;
}

export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.ALERTS_FROM_EMAIL?.trim();
  if (!apiKey || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.warn(`[alerts] resend HTTP ${res.status}`);
    return res.ok;
  } catch {
    console.warn("[alerts] resend request failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export function interestsLabel(interests: Category[]): string {
  return interests.length ? interests.map((c) => CATEGORY_LABELS[c]).join(", ") : "all events";
}

/** The Livento event page (full cost + plan); works in any browser via GET /api/events?id=. */
function eventUrl(e: LiventoEvent, site: string): string {
  return `${site}/event/${encodeURIComponent(e.id)}`;
}

/** The official ticket page, when there is a real one. */
function ticketUrl(e: LiventoEvent): string | undefined {
  return e.source !== "sample" && /^https:\/\//.test(e.url) ? e.url : undefined;
}

function ticketLabel(e: LiventoEvent): string {
  return e.source === "ticketmaster" ? "Tickets on Ticketmaster" : "Official site";
}

/** "Ticketmaster, TheSportsDB": data sources the providers' terms ask us to credit; "" when none. */
function dataCredits(events: LiventoEvent[]): string {
  return [
    events.some((e) => e.source === "ticketmaster") ? "Ticketmaster" : "",
    events.some((e) => e.source === "thesportsdb") ? "TheSportsDB" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function eventFacts(e: LiventoEvent): string {
  const parts = [
    e.date ? formatDate(e.date) : "Date TBA",
    [e.city, e.state].filter(Boolean).join(", "),
    typeof e.priceMin === "number" ? `from $${Math.round(e.priceMin)} face value (fees extra)` : "price TBA",
  ];
  if (e.source === "sample") parts.push("SAMPLE EVENT — not a real listing");
  return parts.join(" · ");
}

/**
 * A Telegram (HTML) message listing events: title, one entry per event with its
 * Livento page and official ticket link, the data attribution and a footer line.
 */
export function picksTelegram(title: string, events: LiventoEvent[], site: string, footer: string): string {
  const lines = events.map((e) => {
    const tickets = ticketUrl(e);
    const ticketsLine = tickets ? `\n  <a href="${escapeHtml(tickets)}">${escapeHtml(ticketLabel(e))}</a>` : "";
    return `• <a href="${escapeHtml(eventUrl(e, site))}">${escapeHtml(e.name)}</a> — full cost on Livento\n  ${escapeHtml(eventFacts(e))}${ticketsLine}`;
  });
  const credits = dataCredits(events);
  const attribution = credits ? `\n\nEvent data: ${credits}.` : "";
  return `<b>${escapeHtml(title)}</b>\n\n${lines.join("\n\n")}${attribution}\n\n${footer}`;
}

export function digestTelegram(rec: AlertRecord, events: LiventoEvent[], site: string): string {
  return picksTelegram(
    `New for you in ${rec.city}`,
    events,
    site,
    "Prices are estimates — check the event page. Send /stop to unsubscribe.",
  );
}

// ---------------------------------------------------------------------------
// Telegram start links that work without storage
// ---------------------------------------------------------------------------

/**
 * A Telegram /start payload that carries the city and interests itself
 * ("p<city index>-<interest bits>", base 36, well under Telegram's 64-char limit),
 * so the bot can answer with picks even when no storage is configured.
 * Null when the city is not in the US_CITIES list.
 */
export function statelessStartPayload(city: string, stateCode: string | undefined, interests: Category[]): string | null {
  return tgPayloadFor(city, stateCode, interests);
}

/** Reads a payload made by statelessStartPayload; null for anything else. */
export function parseStatelessStart(
  payload: string,
): Pick<AlertRecord, "city" | "stateCode" | "interests" | "favourites"> | null {
  const target = parseTgPayload(payload);
  if (!target) return null;
  return {
    city: target.city.name,
    stateCode: target.city.state,
    interests: target.interests.length ? target.interests : [...CATEGORIES],
    favourites: [],
  };
}

export function digestEmail(rec: AlertRecord, events: LiventoEvent[], site: string) {
  const unsubscribe = `${site}/api/alerts?unsubscribe=${encodeURIComponent(rec.id)}`;
  const subject = `Livento: ${events.length} new event${events.length === 1 ? "" : "s"} in ${rec.city}`;
  const items = events
    .map((e) => {
      const tickets = ticketUrl(e);
      const ticketsLink = tickets
        ? ` · <a href="${escapeHtml(tickets)}" style="color:#141414">${escapeHtml(ticketLabel(e))}</a>`
        : "";
      return `<li style="margin:0 0 14px"><a href="${escapeHtml(eventUrl(e, site))}" style="color:#141414;font-weight:600">${escapeHtml(e.name)}</a><br><span style="color:#616161">${escapeHtml(eventFacts(e))}</span><br><a href="${escapeHtml(eventUrl(e, site))}" style="color:#141414">See the full cost on Livento</a>${ticketsLink}</li>`;
    })
    .join("");
  const credits = dataCredits(events);
  const attribution = credits ? `<p>Event data: ${credits}.</p>` : "";
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#141414;max-width:560px">
<h2 style="margin:0 0 12px">New for you in ${escapeHtml(rec.city)}</h2>
<p>Matching your interests: ${escapeHtml(interestsLabel(rec.interests))}.</p>
<ul style="padding-left:18px">${items}</ul>
<p style="color:#616161">Prices are estimates — check the event page before you buy.</p>${attribution}
<p style="color:#616161;font-size:13px">You subscribed to Livento alerts. <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a>.</p>
</div>`;
  const text = `New for you in ${rec.city}\n\n${events
    .map((e) => {
      const tickets = ticketUrl(e);
      return `- ${e.name}\n  ${eventFacts(e)}\n  Full cost: ${eventUrl(e, site)}${tickets ? `\n  ${ticketLabel(e)}: ${tickets}` : ""}`;
    })
    .join("\n\n")}\n\nPrices are estimates — check the event page before you buy.\nUnsubscribe: ${unsubscribe}`;
  return { subject, html, text };
}

export function welcomeEmail(rec: AlertRecord, site: string) {
  const unsubscribe = `${site}/api/alerts?unsubscribe=${encodeURIComponent(rec.id)}`;
  const what = `${interestsLabel(rec.interests)} near ${rec.city}${rec.stateCode ? `, ${rec.stateCode}` : ""}`;
  return {
    subject: "You're subscribed to Livento alerts",
    html: `<div style="font-family:Inter,Arial,sans-serif;color:#141414;max-width:560px">
<h2 style="margin:0 0 12px">You're in.</h2>
<p>Livento will email you up to 3 new matching events a day: ${escapeHtml(what)}.</p>
<p style="color:#616161;font-size:13px">Didn't sign up? <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a> and we won't email you again.</p>
</div>`,
    text: `You're in. Livento will email you up to 3 new matching events a day: ${what}.\n\nUnsubscribe: ${unsubscribe}`,
  };
}

/** A scoring profile built from an alert subscription (no budget data → neutral price factor). */
export function profileFromAlert(rec: AlertRecord): Profile {
  const city = findCity(rec.city, rec.stateCode);
  return {
    version: 1,
    interests: rec.interests,
    favourites: rec.favourites,
    city: rec.city,
    stateCode: rec.stateCode,
    lat: city?.lat,
    lng: city?.lng,
    radiusMiles: 50,
    monthlyFunBudget: 0,
    hotelPerNight: 0,
    travelPerTrip: 0,
    vacationDaysLeft: 0,
    preferredMonths: [],
    liked: [],
    skipped: [],
    likedTags: [],
    isSample: false,
    createdAt: rec.createdAt,
  };
}
