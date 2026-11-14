/**
 * Rule-based recommendation score (spec §6). Pure; safe in the browser.
 *
 *   score = 0.35·match + 0.20·distance + 0.20·price + 0.15·date + 0.10·novelty
 *
 * Unknowns: distance 0.6, price 0.5, undated 0.6. Skipped and past events are
 * excluded; duplicates are removed. Prices come from buildPlan (never the LLM).
 */
import { buildPlan, eventDistanceMiles, isSameCity, needsTrip } from "./cost";
import { monthOf, resolveToday } from "./dates";
import { CATEGORY_LABELS, type Category, type LiventoEvent, type Profile } from "./types";

export const SCORE_WEIGHTS = { match: 0.35, distance: 0.2, price: 0.2, date: 0.15, novelty: 0.1 } as const;

export interface ScoreFactors {
  match: number;
  distance: number;
  price: number;
  date: number;
  novelty: number;
}

export interface ScoredEvent {
  event: LiventoEvent;
  score: number; // 0-1
  reasons: string[]; // short rule reasons, best first
  factors: ScoreFactors;
  /** Estimated all-in total from buildPlan, when a price is known. */
  estimatedTotal?: number;
  trip: boolean;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STOP_WORDS = new Set(["the", "and", "music", "live", "show", "band", "night", "tour", "with"]);

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(/[\s\-/&,]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export interface ScoreOptions {
  /** Categories of the last 3 saved goals (envelopes). Omitted → last 3 liked events are the proxy. */
  recentGoalCategories?: Category[];
}

export function scoreEvents(
  profile: Profile,
  events: LiventoEvent[],
  today?: string,
  options: ScoreOptions = {},
): ScoredEvent[] {
  const t = resolveToday(today);
  const skipped = new Set(profile.skipped ?? []);
  const interests = new Set<string>(profile.interests ?? []);
  const favourites = (profile.favourites ?? []).map((f) => ({ raw: f.trim(), n: norm(f) })).filter((f) => f.n);
  const likedTags = new Set((profile.likedTags ?? []).map(norm).filter(Boolean));
  const budget = Number.isFinite(profile.monthlyFunBudget) ? profile.monthlyFunBudget : 0;
  const preferred = new Set(profile.preferredMonths ?? []);
  const radius = Number.isFinite(profile.radiusMiles) ? profile.radiusMiles : 0;

  // Novelty: categories of the last 3 saved goals (envelopes). Without that
  // list (e.g. the alerts job), the last 3 liked events we can see stand in.
  const byId = new Map(events.map((e) => [e.id, e]));
  const recentCategories = new Set<Category>(
    options.recentGoalCategories
      ? options.recentGoalCategories.slice(-3)
      : (profile.liked ?? [])
          .slice(-3)
          .map((id) => byId.get(id)?.category)
          .filter((c): c is Category => Boolean(c)),
  );

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: ScoredEvent[] = [];

  for (const event of events) {
    if (!event?.id || skipped.has(event.id) || seenIds.has(event.id)) continue;
    if (event.date && event.date < t) continue;
    const dupKey = `${norm(event.name)}|${event.date ?? ""}|${norm(event.city)}`;
    if (seenKeys.has(dupKey)) continue;
    seenIds.add(event.id);
    seenKeys.add(dupKey);

    const reasons: string[] = [];
    const tags = new Set([...event.tags, event.category, event.genre, event.subGenre].map(norm).filter(Boolean));
    const tagWords = new Set([...tags].flatMap(words));
    const name = norm(event.name);

    // --- match --------------------------------------------------------------
    const favHit = favourites.find((f) => tags.has(f.n) || (f.n.length >= 4 && name.includes(f.n)));
    const partialFav = favHit ? undefined : favourites.find((f) => words(f.raw).some((w) => tagWords.has(w)));
    const categoryHit = interests.has(event.category) || [...interests].some((c) => tags.has(c));
    const likedOverlap = [...tags].filter((tag) => likedTags.has(tag) && tag !== event.category).length;
    let match: number;
    if (favHit) {
      match = 1;
      reasons.push(`Matches ${favHit.raw}`);
    } else {
      match = (categoryHit ? 0.6 : 0.1) + (partialFav ? 0.2 : 0) + 0.1 * Math.min(3, likedOverlap);
      if (partialFav) reasons.push(`Close to ${partialFav.raw}`);
      else if (categoryHit) reasons.push(`You picked ${CATEGORY_LABELS[event.category].toLowerCase()}`);
      if (likedOverlap > 0) reasons.push("Like events you liked");
    }
    match = clamp01(match);

    // --- distance -------------------------------------------------------------
    const d = eventDistanceMiles(event, profile);
    const trip = needsTrip(event, profile);
    let distance: number;
    if (d !== undefined) {
      distance = d <= radius ? 1 : radius > 0 ? clamp01(1 - (d - radius) / radius) : 0;
      reasons.push(d < 1 ? "Under 1 mi away" : `${Math.round(d)} mi away${trip ? " (a trip)" : ""}`);
    } else if (isSameCity(event, profile)) {
      distance = 1;
      reasons.push(`In ${event.city}`);
    } else {
      distance = 0.6;
      reasons.push(`In ${event.city}${event.state ? `, ${event.state}` : ""}`);
    }

    // --- price ----------------------------------------------------------------
    const hasPrice =
      (typeof event.priceMin === "number" && Number.isFinite(event.priceMin)) ||
      (typeof event.priceMax === "number" && Number.isFinite(event.priceMax));
    let price = 0.5;
    let estimatedTotal: number | undefined;
    if (hasPrice) {
      estimatedTotal = buildPlan(event, profile, 0, undefined, t).total;
      if (budget > 0) {
        price = estimatedTotal <= budget ? 1 : clamp01(1 - (estimatedTotal - budget) / (2 * budget));
        reasons.push(
          estimatedTotal <= budget ? `Fits your ${money(budget)} budget` : `About ${money(estimatedTotal)} all-in (estimate)`,
        );
      } else {
        reasons.push(`About ${money(estimatedTotal)} all-in (estimate)`);
      }
    } else {
      reasons.push("Price TBA");
    }

    // --- date -----------------------------------------------------------------
    let date = 0.6;
    const month = monthOf(event.date);
    if (month) {
      const inPreferred = preferred.size === 0 || preferred.has(month);
      const nightsNeeded = trip ? 1 : 0;
      const fits = nightsNeeded <= (profile.vacationDaysLeft ?? 0);
      date = inPreferred && fits ? 1 : 0.5;
      if (inPreferred && preferred.size > 0) reasons.push(`In ${MONTHS[month - 1]}, a month you like`);
    } else {
      reasons.push("Flexible dates");
    }

    // --- novelty --------------------------------------------------------------
    const novelty = recentCategories.has(event.category) ? 0.5 : 1;

    const score =
      SCORE_WEIGHTS.match * match +
      SCORE_WEIGHTS.distance * distance +
      SCORE_WEIGHTS.price * price +
      SCORE_WEIGHTS.date * date +
      SCORE_WEIGHTS.novelty * novelty;

    out.push({
      event,
      score: round3(clamp01(score)),
      reasons,
      factors: {
        match: round3(match),
        distance: round3(distance),
        price: round3(price),
        date: round3(date),
        novelty,
      },
      estimatedTotal,
      trip,
    });
  }

  return out.sort(
    (a, b) => b.score - a.score || (a.event.date ?? "9999").localeCompare(b.event.date ?? "9999"),
  );
}

/** Rule-based one-liner, e.g. "Matches indie rock · 4 mi away · fits your $150 budget" (≤ 120 chars). */
export function templateWhy(reasons: string[]): string {
  const parts: string[] = [];
  for (const r of reasons) {
    if (parts.length === 3) break;
    const piece = parts.length === 0 || /^[A-Z]{2}/.test(r) ? r : r.charAt(0).toLowerCase() + r.slice(1);
    const next = [...parts, piece].join(" · ");
    if (next.length > 120) break;
    parts.push(piece);
  }
  return parts.join(" · ") || "Picked from your interests";
}
