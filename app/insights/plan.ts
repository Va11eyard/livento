/**
 * Pure helpers for the Insights screen: totals from the saved summary, the
 * "spend less" plan and how much sooner each saving goal could be reached.
 *
 * - Monthly figures are averages over the days the statements cover
 *   (total ÷ days × 30.44), so partial months don't skew them.
 * - Weekly = monthly ÷ WEEKS_PER_MONTH (4.33), the rule used across the app.
 */
import { weeklySavings } from "@/components/app/savings";
import { addDays, todayISO } from "@/lib/dates";
import { envelopeBalance } from "@/lib/storage";
import { WEEKS_PER_MONTH, type Envelope, type InsightsMonth } from "@/lib/types";

/** Average days in a month (365.25 ÷ 12). */
export const DAYS_PER_MONTH = 30.44;

export function monthLength(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function coveredDays(months: InsightsMonth[]): number {
  return months.reduce((sum, m) => sum + m.days, 0);
}

function perMonth(total: number, days: number): number {
  return days > 0 ? (total / days) * DAYS_PER_MONTH : 0;
}

/** Average spending per month across the saved months. */
export function monthlyAverage(months: InsightsMonth[]): number {
  return perMonth(
    months.reduce((sum, m) => sum + m.spendTotal, 0),
    coveredDays(months),
  );
}

export interface CategoryTotal {
  name: string;
  total: number; // USD over all saved months
  perMonth: number; // USD, average
}

/** Spending per category across the saved months, largest first. */
export function categoryTotals(months: InsightsMonth[]): CategoryTotal[] {
  const days = coveredDays(months);
  const totals = new Map<string, number>();
  for (const m of months) {
    for (const [name, amount] of Object.entries(m.byCategory)) {
      if (Number.isFinite(amount) && amount > 0) totals.set(name, (totals.get(name) ?? 0) + amount);
    }
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total, perMonth: perMonth(total, days) }))
    .sort((a, b) => b.total - a.total);
}

/** Merchants with the most spent across the saved months (from each month's top list). */
export function topMerchants(months: InsightsMonth[], limit = 8): { name: string; amount: number; count: number }[] {
  const totals = new Map<string, { amount: number; count: number }>();
  for (const m of months) {
    for (const t of m.topMerchants) {
      const cur = totals.get(t.name) ?? { amount: 0, count: 0 };
      cur.amount += t.amount;
      cur.count += t.count;
      totals.set(t.name, cur);
    }
  }
  return [...totals.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export interface TrimLine {
  name: string;
  perMonth: number; // USD the category averages now
  less: number; // USD per month freed
}

export interface TrimPlan {
  lines: TrimLine[];
  perMonth: number; // USD
  perWeek: number; // USD
}

/** What spending `pct`% less in the picked categories frees, from their monthly averages. */
export function trimPlan(categories: CategoryTotal[], picked: readonly string[], pct: number): TrimPlan {
  const share = Math.min(100, Math.max(0, pct)) / 100;
  const lines = categories
    .filter((c) => picked.includes(c.name))
    .map((c) => ({ name: c.name, perMonth: c.perMonth, less: c.perMonth * share }));
  const freed = lines.reduce((sum, l) => sum + l.less, 0);
  return { lines, perMonth: freed, perWeek: freed / WEEKS_PER_MONTH };
}

export type GoalImpact =
  | { kind: "funded"; balance: number }
  | { kind: "passed"; balance: number; remaining: number; weeksWithExtra: number | null }
  | {
      kind: "planned";
      balance: number;
      remaining: number;
      weekly: number; // USD per week the goal's own plan asks for
      reachOn: string; // ISO date of the last planned weekly amount
      reachWithExtraOn: string; // the same with the extra weekly amount added
      weeksSooner: number;
    };

/**
 * How much sooner a goal is reached if `extraWeekly` dollars go to it on top of
 * its planned weekly amount: the amount auto-save withdraws, same rule as the
 * savings plan (weekly = ceil(remaining ÷ weeks to the deadline), one amount per week from today).
 */
export function goalImpact(envelope: Envelope, extraWeekly: number, today: string = todayISO()): GoalImpact {
  const balance = envelopeBalance(envelope);
  const schedule = weeklySavings(envelope.target, balance, envelope.deadline, today);
  const { remaining } = schedule;
  if (remaining <= 0) return { kind: "funded", balance };
  const extra = Math.max(0, extraWeekly);
  if (schedule.deadlinePassed) {
    return { kind: "passed", balance, remaining, weeksWithExtra: extra > 0 ? Math.ceil(remaining / extra) : null };
  }
  const weeksAt = (weekly: number) => Math.max(1, Math.ceil(remaining / weekly - 1e-9));
  const planned = weeksAt(schedule.weekly);
  const withExtra = extra > 0 ? weeksAt(schedule.weekly + extra) : planned;
  return {
    kind: "planned",
    balance,
    remaining,
    weekly: schedule.weekly,
    reachOn: addDays(today, (planned - 1) * 7),
    reachWithExtraOn: addDays(today, (withExtra - 1) * 7),
    weeksSooner: planned - withExtra,
  };
}
