/**
 * Weekly reminder schedule for an envelope. Same rule as the savings plan
 * (spec §6): weekly = ceil(max(0, target − balance) / max(1, ceil(days / 7))).
 */
import { addDays, daysBetween, todayISO } from "@/lib/dates";
import { NO_DEADLINE_DAYS } from "@/lib/cost";

export interface Reminder {
  date: string; // YYYY-MM-DD
  amount: number; // USD
}

export interface ReminderSchedule {
  remaining: number;
  weeksLeft: number;
  weekly: number;
  deadlinePassed: boolean;
  items: Reminder[];
}

export function reminderSchedule(
  target: number,
  balance: number,
  deadline: string,
  maxItems = 6,
  today: string = todayISO(),
): ReminderSchedule {
  const remaining = Math.max(0, Math.round(target - balance));
  const days = daysBetween(today, deadline) ?? NO_DEADLINE_DAYS;
  const weeksLeft = Math.max(1, Math.ceil(days / 7));
  const weekly = remaining > 0 ? Math.ceil(remaining / weeksLeft) : 0;
  const items: Reminder[] = [];
  let left = remaining;
  for (let week = 0; week < weeksLeft && items.length < maxItems && left > 0; week++) {
    const amount = Math.min(weekly, left);
    items.push({ date: addDays(today, week * 7), amount });
    left -= amount;
  }
  return { remaining, weeksLeft, weekly, deadlinePassed: days < 0, items };
}
