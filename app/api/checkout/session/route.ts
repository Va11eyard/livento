import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { CheckoutSessionRequestSchema } from "@/lib/schemas";
import type { CheckoutSessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const STRIPE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-06-20";

interface StripeSession {
  mode?: string;
  status?: string;
  payment_status?: string;
  subscription?: string | null;
  metadata?: Record<string, string> | null;
}

function stripeFetch(key: string, path: string, method: "GET" | "DELETE" = "GET") {
  return fetch(`${STRIPE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
}

/**
 * POST /api/checkout/session — for a Premium test checkout bought in this browser:
 * `confirm` checks that the session really completed (before Premium is marked paid),
 * `cancel` cancels its subscription so nothing renews. The Checkout Session id from the
 * success URL is the only handle; nothing is stored on the server. Test keys only.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "checkout-session", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, CheckoutSessionRequestSchema, 2 * 1024);
  if (!body.ok) return body.response;

  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_test_/.test(key)) {
    return json<CheckoutSessionResponse>({ ok: false, message: "Payments aren't connected on this deployment." });
  }
  const { sessionId, action } = body.data;

  try {
    const res = await stripeFetch(key, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) return apiError("We couldn't find that checkout.", 404);
    if (!res.ok) {
      console.warn(`[checkout/session] Stripe HTTP ${res.status}`);
      return apiError("Checkout is unavailable right now. Please try again.", 502);
    }
    const session = (await res.json()) as StripeSession;
    if (session.mode !== "subscription" || session.metadata?.app !== "livento-premium") {
      return apiError("That checkout isn't a Livento Premium purchase.", 400);
    }

    if (action === "confirm") {
      const paid =
        session.status === "complete" &&
        (session.payment_status === "paid" || session.payment_status === "no_payment_required");
      return json<CheckoutSessionResponse>({
        ok: true,
        paid,
        message: paid ? undefined : "This checkout hasn't been paid, so Premium stays off.",
      });
    }

    // cancel
    const subscription = session.subscription;
    if (!subscription) return json<CheckoutSessionResponse>({ ok: true, canceled: true });
    const del = await stripeFetch(key, `/subscriptions/${encodeURIComponent(subscription)}`, "DELETE");
    if (del.ok) return json<CheckoutSessionResponse>({ ok: true, canceled: true });
    // Already canceled earlier? Then there is nothing left to renew.
    const check = await stripeFetch(key, `/subscriptions/${encodeURIComponent(subscription)}`);
    const sub = check.ok ? ((await check.json()) as { status?: string }) : null;
    if (sub?.status === "canceled" || sub?.status === "incomplete_expired") {
      return json<CheckoutSessionResponse>({ ok: true, canceled: true });
    }
    console.warn(`[checkout/session] cancel failed: Stripe HTTP ${del.status}`);
    return apiError("We couldn't cancel the subscription right now. Please try again.", 502);
  } catch {
    console.warn("[checkout/session] Stripe request failed");
    return apiError("Checkout is unavailable right now. Please try again.", 502);
  }
}
