/**
 * Minimal iCalendar (RFC 5545) writer for reminders and roadmap steps.
 * Everything is generated in the browser; nothing is sent anywhere.
 */
import { addDays } from "@/lib/dates";

export interface IcsItem {
  uid: string;
  date: string; // YYYY-MM-DD, all-day
  summary: string;
  description?: string;
  url?: string;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Folds a content line at 75 octets (continuation lines start with one space). */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = ch;
      bytes = size;
      limit = 74;
    } else {
      current += ch;
      bytes += size;
    }
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function ymd(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Builds a calendar with one all-day VEVENT (and a 9 AM display alarm) per item. */
export function buildIcs(items: IcsItem[], calendarName: string): string {
  const stamp = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Livento//Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const item of items) {
    const url = safeUrl(item.url);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(item.date)}`,
      `DTEND;VALUE=DATE:${ymd(addDays(item.date, 1))}`,
      `SUMMARY:${escapeText(item.summary)}`,
    );
    if (item.description) lines.push(`DESCRIPTION:${escapeText(item.description)}`);
    if (url) lines.push(`URL:${url}`);
    lines.push(
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(item.summary)}`,
      "TRIGGER:PT9H",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Saves text as a file via a temporary object URL. */
export function downloadFile(filename: string, content: string, type = "text/calendar;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "livento"
  );
}
