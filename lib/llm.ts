/**
 * Claude integration (server-only). The LLM only re-orders and writes words:
 * it never produces a price or a date, and every output is validated here —
 * anything off-contract returns null so callers fall back to rules.
 *
 * - Model `claude-opus-5-5`; thinking is always on for this model, so no
 *   `thinking` param — depth is set with `output_config.effort`.
 * - Structured outputs via `output_config.format` (zod schema) + our own zod
 *   validation of the final text block.
 * - Server-side refusal fallbacks (`fallbacks: "default"`, beta
 *   `server-side-fallback-2026-07-01`) on `client.beta.messages.create`. If the
 *   beta is rejected (400) the GA endpoint is used instead.
 * - The client is created lazily, only when ANTHROPIC_API_KEY is set.
 *
 * Provider choice (shared by Ask Livento, quotes and the web events search):
 * Claude first whenever ANTHROPIC_API_KEY is set. An account failure (credit
 * balance too low, 401, 403, 404, no connection, overloaded) pauses Claude for
 * 10 minutes on this instance and Gemini (lib/gemini.ts, GEMINI_API_KEY) takes
 * over, within the same request. With only GEMINI_API_KEY, Gemini answers.
 * The three calls below fall back the same way (geminiStructured).
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { geminiConfigured, geminiStructured } from "./gemini";
import { SPEND_CATEGORIES, type SpendCategory } from "./spending";
import { CATEGORY_LABELS, type LiventoEvent, type Profile, type RoadmapStep } from "./types";

export const LLM_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const TIMEOUTS = { rerank: 12_000, categorize: 12_000, roadmap: 20_000 } as const;

let client: { apiKey: string; baseURL: string; sdk: Anthropic } | undefined;
let betaFallbacksRejected = false;

const CLAUDE_PAUSE_MS = 10 * 60_000;
// On globalThis so every route bundle on this instance shares it (and dev reloads keep it).
// `key` is a hash of the key that failed: a new key gets a fresh try.
const breaker: { until: number; key: string } = ((globalThis as unknown as { __liventoClaudeBreaker?: { until: number; key: string } })
  .__liventoClaudeBreaker ??= { until: 0, key: "" });

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** True when an AI provider is set: Claude (ANTHROPIC_API_KEY) or Gemini (GEMINI_API_KEY). */
export function isLlmConfigured(): boolean {
  return claudeConfigured() || geminiConfigured();
}

/** Claude goes first when its key is set, unless it just failed for account reasons and Gemini can take over. */
export function claudeUsable(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return false;
  return Date.now() >= breaker.until || breaker.key !== keyHash(key) || !geminiConfigured();
}

/** Credit balance too low, bad key, no access, unknown model, no connection or overloaded (a slow answer isn't one). */
export function isClaudeAccountError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return false;
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.OverloadedError ||
    (err instanceof Anthropic.APIError && err.status === 529) ||
    (err instanceof Anthropic.BadRequestError && /credit balance/i.test(String(err.message)))
  );
}

/**
 * After a Claude error: an account error pauses Claude for 10 minutes on this
 * instance. True when the caller should answer with Gemini instead.
 */
export function claudeFailedOver(err: unknown, label: string): boolean {
  if (!isClaudeAccountError(err)) return false;
  breaker.until = Date.now() + CLAUDE_PAUSE_MS;
  breaker.key = keyHash(process.env.ANTHROPIC_API_KEY?.trim() ?? "");
  const backup = geminiConfigured();
  console.warn(
    `[llm] ${label}: Claude unavailable (${describeError(err)}); ${backup ? "using Gemini, Claude paused for 10 minutes" : "no GEMINI_API_KEY to fall back to"}`,
  );
  return backup;
}

/** The provider in use, for /api/health. */
export function aiProviderLabel(): string {
  const claude = claudeConfigured();
  const gemini = geminiConfigured();
  if (claude && gemini) return claudeUsable() ? "Claude (Gemini as backup)" : "Gemini (Claude paused after an account error)";
  return claude ? "Claude" : gemini ? "Gemini" : "None";
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  // A new client when the key (or the test-only ANTHROPIC_BASE_URL) changes, e.g. after a dev env reload.
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() ?? "";
  if (!client || client.apiKey !== apiKey || client.baseURL !== baseURL) {
    client = { apiKey, baseURL, sdk: new Anthropic({ apiKey, maxRetries: 1 }) };
  }
  return client.sdk;
}

function parseJson<S extends z.ZodType>(schema: S, text: string): z.infer<S> | null {
  if (!text.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.name} ${err.status ?? ""}`.trim();
  if (err instanceof Error) return err.name;
  return "unknown error";
}

interface StructuredCall<S extends z.ZodType> {
  label: string;
  schema: S;
  system: string;
  user: string;
  effort: "low" | "medium";
  maxTokens: number;
  timeoutMs: number;
}

/** One structured-output request: Claude with refusal fallbacks, else Gemini; null on any failure. */
async function structuredCall<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S> | null> {
  // One overall deadline covers the beta attempt, a possible GA retry, SDK retries and a Gemini fallback.
  const signal = AbortSignal.timeout(call.timeoutMs);
  const anthropic = claudeUsable() ? getClient() : null;
  if (anthropic) {
    try {
      return await claudeStructured(anthropic, call, signal);
    } catch (err) {
      if (!claudeFailedOver(err, call.label)) {
        console.warn(`[llm] ${call.label} failed: ${describeError(err)}`);
        return null;
      }
    }
  }
  if (!geminiConfigured()) return null;
  const { label, schema, system, user, maxTokens, timeoutMs, effort } = call;
  return geminiStructured({ label, schema, system, user, maxTokens, timeoutMs, effort, signal });
}

/** The Claude request; throws on API errors. */
async function claudeStructured<S extends z.ZodType>(
  anthropic: Anthropic,
  call: StructuredCall<S>,
  signal: AbortSignal,
): Promise<z.infer<S> | null> {
  const requestOptions = { timeout: call.timeoutMs, signal };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: call.user }];
  if (!betaFallbacksRejected) {
    try {
      const msg = await anthropic.beta.messages.create(
        {
          model: LLM_MODEL,
          max_tokens: call.maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: call.system,
          messages,
          output_config: { effort: call.effort, format: betaZodOutputFormat(call.schema) },
        },
        requestOptions,
      );
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") return null;
      // The final answer is the text after the last fallback switch point (if any).
      let start = 0;
      msg.content.forEach((block, i) => {
        if (block.type === "fallback") start = i + 1;
      });
      const text = msg.content
        .slice(start)
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return parseJson(call.schema, text);
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError) || isClaudeAccountError(err)) throw err;
      console.warn(`[llm] ${call.label}: beta request rejected (400); retrying on the GA endpoint`);
    }
  }

  const msg = await anthropic.messages.create(
    {
      model: LLM_MODEL,
      max_tokens: call.maxTokens,
      system: call.system,
      messages,
      output_config: { effort: call.effort, format: zodOutputFormat(call.schema) },
    },
    requestOptions,
  );
  if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") return null;
  const text = msg.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const parsed = parseJson(call.schema, text);
  // The GA retry worked where the beta 400'd: skip the beta path from now on.
  if (parsed !== null && !betaFallbacksRejected) betaFallbacksRejected = true;
  return parsed;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${(atSpace > max * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// ---------------------------------------------------------------------------
// 1. Re-rank recommendations
// ---------------------------------------------------------------------------

export interface RerankCandidate {
  event: LiventoEvent;
  score: number;
  reasons: string[];
  trip?: boolean;
  factors?: { price?: number; date?: number };
}

const RerankSchema = z.object({
  picks: z.array(
    z.object({
      id: z.string().describe("An id from the candidate list"),
      why: z.string().describe("One line, max 110 characters, no digits, prices or dates"),
    }),
  ),
});

const RERANK_SYSTEM = [
  "You are the recommendation editor for Livento, an app that helps people in the US plan and save for live experiences.",
  "You get one person's stated tastes and candidate events that rules have already scored.",
  "Choose the best picks for this person, best first. When candidates are close, prefer a varied mix over many of the same kind.",
  "For each pick write one 'why this' line: at most 110 characters, warm, concrete and specific to the person's stated tastes.",
  "Rules: use only ids from the candidate list, each at most once. Base every line only on the facts given.",
  "Never invent artists, lineups, venues, reviews or popularity. Never write digits, prices, dollar amounts, distances or dates.",
  "Plain text only: no emojis, no hashtags, no markdown.",
].join("\n");

/** Picks the best (≤ 8) of ≤ 20 candidates with one "why" each; null on failure. Empty `why` = use the template. */
export async function rerankWithLLM(
  profile: Profile,
  candidates: RerankCandidate[],
): Promise<{ eventId: string; why: string }[] | null> {
  const pool = candidates.slice(0, 20);
  if (!isLlmConfigured() || pool.length === 0) return null;
  const pickCount = Math.min(8, pool.length);
  const ids = new Set(pool.map((c) => c.event.id));

  const user = JSON.stringify({
    person: {
      interests: profile.interests.map((c) => CATEGORY_LABELS[c]),
      favourites: profile.favourites.slice(0, 12),
      home: [profile.city, profile.stateCode].filter(Boolean).join(", "),
    },
    pickCount,
    candidates: pool.map((c) => ({
      id: c.event.id,
      name: c.event.name,
      category: CATEGORY_LABELS[c.event.category],
      genre: [c.event.genre, c.event.subGenre].filter(Boolean).join(" / ") || undefined,
      tags: c.event.tags.slice(0, 8),
      place: [c.event.city, c.event.state].filter(Boolean).join(", "),
      travel: c.trip === undefined ? undefined : c.trip ? "needs a trip" : "local",
      fitsBudget: c.factors?.price === undefined ? undefined : c.factors.price >= 1 ? "yes" : c.factors.price === 0.5 ? "unknown" : "no",
      inPreferredMonth: c.factors?.date === undefined ? undefined : c.factors.date >= 1,
      sampleEvent: c.event.source === "sample" || undefined,
      ruleReasons: c.reasons.filter((r) => !/[\d$]/.test(r)).slice(0, 4),
      ruleScore: Math.round(c.score * 100) / 100,
    })),
  });

  const out = await structuredCall({
    label: "rerank",
    schema: RerankSchema,
    system: RERANK_SYSTEM,
    user: `Pick the best ${pickCount} for this person.\n${user}`,
    effort: "low",
    maxTokens: 3_000,
    timeoutMs: TIMEOUTS.rerank,
  });
  if (!out) return null;

  const seen = new Set<string>();
  const picks: { eventId: string; why: string }[] = [];
  for (const p of out.picks) {
    const id = p.id.trim();
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    let why = tidy(p.why);
    if (/[\d$]/.test(why) || why.length < 8) why = ""; // numbers come from rules only
    picks.push({ eventId: id, why: why ? truncate(why, 120) : "" });
    if (picks.length === pickCount) break;
  }
  return picks.length ? picks : null;
}

// ---------------------------------------------------------------------------
// 2. Polish roadmap text
// ---------------------------------------------------------------------------

const RoadmapSchema = z.object({
  steps: z.array(
    z.object({
      index: z.number().int(),
      title: z.string(),
      detail: z.string(),
    }),
  ),
});

const ROADMAP_SYSTEM = [
  "You are the trip-planning writer for Livento. You rewrite the wording of a roadmap that rules already computed.",
  "Rewrite each step's title and detail so it reads clearly and warmly for this specific event.",
  "Rules: return every step index exactly once. Keep every number, dollar amount, date, time and name exactly as written in that step.",
  "Do not add any new numbers, dates, weekdays, prices, links, places or facts. Do not promise availability or prices.",
  "Title: at most 70 characters. Detail: at most 260 characters. Plain text only: no markdown, no emojis.",
].join("\n");

const MONTH_WORDS = [
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"], ["june", "jun"],
  ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
];
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, "")));
}

function monthsIn(text: string): Set<number> {
  const found = new Set<number>();
  const lowerText = text.toLowerCase();
  MONTH_WORDS.forEach((forms, i) => {
    if (forms.some((f) => new RegExp(`\\b${f}\\b`).test(lowerText))) found.add(i + 1);
  });
  return found;
}

/** True when the rewrite adds no number, month or weekday that the original step didn't have. */
function preservesFacts(original: RoadmapStep, rewritten: string): boolean {
  const source = `${original.title} ${original.detail}`;
  const allowedNumbers = numbersIn(source);
  const allowedMonths = monthsIn(source);
  if (original.date) {
    const [y, m, d] = original.date.split("-");
    allowedNumbers.add(y);
    allowedNumbers.add(String(Number(d)));
    allowedNumbers.add(d);
    allowedMonths.add(Number(m));
  }
  for (const n of numbersIn(rewritten)) if (!allowedNumbers.has(n)) return false;
  for (const m of monthsIn(rewritten)) if (!allowedMonths.has(m)) return false;
  const weekdaysBefore = new Set((source.match(WEEKDAYS) ?? []).map((w) => w.toLowerCase()));
  for (const w of rewritten.match(WEEKDAYS) ?? []) if (!weekdaysBefore.has(w.toLowerCase())) return false;
  if (/https?:|www\./i.test(rewritten)) return false;
  return true;
}

/** Rewrites only title/detail; count, dates, kinds and links are preserved. Null when nothing usable came back. */
export async function polishRoadmapWithLLM(
  event: LiventoEvent,
  profile: Profile,
  steps: RoadmapStep[],
): Promise<RoadmapStep[] | null> {
  if (!isLlmConfigured() || steps.length === 0 || steps.length > 20) return null;
  const user = JSON.stringify({
    event: {
      name: event.name,
      category: CATEGORY_LABELS[event.category],
      place: [event.venue, event.city, event.state].filter(Boolean).join(", "),
      sampleEvent: event.source === "sample" || undefined,
    },
    traveler: { home: [profile.city, profile.stateCode].filter(Boolean).join(", ") },
    steps: steps.map((s, index) => ({ index, kind: s.kind, date: s.date, title: s.title, detail: s.detail })),
  });

  const out = await structuredCall({
    label: "roadmap",
    schema: RoadmapSchema,
    system: ROADMAP_SYSTEM,
    user: `Rewrite these ${steps.length} steps.\n${user}`,
    effort: "medium",
    maxTokens: 4_000,
    timeoutMs: TIMEOUTS.roadmap,
  });
  if (!out || out.steps.length !== steps.length) return null;

  const byIndex = new Map<number, { title: string; detail: string }>();
  for (const s of out.steps) {
    if (s.index < 0 || s.index >= steps.length || byIndex.has(s.index)) return null;
    byIndex.set(s.index, s);
  }

  let changed = 0;
  const result = steps.map((original, i) => {
    const s = byIndex.get(i);
    if (!s) return original;
    const title = tidy(s.title);
    const detail = tidy(s.detail);
    if (title.length < 3 || title.length > 90 || detail.length < 8 || detail.length > 320) return original;
    if (!preservesFacts(original, `${title} ${detail}`)) return original;
    changed++;
    return { ...original, title, detail };
  });
  return changed > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// 3. Categorize merchants the rules don't know
// ---------------------------------------------------------------------------

const MerchantSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      category: z.enum(SPEND_CATEGORIES),
    }),
  ),
});

const MERCHANT_SYSTEM = [
  "You categorize merchant names from US bank statements for a personal budgeting app.",
  "For each name choose the single best spending category from the allowed list. If unsure, use \"Other\".",
  "Return each given name exactly as written. Do not add names.",
].join("\n");

/** Spending category for ≤ 60 merchant names, keyed by the name as given; null on failure. */
export async function categorizeMerchantsWithLLM(names: string[]): Promise<Map<string, SpendCategory> | null> {
  const unique = [...new Set(names.map(tidy).filter(Boolean))].slice(0, 60);
  if (!isLlmConfigured() || unique.length === 0) return null;
  const out = await structuredCall({
    label: "categorize",
    schema: MerchantSchema,
    system: MERCHANT_SYSTEM,
    user: JSON.stringify({ allowedCategories: SPEND_CATEGORIES, merchants: unique }),
    effort: "low",
    maxTokens: 4_000,
    timeoutMs: TIMEOUTS.categorize,
  });
  if (!out) return null;
  const wanted = new Set(unique);
  const map = new Map<string, SpendCategory>();
  for (const item of out.items) {
    const name = tidy(item.name);
    if (wanted.has(name)) map.set(name, item.category);
  }
  return map.size ? map : null;
}
