/**
 * Fixed-window rate limit per IP + route (key `rl:<ip>:<route>`, 60 s window).
 * Uses lib/kv (Upstash or in-memory). Fails open if storage errors.
 */
import { apiError } from "./http";
import { kvIncr } from "./kv";

export const RATE_LIMITS = {
  general: 60, // per minute
  llm: 20, // routes that may call the LLM
  heavy: 10, // insights, alerts
} as const;

const WINDOW_SECONDS = 60;

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const ip = first || request.headers.get("x-real-ip")?.trim() || "unknown";
  return ip.replace(/[^0-9a-fA-F:.]/g, "").slice(0, 64) || "unknown";
}

/** Returns a 429 Response when over the limit, otherwise null. */
export async function rateLimit(request: Request, route: string, limit: number): Promise<Response | null> {
  const key = `rl:${clientIp(request)}:${route}`;
  try {
    const count = await kvIncr(key, WINDOW_SECONDS);
    if (count > limit) {
      return apiError("Too many requests. Please wait a minute and try again.", 429, {
        "Retry-After": String(WINDOW_SECONDS),
      });
    }
  } catch {
    // Storage hiccup: fail open rather than block the judge path.
  }
  return null;
}
