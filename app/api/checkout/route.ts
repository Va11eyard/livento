import { json, parseBody, siteOrigin } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { CheckoutRequestSchema } from "@/lib/schemas";
import { PRICING, type CheckoutResponse } from "@/lib/types";

const DEMO_MESSAGE = "Payments aren't connected on this demo. Use Demo unlock to try Premium — no charge.";
const UNAVAILABLE_MESSAGE = "Test checkout is unavailable right now. You can use Demo unlock — no charge.";

/**
 * POST /api/checkout — Stripe Checkout (test mode only) via REST; `{ demo: true }`
 * when no test key is configured. Live keys are refused on purpose.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "checkout", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, CheckoutRequestSchema, 4 * 1024);
  if (!body.ok) return body.response;

  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return json<CheckoutResponse>({ demo: true, message: DEMO_MESSAGE });
  if (!/^(sk|rk)_test_/.test(key)) {
    console.warn("[checkout] STRIPE_SECRET_KEY is not a test key; refusing to create a live session");
    return json<CheckoutResponse>({ demo: true, message: DEMO_MESSAGE });
  }

  const yearly = body.data.plan === "yearly";
  const origin = siteOrigin(request);
  const form = new URLSearchParams({
    mode: "subscription",
    success_url: `${origin}/pricing?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=cancel`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": PRICING.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(Math.round((yearly ? PRICING.yearly : PRICING.monthly) * 100)),
    "line_items[0][price_data][recurring][interval]": yearly ? "year" : "month",
    "line_items[0][price_data][product_data][name]": `Livento Premium (${yearly ? "yearly" : "monthly"})`,
    "line_items[0][price_data][product_data][description]":
      "Test mode — no real charge. Savings envelopes, spend-vs-save comparator, trip roadmap and impulse insights.",
    "subscription_data[metadata][app]": "livento",
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (!res.ok || typeof data?.url !== "string") {
      console.warn(`[checkout] Stripe HTTP ${res.status}`);
      return json<CheckoutResponse>({ demo: true, message: UNAVAILABLE_MESSAGE });
    }
    return json<CheckoutResponse>({
      url: data.url,
      message: "Stripe test mode — no real charge. Test card: 4242 4242 4242 4242.",
    });
  } catch {
    console.warn("[checkout] Stripe request failed");
    return json<CheckoutResponse>({ demo: true, message: UNAVAILABLE_MESSAGE });
  }
}
