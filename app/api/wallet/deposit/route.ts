import { apiError, json, parseBody, siteOrigin } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { WalletDepositSchema } from "@/lib/schemas";
import { stripeApi, type StripeCheckoutSession } from "@/lib/stripe";
import { GENERAL_ENVELOPE_ID, GENERAL_ENVELOPE_NAME, type WalletDepositResponse } from "@/lib/types";
import { authorizeWallet, walletFailure } from "@/lib/wallet";

export const dynamic = "force-dynamic";

/**
 * POST /api/wallet/deposit — a Stripe Checkout Session (test mode) that adds money to one
 * envelope, or to the general balance (envelopeId "general": money with no goal). With
 * `autosave` (goals only), the card is saved for off-session use and this payment is the
 * first weekly withdrawal; /api/wallet/confirm then stores the weekly schedule.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-deposit", RATE_LIMITS.heavy);
  if (limited) return limited;
  const body = await parseBody(request, WalletDepositSchema, 4 * 1024);
  if (!body.ok) return body.response;
  const auth = authorizeWallet(body.data.token);
  if (!auth.ok) return auth.response;

  const { amount, target, autosave } = body.data;
  const envelopeId = body.data.envelopeId.toLowerCase();
  const general = envelopeId === GENERAL_ENVELOPE_ID;
  if (general && autosave) return apiError("Auto-save works for goals. Pick an event and save for it first.", 400);
  const eventName = general ? GENERAL_ENVELOPE_NAME : body.data.eventName.replace(/\s+/g, " ").trim();
  const cents = Math.round(amount * 100);
  const targetCents = Math.round((target ?? 0) * 100);
  const origin = siteOrigin(request);
  const kind = autosave ? "autosave" : "deposit";

  try {
    const session = await stripeApi<StripeCheckoutSession>("POST", "/v1/checkout/sessions", {
      mode: "payment",
      customer: auth.customerId,
      payment_method_types: ["card"],
      // Always charge in USD: with Adaptive Pricing a visitor abroad (e.g. judges in Astana) would
      // pay in local currency, and the wallet ledger only counts USD payments.
      adaptive_pricing: { enabled: false },
      locale: "en",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: cents,
            product_data: {
              name: general ? GENERAL_ENVELOPE_NAME : `Livento wallet: ${eventName.slice(0, 120)}`,
            },
          },
        },
      ],
      payment_intent_data: {
        description: autosave ? "Livento auto-save, first weekly withdrawal" : "Livento wallet deposit",
        setup_future_usage: autosave ? "off_session" : undefined,
        metadata: {
          livento_envelope: envelopeId,
          livento_kind: kind,
          livento_event: eventName.slice(0, 200),
        },
      },
      metadata: autosave
        ? {
            livento_autosave: "1",
            livento_envelope: envelopeId,
            livento_weekly_cents: String(cents),
            livento_target_cents: String(targetCents),
          }
        : { livento_envelope: envelopeId },
      success_url: `${origin}/envelopes?wallet=return&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/envelopes?wallet=cancel`,
    });
    if (typeof session.url !== "string" || !/^https?:\/\//.test(session.url)) {
      return apiError("Stripe didn't return a checkout page. Please try again.", 502);
    }
    return json<WalletDepositResponse>({ url: session.url });
  } catch (err) {
    return walletFailure("deposit", err);
  }
}
