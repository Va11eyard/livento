/**
 * Display helpers for /profile (and the avatar chip in AppNav). Pure functions only.
 */
import { QUOTES } from "@/lib/quotes";
import {
  CATEGORY_IMAGES,
  type CoverChoice,
  type CoverPreset,
  type Profile,
  type ProfileMedia,
  type ProfileQuote,
} from "@/lib/types";

export const PRESET_LABELS: Record<CoverPreset, string> = {
  concert: "Concert",
  theatre: "Theatre",
  festival: "Festival",
  cinema: "Cinema",
};

export function presetSrc(preset: CoverPreset): string {
  return `/assets/trail/${preset}.webp`;
}

/** The default cover follows the top (first) interest. */
export function autoCoverSrc(profile: Profile): string {
  return CATEGORY_IMAGES[profile.interests[0] ?? "music"];
}

export function coverSrc(choice: CoverChoice, profile: Profile, media: ProfileMedia): string {
  if (choice === "photo") return media.cover ?? autoCoverSrc(profile);
  if (choice === "auto") return autoCoverSrc(profile);
  return presetSrc(choice);
}

/** Until the user picks a quote: a curated line chosen from the anonymous id, so it stays put between visits. */
export function defaultQuote(seed: string): ProfileQuote {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const index = hash % QUOTES.length;
  return { text: QUOTES[index], source: "curated", index };
}

/** "Alex Rivera" → "AR", "cher" → "C", "" → "". */
export function initialsOf(name: string): string {
  const first = (word: string) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? "";
  const words = name.trim().split(/\s+/).filter((w) => first(w));
  if (!words.length) return "";
  const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return letters.toUpperCase();
}

/** Only https://t.me/... links are opened. */
export function safeTelegramUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "t.me" || u.hostname === "telegram.me") ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
