import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { ENVELOPE_ID, WalletConfirmSchema, isWalletEnvelopeId } from "@/lib/schemas";
import { stripeApi, stripeId, type StripeCheckoutSession, type StripePaymentIntent } from "@/lib/stripe";
import type { WalletConfirmResponse } from "@/lib/types";
import {
  WALLET_NOT_FOUND,
  authorizeWallet,
  buildSummary,
  envelopeCents,
  getCustomer,
  loadLedger,
  utcToday,
  walletFailure,
  writeSchedules,
} from "@/lib/wallet";
import { addDays } from "@/lib/dates";

export const dynamic = "force-dynamic";

/** Sessions older than this never (re)start an auto-save, even if their PaymentIntent wasn't marked. */
const MAX_SESSION_AGE_S = 2 * 24 * 60 * 60;

/**
 * POST /api/wallet/confirm — called on return from Checkout. Idempotent: checks the session
 * belongs to this wallet and is paid, stores the auto-save schedule once (the PaymentIntent is
 * marked `livento_autosave_applied=1`), and returns the fresh summary.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-confirm", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, WalletConfirmSchema, 2 * 1024);
  if (!body.ok) return body.response;
  const auth = authorizeWallet(body.data.token);
  if (!auth.ok) return auth.response;
  const { customerId } = auth;

  try {
    const session = await stripeApi<StripeCheckoutSession>(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(body.data.sessionId)}`,
      { expand: ["payment_intent"] },
    );
    if (stripeId(session.customer) !== customerId) {
      return apiError("That payment belongs to a different wallet.", 403);
    }
    if (session.payment_status !== "paid") {
      return apiError("That payment isn't complete. Nothing was added to your wallet.", 409);
    }

    const [ledger, customer] = await Promise.all([loadLedger(customerId), getCustomer(customerId)]);
    if (!customer) return apiError(WALLET_NOT_FOUND, 404);

    let current = customer;
    const meta = session.metadata ?? {};
    const pi = session.payment_intent && typeof session.payment_intent === "object" ? (session.payment_intent as StripePaymentIntent) : null;
    const fresh = Date.now() / 1000 - session.created < MAX_SESSION_AGE_S;
    if (meta.livento_autosave === "1" && pi && pi.metadata?.livento_autosave_applied !== "1" && fresh) {
      const envelopeId = (meta.livento_envelope ?? "").toLowerCase();
      const weeklyCents = Number(meta.livento_weekly_cents);
      const targetCents = Number(meta.livento_target_cents);
      const paymentMethod = stripeId(pi.payment_method);
      const valid =
        ENVELOPE_ID.test(envelopeId) &&
        Number.isInteger(weeklyCents) &&
        weeklyCents >= 100 &&
        weeklyCents <= 200_000 &&
        Number.isInteger(targetCents) &&
        targetCents >= 0 &&
        !!paymentMethod &&
        /^pm_[A-Za-z0-9_]+$/.test(paymentMethod);
      if (valid && paymentMethod) {
        // The first withdrawal may already reach the goal; then there's nothing left to schedule.
        const reached = targetCents > 0 && envelopeCents(ledger, envelopeId) >= targetCents;
        if (!reached) {
          current = await writeSchedules(customerId, customer.metadata, {
            [envelopeId]: {
              envelopeId,
              weeklyCents,
              nextDate: addDays(utcToday(), 7),
              paymentMethod,
              targetCents,
              status: "active",
            },
          });
        }
        await stripeApi("POST", `/v1/payment_intents/${pi.id}`, { metadata: { livento_autosave_applied: "1" } });
      }
    }

    const paidCents = pi ? (Number.isInteger(pi.amount_received) ? (pi.amount_received as number) : pi.amount) : NaN;
    const confirmedEnvelope = (pi?.metadata?.livento_envelope ?? meta.livento_envelope ?? "").toLowerCase();
    const result: WalletConfirmResponse = buildSummary(ledger, current);
    if (isWalletEnvelopeId(confirmedEnvelope) && Number.isInteger(paidCents) && paidCents > 0) {
      result.confirmed = { envelopeId: confirmedEnvelope, amount: paidCents / 100, autosave: meta.livento_autosave === "1" };
    }
    return json<WalletConfirmResponse>(result);
  } catch (err) {
    return walletFailure("confirm", err);
  }
}
