/**
 * Daily auto-save job (server-only, Stripe TEST MODE). Called by GET /api/cron/autosave.
 *
 * Finds wallets with an active schedule (Customer Search on metadata `livento_autosave`),
 * and for each schedule due today or earlier makes one off-session withdrawal from the saved
 * card into the envelope:
 * - success: nextDate moves to the next weekly date after today (no catch-up charges);
 *   the schedule stops once the envelope reaches its target (the last withdrawal is capped
 *   at what's left, so it never takes more than the goal needs);
 * - decline (HTTP 402, card_declined, authentication_required) or another permanent error:
 *   status "failed" (the user sees it and can turn auto-save on again);
 * - temporary errors (network, 5xx, 429, idempotency conflicts): left as is for the next run.
 * Every PaymentIntent uses Idempotency-Key `autosave-<cus>-<env>-<nextDate>` and records the
 * cycle in metadata, so a crash between charging and updating the schedule can't charge twice.
 */
import { isStripeError, stripeApi, type StripeCustomer, type StripePaymentIntent, type StripeSearchResult } from "./stripe";
import {
  advanceWeekly,
  envelopeCents,
  envelopeEventName,
  loadLedger,
  schedulesOf,
  utcToday,
  writeSchedules,
  type Ledger,
  type Schedule,
} from "./wallet";

const TIME_BUDGET_MS = 50_000;
const MAX_SEARCH_PAGES = 20;
const MIN_CHARGE_CENTS = 100;

export interface AutosaveRunResult {
  customers: number;
  due: number;
  charged: number;
  failed: number;
  completed: number;
  errors: number;
}

function isPermanentFailure(err: unknown): boolean {
  if (!isStripeError(err)) return false;
  if (err.status === 402 || err.code === "card_declined" || err.code === "authentication_required") return true;
  return (err.status === 400 || err.status === 404) && err.type !== "idempotency_error";
}

async function runCustomer(customer: StripeCustomer, today: string, result: AutosaveRunResult): Promise<void> {
  let metadata = customer.metadata ?? {};
  const all = schedulesOf(metadata);
  const due = all.filter((s) => s.status === "active" && s.nextDate <= today);
  if (!all.some((s) => s.status === "active")) {
    // Flag left over without an active schedule: tidy it so search stops returning this wallet.
    await writeSchedules(customer.id, metadata, {});
    return;
  }
  if (due.length === 0) return;

  const ledger: Ledger = await loadLedger(customer.id);
  const save = async (envelopeId: string, schedule: Schedule | null) => {
    const updated = await writeSchedules(customer.id, metadata, { [envelopeId]: schedule });
    metadata = updated.metadata ?? metadata;
  };

  for (const s of due) {
    result.due++;
    const balance = envelopeCents(ledger, s.envelopeId);
    const left = s.targetCents > 0 ? s.targetCents - balance : Number.POSITIVE_INFINITY;
    if (left < MIN_CHARGE_CENTS) {
      await save(s.envelopeId, null);
      result.completed++;
      continue;
    }

    let added = 0;
    const alreadyCharged = ledger.payments.some((p) => p.envelopeId === s.envelopeId && p.cycle === s.nextDate);
    if (!alreadyCharged) {
      const amount = Math.min(s.weeklyCents, left);
      try {
        const pi = await stripeApi<StripePaymentIntent>(
          "POST",
          "/v1/payment_intents",
          {
            amount,
            currency: "usd",
            customer: customer.id,
            payment_method: s.paymentMethod,
            // Card only: with automatic payment methods (the default since 2023-08-16) a
            // server-side confirm would need a return_url for redirect-based methods.
            payment_method_types: ["card"],
            off_session: true,
            confirm: true,
            description: "Livento auto-save, weekly withdrawal (test mode)",
            metadata: {
              livento_envelope: s.envelopeId,
              livento_kind: "autosave",
              livento_event: (envelopeEventName(ledger, s.envelopeId) ?? "Livento goal").slice(0, 200),
              livento_cycle: s.nextDate,
            },
          },
          { idempotencyKey: `autosave-${customer.id}-${s.envelopeId}-${s.nextDate}` },
        );
        if (pi.status !== "succeeded" && pi.status !== "processing") {
          await save(s.envelopeId, { ...s, status: "failed" });
          result.failed++;
          continue;
        }
        added = pi.status === "succeeded" ? amount : 0;
        result.charged++;
      } catch (err) {
        if (isPermanentFailure(err)) {
          await save(s.envelopeId, { ...s, status: "failed" });
          result.failed++;
        } else {
          result.errors++;
          console.warn(
            `[autosave] charge not made, will retry: status=${isStripeError(err) ? err.status : "?"} code=${isStripeError(err) ? (err.code ?? "-") : "-"}`,
          );
        }
        continue;
      }
    }

    if (s.targetCents > 0 && balance + added >= s.targetCents) {
      await save(s.envelopeId, null);
      result.completed++;
    } else {
      await save(s.envelopeId, { ...s, nextDate: advanceWeekly(s.nextDate, today) });
    }
  }
}

/** Runs every due auto-save once. Returns counts only. */
export async function runAutosave(now: Date = new Date()): Promise<AutosaveRunResult> {
  const result: AutosaveRunResult = { customers: 0, due: 0, charged: 0, failed: 0, completed: 0, errors: 0 };
  const today = utcToday(now.getTime());
  const started = Date.now();
  let page: string | undefined;
  for (let i = 0; i < MAX_SEARCH_PAGES; i++) {
    const found = await stripeApi<StripeSearchResult<StripeCustomer>>("GET", "/v1/customers/search", {
      query: "metadata['livento_autosave']:'1'",
      limit: 100,
      page,
    });
    for (const customer of found.data) {
      if (Date.now() - started > TIME_BUDGET_MS) return result;
      result.customers++;
      try {
        await runCustomer(customer, today, result);
      } catch {
        result.errors++;
        console.warn("[autosave] one wallet failed");
      }
    }
    if (!found.has_more || !found.next_page) break;
    page = found.next_page;
  }
  return result;
}
