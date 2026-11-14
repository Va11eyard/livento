# Keys, deploy and Telegram bot — setup checklist

Owner: teammate (keys + deploy + bot). Everything here is configuration; no code changes needed.

**Secrets rule:** keys go into Vercel → Project → Settings → Environment Variables (and your own local `.env.local`). Never commit them, never paste them into GitHub issues, PRs or public chats. The repo is public.

## 1. Ticketmaster (live events)
1. Sign up at https://developer.ticketmaster.com → My Apps → copy the **Consumer Key**.
2. Env: `TICKETMASTER_API_KEY`. Default quota is 5,000 calls/day.

## 2. Anthropic (recommendations text, roadmap, spending categories)
1. https://console.anthropic.com → API Keys → create a key; set a monthly spend limit.
2. Env: `ANTHROPIC_API_KEY`.

## 3. Telegram bot (event alerts)
1. Open **@BotFather** in Telegram → `/newbot` → name `Livento` → username, e.g. `livento_alerts_bot`.
2. Env: `TELEGRAM_BOT_TOKEN` (from BotFather), `TELEGRAM_BOT_USERNAME` (without `@`), `TELEGRAM_WEBHOOK_SECRET` (any random string, letters/digits).
3. After the first deploy, point Telegram at the app:
   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```

## 4. Upstash Redis (alert subscriptions, cache, logs)
1. https://upstash.com → Create Database (Redis, regional, free) → REST API section.
2. Env: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
   (If you add Upstash through the Vercel Marketplace instead, the variable names may differ — tell the team which names you got.)

## 5. Email alerts (optional)
1. https://resend.com → API Keys.
2. Env: `RESEND_API_KEY`, `ALERTS_FROM_EMAIL` (use `onboarding@resend.dev` for testing; it only delivers to your own address until a domain is verified).

## 6. Test-mode checkout (optional)
1. https://dashboard.stripe.com → switch to **Test mode** → Developers → API keys → `sk_test_…`.
2. Env: `STRIPE_SECRET_KEY`. If Stripe isn't available for your account, skip it — the app shows "Demo unlock (no charge)" instead.

## 7. Other variables
- `CRON_SECRET`: random string (e.g. `openssl rand -hex 24`). Vercel sends it as `Authorization: Bearer …` to the daily cron job defined in `vercel.json`.
- `NEXT_PUBLIC_SITE_URL`: the deployed URL, e.g. `https://livento.vercel.app` (used in alert links).

## 8. Deploy on Vercel
1. https://vercel.com → Add New → Project → Import Git Repository → the Livento GitHub repo (you need collaborator access, or the repo owner imports it).
2. Framework preset: Next.js (auto-detected). Build command `next build`, output default.
3. Add every variable from sections 1–7 (Production + Preview), then Deploy.
4. Set the Telegram webhook (section 3.3) with the production domain.

## 9. Smoke test after deploy
- Open the site → "Try a sample profile" → Discover shows live events (no "sample events" banner) with Ticketmaster attribution.
- Open an event → cost plan → "Demo unlock (no charge)" → create an envelope → open the roadmap → Insights with the sample statement.
- Discover → "Alerts on Telegram" → the bot confirms the subscription.
- Vercel → Project → Logs: no errors from `/api/*`.

## 10. Report back to the team
Production URL, which variables are set, and any errors from Vercel logs.
