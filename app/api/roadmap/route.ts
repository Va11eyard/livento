import { apiError, json, parseBody } from "@/lib/http";
import { polishRoadmapWithLLM } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { buildRoadmap } from "@/lib/roadmap";
import { RoadmapRequestSchema } from "@/lib/schemas";
import type { RoadmapResponse } from "@/lib/types";

export const maxDuration = 30;

/** POST /api/roadmap — deterministic template first, then an optional wording pass by the LLM. */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "roadmap", RATE_LIMITS.llm);
  if (limited) return limited;
  const body = await parseBody(request, RoadmapRequestSchema, 64 * 1024);
  if (!body.ok) return body.response;
  try {
    const { event, profile, plan } = body.data;
    const steps = buildRoadmap(event, profile, plan);
    const polished = await polishRoadmapWithLLM(event, profile, steps);
    return json<RoadmapResponse>({ steps: polished ?? steps, writer: polished ? "llm" : "template" });
  } catch (err) {
    console.error("[roadmap] failed", err instanceof Error ? err.name : "");
    return apiError("The roadmap is unavailable right now. Please try again.", 500);
  }
}
