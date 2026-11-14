import { buildPlan } from "@/lib/cost";
import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { PlanRequestSchema } from "@/lib/schemas";
import type { PlanResponse } from "@/lib/types";

/** POST /api/plan — the same pure rules as lib/cost buildPlan. */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "plan", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, PlanRequestSchema, 64 * 1024);
  if (!body.ok) return body.response;
  try {
    const { event, profile, envelopeBalance, overrides } = body.data;
    return json<PlanResponse>(buildPlan(event, profile, envelopeBalance, overrides));
  } catch (err) {
    console.error("[plan] failed", err instanceof Error ? err.name : "");
    return apiError("The cost plan is unavailable right now. Please try again.", 500);
  }
}
