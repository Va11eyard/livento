/**
 * The compact Livento profile payload shared by the Telegram bot and the site
 * ("p<city index>-<interest bits>", base 36, e.g. "p2-9" = Chicago, IL · Concerts, Comedy).
 * It is a /start deep-link payload, rides in the bot's callback_data and in the Mini App
 * link (`/onboarding?tg=<payload>`). Client-safe: depends only on US_CITIES and CATEGORIES.
 */
import { US_CITIES } from "./cities";
import { CATEGORIES, type Category, type City } from "./types";

export const TG_PAYLOAD_PATTERN = /^p([0-9a-z]{1,3})-([0-9a-z]{1,3})$/;

export interface TgPayloadTarget {
  payload: string;
  cityIndex: number;
  city: City;
  mask: number;
  /** Selected interests in CATEGORIES order; may be empty (mask 0). */
  interests: Category[];
}

export function interestsMask(interests: readonly Category[]): number {
  return interests.reduce((bits, c) => {
    const i = CATEGORIES.indexOf(c);
    return i >= 0 ? bits | (1 << i) : bits;
  }, 0);
}

export function maskInterests(mask: number): Category[] {
  return CATEGORIES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export function encodeTgPayload(cityIndex: number, mask: number): string {
  return `p${cityIndex.toString(36)}-${mask.toString(36)}`;
}

/** Index of a city in US_CITIES (exact name, state optional); -1 when it isn't listed. */
export function cityIndexOf(city: string, stateCode?: string): number {
  const name = city.trim().toLowerCase();
  const state = stateCode?.trim().toUpperCase();
  return US_CITIES.findIndex((c) => c.name.toLowerCase() === name && (!state || c.state === state));
}

/** The payload for a city and interests; null when the city is not in US_CITIES. */
export function tgPayloadFor(city: string, stateCode: string | undefined, interests: readonly Category[]): string | null {
  const index = cityIndexOf(city, stateCode);
  return index < 0 ? null : encodeTgPayload(index, interestsMask(interests));
}

/** Reads a payload made by tgPayloadFor / encodeTgPayload; null for anything else. */
export function parseTgPayload(payload: unknown): TgPayloadTarget | null {
  if (typeof payload !== "string") return null;
  const match = TG_PAYLOAD_PATTERN.exec(payload.trim());
  if (!match) return null;
  const cityIndex = parseInt(match[1], 36);
  const city = US_CITIES[cityIndex];
  if (!city) return null;
  const mask = parseInt(match[2], 36) & ((1 << CATEGORIES.length) - 1);
  return { payload: encodeTgPayload(cityIndex, mask), cityIndex, city, mask, interests: maskInterests(mask) };
}
