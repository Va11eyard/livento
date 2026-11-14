import { apiError, json, readJson } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { stripeApi, stripeTestKey, type StripeCustomer } from "@/lib/stripe";
import type { WalletCreateResponse } from "@/lib/types";
import { WALLET_OFF_MESSAGE, walletFailure, walletToken } from "@/lib/wallet";

export const dynamic = "force-dynamic";

/**
 * POST /api/wallet — creates this browser's Livento wallet (one Stripe test-mode
 * Customer, no account) and returns its token. The token is the only key to it.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-create", RATE_LIMITS.heavy);
  if (limited) return limited;
  const body = await readJson(request, 1024);
  if (!body.ok) return body.response;
  if (!stripeTestKey()) return apiError(WALLET_OFF_MESSAGE, 503);

  try {
    const customer = await stripeApi<StripeCustomer>("POST", "/v1/customers", {
      description: "Livento wallet (test mode, no account)",
      metadata: { app: "livento" },
    });
    return json<WalletCreateResponse>({ token: walletToken(customer.id) });
  } catch (err) {
    return walletFailure("create", err);
  }
}
