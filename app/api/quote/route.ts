import { writeMotivationLine } from "@/lib/assistant";
import { json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { QuoteRequestSchema } from "@/lib/schemas";
import type { QuoteResponse } from "@/lib/types";

export const maxDuration = 20;

/**
 * POST /api/quote — { goals, interests, city?, name? } → { text, source }.
 * One short original line about the user's goals (Claude, else Gemini; structured output,
 * ≤ 120 chars, no attribution), or a curated line from lib/quotes.ts when the AI is off or fails.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "quote", RATE_LIMITS.llm);
  if (limited) return limited;
  const body = await parseBody(request, QuoteRequestSchema, 16 * 1024);
  if (!body.ok) return body.response;
  return json<QuoteResponse>(await writeMotivationLine(body.data));
}
