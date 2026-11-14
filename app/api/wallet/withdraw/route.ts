import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { WalletWithdrawSchema } from "@/lib/schemas";
import { stripeApi, type StripeRefund } from "@/lib/stripe";
import type { WalletSummary } from "@/lib/types";
import {
  WALLET_NOT_FOUND,
  authorizeWallet,
  envelopeCents,
  loadLedger,
  loadSummary,
  newestPaymentFirst,
  walletFailure,
} from "@/lib/wallet";

export const dynamic = "force-dynamic";

/**
 * POST /api/wallet/withdraw — sends an envelope's money back to the card it came from
 * (Stripe refunds, newest payment first). `amount` omitted = the whole envelope balance.
 * Double submits never refund twice: with `requestId` (the client sends one per withdrawal), a
 * request whose refunds already exist returns the summary, and each refund's Idempotency-Key is
 * `withdraw-<requestId>-<payment>`. Without it the key is derived from (payment, amount already
 * refunded, amount), which dedupes simultaneous retries while a later withdrawal gets a new key.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-withdraw", RATE_LIMITS.heavy);
  if (limited) return limited;
  const body = await parseBody(request, WalletWithdrawSchema, 2 * 1024);
  if (!body.ok) return body.response;
  const auth = authorizeWallet(body.data.token);
  if (!auth.ok) return auth.response;
  const { customerId } = auth;
  const envelopeId = body.data.envelopeId.toLowerCase();
  const requestId = body.data.requestId;

  try {
    const ledger = await loadLedger(customerId);
    if (requestId && ledger.refunds.some((r) => r.requestId === requestId)) {
      const summary = await loadSummary(customerId);
      if (!summary) return apiError(WALLET_NOT_FOUND, 404);
      return json<WalletSummary>(summary); // this withdrawal already went through
    }
    const balance = envelopeCents(ledger, envelopeId);
    if (balance <= 0) return apiError("There's no money in this envelope to withdraw.", 409);
    const wanted = body.data.amount === undefined ? balance : Math.round(body.data.amount * 100);
    if (wanted > balance) return apiError("That's more than this envelope holds.", 409);

    let left = wanted;
    const payments = ledger.payments
      .filter((p) => p.envelopeId === envelopeId && p.cents - p.refundedCents > 0)
      .sort(newestPaymentFirst);
    for (const p of payments) {
      if (left <= 0) break;
      const amount = Math.min(left, p.cents - p.refundedCents);
      await stripeApi<StripeRefund>(
        "POST",
        "/v1/refunds",
        {
          payment_intent: p.id,
          amount,
          reason: "requested_by_customer",
          metadata: { livento_envelope: envelopeId, livento_kind: "withdrawal", livento_request: requestId },
        },
        { idempotencyKey: requestId ? `withdraw-${requestId}-${p.id}` : `withdraw-${p.id}-${p.refundedCents}-${amount}` },
      );
      left -= amount;
    }

    const summary = await loadSummary(customerId);
    if (!summary) return apiError(WALLET_NOT_FOUND, 404);
    return json<WalletSummary>(summary);
  } catch (err) {
    return walletFailure("withdraw", err);
  }
}
