/**
 * Spend-vs-save comparator (spec §6, FR-9). Pure; safe in the browser.
 * Neutral by design: it reports both paths and never picks one.
 */
import { addDays, isoDatePart, resolveToday } from "./dates";
import type { ComparatorInput, ComparatorResult } from "./types";

/** Used instead of Infinity when nothing is being saved per week. */
export const NEVER_WEEKS = 999;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function weeksNeeded(needed: number, weekly: number): number {
  if (needed <= 0) return 0;
  if (weekly <= 0) return NEVER_WEEKS;
  // tiny epsilon so 300 / 100 stays 3 despite float noise
  return Math.min(NEVER_WEEKS, Math.ceil(needed / weekly - 1e-9));
}

export function compareSpendVsSave(input: ComparatorInput): ComparatorResult {
  const today = resolveToday(input.today);
  const balance = num(input.balance);
  const weekly = num(input.weeklyContribution);
  const costA = Math.max(0, num(input.eventA?.cost));
  const costB = Math.max(0, num(input.eventB?.cost));
  const deadlineB = isoDatePart(input.eventB?.deadline);

  const makes = (weeks: number, reachOn: string): boolean | null => {
    if (!deadlineB) return null;
    if (weeks >= NEVER_WEEKS) return false;
    return reachOn <= deadlineB;
  };

  // Go now: pay for A today, then keep saving toward B.
  const remainingAfterA = balance - costA;
  const shortfallForA = Math.max(0, costA - balance);
  const goWeeks = weeksNeeded(costB - remainingAfterA, weekly);
  const goReach = addDays(today, goWeeks * 7);

  // Skip: keep the whole balance for B.
  const skipWeeks = weeksNeeded(costB - balance, weekly);
  const skipReach = addDays(today, skipWeeks * 7);

  return {
    goNow: {
      remainingAfterA,
      shortfallForA,
      weeksToB: goWeeks,
      reachBOn: goReach,
      makesBDeadline: makes(goWeeks, goReach),
    },
    skip: {
      weeksToB: skipWeeks,
      reachBOn: skipReach,
      makesBDeadline: makes(skipWeeks, skipReach),
    },
  };
}
