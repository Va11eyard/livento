import { apiError, json, parseBody } from "@/lib/http";
import { rerankWithLLM } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { RecommendRequestSchema } from "@/lib/schemas";
import { scoreEvents, templateWhy, type ScoredEvent } from "@/lib/score";
import type { RecommendItem, RecommendResponse } from "@/lib/types";

export const maxDuration = 30;

const TOP_N = 8;
const POOL = 20;

function ruleItem(s: ScoredEvent): RecommendItem {
  return { eventId: s.event.id, score: s.score, why: templateWhy(s.reasons), reasons: s.reasons.slice(0, 4) };
}

/** POST /api/recommend — rule scores → top 20 → optional LLM re-rank → top 8 with a "why". */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "recommend", RATE_LIMITS.llm);
  if (limited) return limited;
  const body = await parseBody(request, RecommendRequestSchema, 1_500_000);
  if (!body.ok) return body.response;

  try {
    const { profile, events } = body.data;
    const pool = scoreEvents(profile, events).slice(0, POOL);
    if (pool.length === 0) return json<RecommendResponse>({ items: [], ranker: "rules" });

    const picks = await rerankWithLLM(profile, pool);
    if (picks) {
      const byId = new Map(pool.map((s) => [s.event.id, s]));
      const items: RecommendItem[] = [];
      for (const p of picks) {
        const s = byId.get(p.eventId);
        if (!s) continue;
        items.push({ ...ruleItem(s), why: p.why || templateWhy(s.reasons) });
      }
      for (const s of pool) {
        if (items.length >= TOP_N) break;
        if (!items.some((i) => i.eventId === s.event.id)) items.push(ruleItem(s));
      }
      return json<RecommendResponse>({ items: items.slice(0, TOP_N), ranker: "llm" });
    }
    return json<RecommendResponse>({ items: pool.slice(0, TOP_N).map(ruleItem), ranker: "rules" });
  } catch (err) {
    console.error("[recommend] failed", err instanceof Error ? err.name : "");
    return apiError("Recommendations are unavailable right now. Please try again.", 500);
  }
}
