/**
 * Weekly amount for an envelope (what auto-save withdraws and the default "Add money").
 * Same rule as the savings plan (spec §6):
 * weekly = ceil(max(0, target − balance) / max(1, ceil(days / 7))).
 */
import { daysBetween, todayISO } from "@/lib/dates";
import { NO_DEADLINE_DAYS } from "@/lib/cost";

export interface WeeklySavings {
  remaining: number; // USD still needed (whole dollars)
  weeksLeft: number;
  weekly: number; // USD per week (whole dollars), 0 when the goal is reached
  deadlinePassed: boolean;
}

export function weeklySavings(
  target: number,
  balance: number,
  deadline: string,
  today: string = todayISO(),
): WeeklySavings {
  const remaining = Math.max(0, Math.round(target - balance));
  const days = daysBetween(today, deadline) ?? NO_DEADLINE_DAYS;
  const weeksLeft = Math.max(1, Math.ceil(days / 7));
  const weekly = remaining > 0 ? Math.ceil(remaining / weeksLeft) : 0;
  return { remaining, weeksLeft, weekly, deadlinePassed: days < 0 };
}
