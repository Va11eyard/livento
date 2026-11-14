import { ASSISTANT_OFF_MESSAGE, AssistantError, runAssistant, type AssistantErrorKind } from "@/lib/assistant";
import { apiError, json, parseBody } from "@/lib/http";
import { isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { AssistantRequestSchema } from "@/lib/schemas";
import type { AssistantResponse, AssistantStatusResponse } from "@/lib/types";

// A few calculator rounds per answer; the answer itself has a 45 s deadline.
export const maxDuration = 60;

const STATUS: Record<Exclude<AssistantErrorKind, "off">, number> = {
  busy: 503,
  timeout: 504,
  unavailable: 503,
  failed: 502,
};

/** GET /api/assistant — is Ask Livento connected on this deployment? (no AI call, no key details) */
export async function GET(request: Request) {
  const limited = await rateLimit(request, "assistant-status", RATE_LIMITS.general);
  if (limited) return limited;
  return json<AssistantStatusResponse>(
    isLlmConfigured() ? { off: false } : { off: true, message: ASSISTANT_OFF_MESSAGE },
  );
}

/**
 * POST /api/assistant — one Ask Livento turn. Body: AssistantRequest (the chat so far
 * plus a summary of the browser's AppState). Numbers in the answer come from
 * Livento's calculators through tools; `actions` are links the tools built.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "assistant", RATE_LIMITS.heavy);
  if (limited) return limited;
  if (!isLlmConfigured()) return json<AssistantResponse>({ off: true, message: ASSISTANT_OFF_MESSAGE });

  const body = await parseBody(request, AssistantRequestSchema, 200 * 1024);
  if (!body.ok) return body.response;

  try {
    const answer = await runAssistant(body.data);
    return json<AssistantResponse>({ text: answer.text, actions: answer.actions, usedTools: answer.usedTools });
  } catch (err) {
    if (err instanceof AssistantError) {
      if (err.kind === "off") return json<AssistantResponse>({ off: true, message: ASSISTANT_OFF_MESSAGE });
      return apiError(err.message, STATUS[err.kind]);
    }
    console.error("[assistant] route failed", err instanceof Error ? err.name : "");
    return apiError("Ask Livento couldn't answer that just now. Please try again.", 500);
  }
}
