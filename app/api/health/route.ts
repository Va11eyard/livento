import { emailConfigured, telegramConfigured } from "@/lib/alerts";
import { json } from "@/lib/http";
import { isKvConfigured } from "@/lib/kv";
import { isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { stripeTestKey } from "@/lib/stripe";
import { hasTicketmasterKey } from "@/lib/ticketmaster";
import type { HealthResponse, IntegrationStatus } from "@/lib/types";

/**
 * GET /api/health — which integrations are configured on this deployment, plus the
 * deployed commit. Reports configuration only: it never returns a key or its value.
 */
export async function GET(request: Request) {
  const limited = await rateLimit(request, "health", RATE_LIMITS.general);
  if (limited) return limited;

  const stripeTest = stripeTestKey() !== null; // same rule as before: sk_test_ / rk_test_ only

  const integrations: IntegrationStatus[] = [
    hasTicketmasterKey()
      ? {
          key: "events",
          name: "Live events (Ticketmaster)",
          state: "live",
          detail: "Discover loads real upcoming events near the user's city, cached for an hour.",
        }
      : {
          key: "events",
          name: "Live events (Ticketmaster)",
          state: "sample",
          detail: "No API key: Discover shows labeled, fictional sample events plus curated experiences.",
        },
    {
      key: "sports",
      name: "Live sports (TheSportsDB)",
      state: "live",
      detail: hasTicketmasterKey()
        ? "Backup for sports: real upcoming NBA, NFL, MLB, NHL and MLS games near the user when Ticketmaster is unavailable. Free public API; no prices, so ticket prices are labeled estimates."
        : "Real upcoming NBA, NFL, MLB, NHL and MLS games near the user. Free public API; no prices, so ticket prices are labeled estimates.",
    },
    isLlmConfigured()
      ? {
          key: "ai",
          name: "AI wording",
          state: "live",
          detail:
            "Answers in Ask Livento, re-ranks picks and writes the \"why this\" lines and roadmap text. Numbers always come from Livento's calculators.",
        }
      : {
          key: "ai",
          name: "AI wording",
          state: "off",
          detail: "No API key: Ask Livento says it isn't connected, and picks keep the rule-based order and template text.",
        },
    isKvConfigured()
      ? {
          key: "storage",
          name: "Storage (Redis)",
          state: "live",
          detail: "Alert subscriptions, the event cache and rate limits persist across server instances.",
        }
      : {
          key: "storage",
          name: "Storage (Redis)",
          state: "off",
          detail: "In-memory only: alert sign-ups are disabled and the cache resets between instances.",
        },
    telegramConfigured()
      ? {
          key: "telegram",
          name: "Telegram alerts",
          state: "live",
          detail: isKvConfigured()
            ? "The bot sends your top picks on Start and new matches once a day."
            : "The bot sends your top picks on Start. Daily alerts turn on once storage is connected.",
        }
      : {
          key: "telegram",
          name: "Telegram alerts",
          state: "off",
          detail: "Bot token or username not set.",
        },
    emailConfigured()
      ? {
          key: "email",
          name: "Email alerts",
          state: "live",
          detail: "New matches are emailed to subscribers.",
        }
      : {
          key: "email",
          name: "Email alerts",
          state: "off",
          detail: "Email API key or sender not set.",
        },
    stripeTest
      ? {
          key: "payments",
          name: "Checkout",
          state: "test",
          detail: "Stripe test mode: no real charge (test card 4242 4242 4242 4242).",
        }
      : {
          key: "payments",
          name: "Checkout",
          state: "demo",
          detail: "Payments not connected: Premium uses a free demo unlock.",
        },
    stripeTest
      ? {
          key: "wallet",
          name: "Livento wallet",
          state: "test",
          detail:
            "Add money by card, automatic weekly withdrawals, and withdrawals back to the card. Stripe test mode: no real money moves.",
        }
      : {
          key: "wallet",
          name: "Livento wallet",
          state: "off",
          detail: "No Stripe test key: the wallet can't take money yet.",
        },
    process.env.CRON_SECRET?.trim()
      ? {
          key: "cron",
          name: "Daily alert job",
          state: "live",
          detail: "Runs every day at 15:00 UTC and sends new matches to subscribers.",
        }
      : {
          key: "cron",
          name: "Daily alert job",
          state: "off",
          detail: "CRON_SECRET not set, so the scheduled job is refused.",
        },
  ];

  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;

  const body: HealthResponse = {
    ok: true,
    integrations,
    deployment: {
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      commit: sha?.slice(0, 7),
      commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0]?.slice(0, 120),
      commitUrl: sha && owner && slug ? `https://github.com/${owner}/${slug}/commit/${sha}` : undefined,
      branch: process.env.VERCEL_GIT_COMMIT_REF,
      region: process.env.VERCEL_REGION,
    },
    checkedAt: new Date().toISOString(),
  };

  return json(body, 200, { "Cache-Control": "no-store" });
}
