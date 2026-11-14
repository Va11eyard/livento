import { apiError, json, parseBody } from "@/lib/http";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { WalletAutosaveSchema } from "@/lib/schemas";
import type { WalletSummary } from "@/lib/types";
import {
  WALLET_NOT_FOUND,
  authorizeWallet,
  getCustomer,
  loadSummary,
  schedulesOf,
  walletFailure,
  writeSchedules,
  type Schedule,
} from "@/lib/wallet";

export const dynamic = "force-dynamic";

/**
 * POST /api/wallet/autosave — `weekly` omitted/null stops the schedule (envelopeId "*" stops
 * every schedule, e.g. when Premium is turned off); a number changes the weekly amount of an
 * existing schedule. Starting auto-save always goes through /api/wallet/deposit (autosave: true).
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "wallet-autosave", RATE_LIMITS.heavy);
  if (limited) return limited;
  const body = await parseBody(request, WalletAutosaveSchema, 2 * 1024);
  if (!body.ok) return body.response;
  const auth = authorizeWallet(body.data.token);
  if (!auth.ok) return auth.response;
  const { customerId } = auth;
  const envelopeId = body.data.envelopeId.toLowerCase();
  const weekly = body.data.weekly;

  if (envelopeId === "*" && weekly !== undefined) {
    return apiError("Change one auto-save at a time.", 400);
  }

  try {
    const customer = await getCustomer(customerId);
    if (!customer) return apiError(WALLET_NOT_FOUND, 404);
    const schedules = schedulesOf(customer.metadata);
    const changes: Record<string, Schedule | null> = {};

    if (envelopeId === "*") {
      for (const s of schedules) changes[s.envelopeId] = null;
    } else {
      const existing = schedules.find((s) => s.envelopeId === envelopeId);
      if (weekly === undefined) {
        if (existing) changes[envelopeId] = null;
      } else {
        if (!existing) {
          return apiError("Auto-save isn't on for this goal. Turn it on to make the first withdrawal.", 409);
        }
        changes[envelopeId] = { ...existing, weeklyCents: Math.round(weekly * 100) };
      }
    }

    const updated =
      Object.keys(changes).length > 0 || (customer.metadata?.livento_autosave && !schedules.some((s) => s.status === "active"))
        ? await writeSchedules(customerId, customer.metadata, changes)
        : customer;
    const summary = await loadSummary(customerId, updated);
    if (!summary) return apiError(WALLET_NOT_FOUND, 404);
    return json<WalletSummary>(summary);
  } catch (err) {
    return walletFailure("autosave", err);
  }
}
