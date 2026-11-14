/**
 * Current top picks for an alert subscription, using the same rules as the daily
 * alert job: events in the next 90 days within 50 miles, scored by lib/score.
 * Server-only.
 */
import { profileFromAlert, type AlertRecord } from "./alerts";
import { findEvents } from "./catalog";
import { addDays, todayISO } from "./dates";
import { scoreEvents } from "./score";
import type { LiventoEvent } from "./types";

export type PickTarget = Pick<AlertRecord, "city" | "stateCode" | "interests" | "favourites">;

export async function topPicksFor(target: PickTarget, limit = 3, exclude: string[] = []): Promise<LiventoEvent[]> {
  const today = todayISO();
  const { events } = await findEvents(
    {
      city: target.city,
      state: target.stateCode,
      categories: target.interests,
      radius: 50,
      from: today,
      to: addDays(today, 90),
    },
    today,
  );
  const skip = new Set(exclude);
  const rec: AlertRecord = {
    id: "preview",
    channel: "telegram",
    createdAt: today,
    lastSentAt: null,
    sentIds: [],
    ...target,
  };
  return scoreEvents(profileFromAlert(rec), events.filter((e) => e.source !== "curated"), today)
    .filter((s) => !skip.has(s.event.id))
    .slice(0, limit)
    .map((s) => s.event);
}
