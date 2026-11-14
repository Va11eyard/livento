/**
 * Tiny date helpers shared by the cost plan, comparator, scorer and roadmap.
 * Pure (no Node APIs) so they run in the browser too. All "ISO dates" are
 * "YYYY-MM-DD" strings; arithmetic is done on UTC midnights to avoid DST drift.
 */

export const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for the runtime's local calendar date. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parses "YYYY-MM-DD" (or the date part of an ISO datetime) to UTC-midnight milliseconds. */
export function isoDateToUTC(iso: string | undefined | null): number | null {
  if (!iso || typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  return Number.isFinite(ms) ? ms : null;
}

export function utcToISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The "YYYY-MM-DD" part of an ISO date or datetime, or undefined if it isn't one. */
export function isoDatePart(value: string | undefined | null): string | undefined {
  const ms = isoDateToUTC(value);
  return ms === null ? undefined : utcToISODate(ms);
}

/** Normalizes an optional "today" argument to "YYYY-MM-DD". */
export function resolveToday(today?: string): string {
  return isoDatePart(today) ?? todayISO();
}

export function addDays(iso: string, days: number): string {
  const ms = isoDateToUTC(iso) ?? isoDateToUTC(todayISO())!;
  return utcToISODate(ms + Math.round(days) * DAY_MS);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = isoDateToUTC(fromIso);
  const b = isoDateToUTC(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** Month number 1-12 of an ISO date, or undefined. */
export function monthOf(iso: string | undefined | null): number | undefined {
  const ms = isoDateToUTC(iso);
  return ms === null ? undefined : new Date(ms).getUTCMonth() + 1;
}
