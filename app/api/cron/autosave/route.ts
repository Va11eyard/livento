import type { NextRequest } from "next/server";
import { runAutosave } from "@/lib/autosave";
import { apiError, json } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { isStripeError, stripeTestKey } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/autosave — daily auto-save withdrawals (Vercel Cron, 14:00 UTC).
 * Requires `Authorization: Bearer CRON_SECRET`. Returns counts only.
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "cron-autosave", RATE_LIMITS.cron);
  if (limited) return limited;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("Unauthorized", 401);
  }
  if (!stripeTestKey()) {
    return json({ customers: 0, due: 0, charged: 0, failed: 0, completed: 0, errors: 0, note: "Stripe test mode is not configured" });
  }
  try {
    return json(await runAutosave());
  } catch (err) {
    console.warn(`[cron/autosave] search failed: status=${isStripeError(err) ? err.status : "?"}`);
    return apiError("Stripe test mode isn't answering right now.", 502);
  }
}
