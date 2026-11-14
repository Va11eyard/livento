/**
 * Event alerts (FR-5), server-only: subscription records in lib/kv, delivery
 * through the Telegram Bot API and the Resend email API (plain fetch).
 */
import { randomBytes } from "node:crypto";
import { findCity } from "./cities";
import { kvDel, kvGet, kvSadd, kvSet, kvSmembers, kvSrem } from "./kv";
import { formatDate } from "./roadmap";
import { CATEGORY_LABELS, type Category, type LiventoEvent, type Profile } from "./types";

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

export async function sendTelegram(chatId: number | string, html: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) console.warn(`[alerts] telegram sendMessage HTTP ${res.status}`);
    return res.ok;
  } catch {
    console.warn("[alerts] telegram sendMessage failed");
    return false;
  }
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

function eventFacts(e: LiventoEvent): string {
  const parts = [
    e.date ? formatDate(e.date) : "Date TBA",
    [e.city, e.state].filter(Boolean).join(", "),
    typeof e.priceMin === "number" ? `from $${Math.round(e.priceMin)} face value (fees extra)` : "price TBA",
  ];
  if (e.source === "sample") parts.push("SAMPLE EVENT — not a real listing");
  return parts.join(" · ");
}

export function digestTelegram(rec: AlertRecord, events: LiventoEvent[], site: string): string {
  const lines = events.map((e) => {
    const tickets = ticketUrl(e);
    const ticketsLine = tickets ? `\n  <a href="${escapeHtml(tickets)}">${escapeHtml(ticketLabel(e))}</a>` : "";
    return `• <a href="${escapeHtml(eventUrl(e, site))}">${escapeHtml(e.name)}</a> — full cost on Livento\n  ${escapeHtml(eventFacts(e))}${ticketsLine}`;
  });
  const attribution = events.some((e) => e.source === "ticketmaster") ? "\n\nEvent data: Ticketmaster." : "";
  return `<b>New for you in ${escapeHtml(rec.city)}</b>\n\n${lines.join("\n\n")}${attribution}\n\nPrices are estimates — check the event page. Send /stop to unsubscribe.`;
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
  const attribution = events.some((e) => e.source === "ticketmaster") ? "<p>Event data: Ticketmaster.</p>" : "";
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
