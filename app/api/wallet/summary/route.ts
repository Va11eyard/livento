import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { WalletTokenSchema } from "@/lib/schemas";
import type { WalletSummary } from "@/lib/types";
import { WALLET_NOT_FOUND, authorizeWallet, loadSummary, walletFailure } from "@/lib/wallet";

export const dynamic = "force-dynamic";

/** POST /api/wallet/summary — balances, history and auto-save per envelope, read from Stripe. */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-summary", RATE_LIMITS.general);
  if (limited) return limited;
  const body = await parseBody(request, WalletTokenSchema, 2 * 1024);
  if (!body.ok) return body.response;
  const auth = authorizeWallet(body.data.token);
  if (!auth.ok) return auth.response;

  try {
    const summary = await loadSummary(auth.customerId);
    if (!summary) return apiError(WALLET_NOT_FOUND, 404);
    return json<WalletSummary>(summary);
  } catch (err) {
    return walletFailure("summary", err);
  }
}
