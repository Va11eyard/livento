/**
 * Display helpers for app screens. Client-side only (dates use the viewer's
 * locale and time zone, so call them in components rendered after hydration).
 */
import { formatUSD } from "@/lib/cost";
import { CATEGORY_IMAGES, CATEGORY_LABELS, type Category, type LiventoEvent } from "@/lib/types";

/** "$1,234" (rounded to whole dollars). */
export function usd0(amount: number): string {
  return formatUSD(Math.round(Number.isFinite(amount) ? amount : 0));
}

/** "$1,234" or "$12.50". */
export function usd(amount: number): string {
  return formatUSD(amount);
}

function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Parses "YYYY-MM-DD" (or the date part of an ISO datetime) as a local calendar date. */
export function localDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sat, Mar 14, 2026" · short: "Mar 14" · month: "March 2026". */
export function formatDate(iso: string | undefined | null, style: "long" | "short" | "medium" | "month" = "long"): string {
  const d = localDate(iso);
  if (!d) return "";
  const opts: Intl.DateTimeFormatOptions =
    style === "short"
      ? { month: "short", day: "numeric" }
      : style === "medium"
        ? { month: "short", day: "numeric", year: "numeric" }
        : style === "month"
          ? { month: "long", year: "numeric" }
          : { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

/** "2026-03" → "Mar 2026". */
export function formatMonth(yyyyMm: string): string {
  const d = localDate(`${yyyyMm}-01`);
  return d ? d.toLocaleDateString("en-US", { month: "short", year: "numeric" }) : yyyyMm;
}

/** An ISO datetime in the viewer's time zone: "Fri, Dec 5, 10:00 AM CST". Date-only strings get no time. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return formatDate(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "19:30" → "7:30 PM". */
export function formatTime(hhmm: string | undefined | null): string {
  if (!hhmm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return "";
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** True when the ISO datetime/date is after now. */
export function isFuture(iso: string | undefined | null): boolean {
  if (!iso) return false;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) ? localDate(iso) : new Date(iso);
  return !!d && !Number.isNaN(d.getTime()) && d.getTime() > Date.now();
}

export function weeksLabel(n: number): string {
  return `${n} week${n === 1 ? "" : "s"}`;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as Category] ?? category;
}

export function categoryImage(category: string): string {
  return CATEGORY_IMAGES[category as Category] ?? CATEGORY_IMAGES.music;
}

export interface PriceInfo {
  text: string;
  known: boolean;
  /** Curated prices are always estimates; sample prices are fictional. */
  estimate: boolean;
}

/** "$45–$120", "From $45", "Price varies" (curated) or "Price TBA". */
export function priceInfo(event: LiventoEvent): PriceInfo {
  const min = finiteNum(event.priceMin);
  const max = finiteNum(event.priceMax);
  let text: string;
  if (min !== undefined && max !== undefined) text = min === max ? usd0(min) : `${usd0(min)}–${usd0(max)}`;
  else if (min !== undefined) text = `From ${usd0(min)}`;
  else if (max !== undefined) text = `Up to ${usd0(max)}`;
  else text = event.source === "curated" ? "Price varies" : "Price TBA";
  const known = min !== undefined || max !== undefined;
  const estimate = known && (event.source === "curated" || /estimate/i.test(event.priceNote ?? ""));
  return { text, known, estimate };
}

/** "Sat, Mar 14, 2026 · 7:30 PM" or "Any date" for undated experiences. */
export function eventWhen(event: LiventoEvent): string {
  if (!event.date) return "Flexible dates";
  const date = formatDate(event.date);
  const time = formatTime(event.time);
  return time ? `${date} · ${time}` : date;
}

/** "Chicago, IL". */
export function eventPlace(event: LiventoEvent): string {
  return [event.city, event.state].filter(Boolean).join(", ");
}

/** Route params may arrive percent-encoded; ids never contain "%" themselves. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Only http(s) links are rendered as outbound links. */
export function safeExternalUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function roadmapHref(id: string): string {
  return `/roadmap/${encodeURIComponent(id)}`;
}

export function sourceLabel(event: LiventoEvent): string {
  if (event.source === "sample") return "Sample data";
  if (event.source === "curated") return "Curated";
  return event.attribution || "Event data: Ticketmaster";
}
