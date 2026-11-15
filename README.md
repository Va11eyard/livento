# Livento

**Spend on memories, not impulses.**

Livento helps you go to the things you'll remember. It finds concerts, theatre, games, festivals and big trips near you, shows what they really cost, and saves for them in your Livento wallet, a little every week.

Built for Zimran Business Cup 2.0 (24-hour build) for US adults aged 25–45. No signup: your profile lives in your browser, and your wallet is linked to it.

- Onboarding → personalized picks → event page with the full cost → spend-vs-save comparator → wallet envelope with automatic weekly saving → trip roadmap → spending breakdown → Ask Livento (AI finance helper).
- **Free:** events near you (live sports from TheSportsDB; concerts and theatre from Ticketmaster when its key is set), personalized picks, full cost of any event, alerts by email or Telegram, profile page.
- **Premium** ($4.99/mo or $39/yr, test price): Livento wallet with an envelope per goal, automatic weekly withdrawal from your card, spend-vs-save comparator, trip roadmap, spending breakdown from a bank statement.
- **Telegram bot** [@livento_help_bot](https://t.me/livento_help_bot): set your city and interests with buttons (or link your web profile), get top picks, `/profile`, `/quote`, and open the full app as a Telegram Mini App.

## Demo path for judges

1. Open the app and choose **Try a sample profile** (a labeled Chicago profile), or answer the 8 quick questions.
2. **Discover**: picks with a one-line "why this" written by Claude. Sports games are real (TheSportsDB); other events are labeled **sample** until a Ticketmaster key is set.
3. Open an event: every cost line (tickets, estimated fees, travel, hotel, buffer) is editable and labeled. Hotel and map links are on the roadmap.
4. Premium: **Demo unlock (no charge)** on Pricing, or the Stripe test checkout (card `4242 4242 4242 4242`, any future date, any CVC).
5. **Wallet**: create an envelope from an event, **Add money** or **Turn on auto-save** (Stripe test mode: the first week is withdrawn right away, then every week by the daily job), **Withdraw to card** anytime.
6. **Ask Livento** (button on every app page): "How do I afford my goal by March?" Numbers come from Livento's calculators; Claude writes the plan.
7. **Insights**: the labeled sample statement or your own bank CSV → spending by category and month; pick what you'd spend less on and see how much sooner each goal is reached.
8. **Profile**: cover, photo, name, bio, your goals and a motivational quote (new, your own, or one Claude writes about your goals).
9. **Telegram**: tap Start in [@livento_help_bot](https://t.me/livento_help_bot).

## Quick start

```bash
npm install
cp .env.example .env.local   # every key is optional
npm run assets               # fonts and media, SHA-256 verified
npm run dev                  # http://localhost:3000
```

`npm run build` and `npm run lint` must pass before every deploy.

## Environment variables

All optional. See `.env.example` for comments.

| Variable | Purpose | Without it |
| --- | --- | --- |
| `TICKETMASTER_API_KEY` | Live concerts, theatre and more, with prices and on-sale dates | Labeled sample events (sports stay live via TheSportsDB) |
| `ANTHROPIC_API_KEY` | Ask Livento, picks re-ranking and "why" lines, roadmap wording, quotes, merchant categories (`claude-opus-5-5`) | Gemini if set; otherwise rule order and templates, and Ask Livento shows "not connected" |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (optional, default `gemini-3.6-flash`) | Backup AI for the same features when Claude is missing or fails for account reasons (Claude is skipped for 10 minutes); web event search via Grounding with Google Search (paid tier only) | Claude only |
| `STRIPE_SECRET_KEY` | Wallet (add money, auto-save, withdraw) and Premium checkout. `sk_test_…` only; live keys are refused | Wallet shows "not connected"; Premium via Demo unlock |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | Telegram bot | Telegram features hidden |
| `RESEND_API_KEY`, `ALERTS_FROM_EMAIL` | Email alerts | Email alerts hidden |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or Vercel's `KV_REST_API_*`) | Daily alert subscriptions, shared cache, rate limits, interaction log | In-memory per instance; no daily alerts |
| `CRON_SECRET` | Protects the daily jobs | Cron routes answer 401 |
| `NEXT_PUBLIC_SITE_URL` | Absolute links in emails, Telegram and checkout return URLs | The request's own origin |

### Telegram setup

After deploying, run once (PowerShell):

```powershell
$env:TELEGRAM_BOT_TOKEN="<token>"; $env:TELEGRAM_WEBHOOK_SECRET="<same as Vercel>"; $env:SITE_URL="https://<your-site>"; node scripts/telegram-setup.mjs --avatar
```

It sets the webhook (messages and button presses), commands, descriptions, the "Open Livento" Mini App button and, with `--avatar`, the bot photo. The start-screen picture (`public/assets/telegram/bot-description.png`) is set in @BotFather → Edit Bot → Edit Description Picture. The bot keeps each chat's city and interests on a pinned profile card, so `/picks` works without a database; with Redis it also sends new matches daily.

### Daily jobs (`vercel.json`)

- `GET /api/cron/autosave` (14:00 UTC): charges each active weekly auto-save off-session (Stripe test mode), stops when a goal is reached, marks declined cards as failed.
- `GET /api/cron/alerts` (15:00 UTC): up to 3 new matching events per subscription, never the same event twice.

Both require `Authorization: Bearer $CRON_SECRET`, which Vercel sends.

## Data sources and limits

| Source | Used for | Limits and rules |
| --- | --- | --- |
| TheSportsDB (free public key) | Upcoming NBA, NFL, MLB, NHL and MLS games near the user | One next game per team on the free key; ~8 calls/min with caching; no prices, so ticket prices are labeled estimates; credited "Event data: TheSportsDB"; no logo images |
| Ticketmaster Discovery API v2 | Concerts, theatre, family and more, with price ranges and presale/on-sale dates | 5,000 calls/day; cached 1 hour; fees are a labeled estimate; "Event data: Ticketmaster" |
| `data/experiences.json` | Curated big experiences (theme parks, festivals, conventions) | Official links only; prices only where shown on the official site |
| `data/sample-*.json`, `data/sample-statement.csv` | Judge path and insights demo | Fictional and labeled as sample |
| Stripe (test mode) | Wallet ledger (PaymentIntents and refunds per customer), auto-save, Premium checkout | Test mode only: no real money moves |
| Claude API | Ask Livento (tool use), re-rank, roadmap wording, quotes, merchant categories | Every number comes from Livento's calculators or the data, never from the model |
| Booking.com / Google Hotels / Google Maps / Google Flights | Roadmap and helper travel links | Search links only, no scraping |
| Telegram Bot API, Resend, Upstash Redis | Bot, alerts, cache | Free tiers |

Not used by design: Amadeus Self-Service (shut down), Eventbrite public search (closed), Bandsintown (approved partners only), Spotify extended access.

## API

| Route | Method | Notes |
| --- | --- | --- |
| `/api/events` | GET | `city, state, lat, lng, radius, categories, from, to, keyword`; or `?id=<event id>` |
| `/api/recommend` | POST | Top 8 with "why"; `ranker: "llm" \| "rules"` |
| `/api/plan`, `/api/roadmap` | POST | Cost lines, weekly amount; dated steps |
| `/api/insights` | POST | CSV text (≤ 1 MB) or `sample: true` → spending by category and month |
| `/api/assistant` | POST | Ask Livento chat with tools (Claude, Gemini as backup); `{ off: true }` without an AI key |
| `/api/quote` | POST | One motivational line about the user's goals; curated fallback |
| `/api/wallet`, `/api/wallet/{summary,deposit,confirm,withdraw,autosave}` | POST | Wallet; the token travels in the body only |
| `/api/checkout`, `/api/checkout/session` | POST | Premium test checkout; confirm or cancel the test subscription |
| `/api/alerts` | POST / GET | Subscribe; `GET ?unsubscribe=<id>` |
| `/api/telegram` | POST | Telegram webhook (secret header) |
| `/api/cron/alerts`, `/api/cron/autosave` | GET | Daily jobs (Bearer `CRON_SECRET`) |
| `/api/health` | GET | Which integrations are live, deployed commit (no key values) |
| `/api/log` | POST | Anonymous like/skip/save/open |

Shapes live in `lib/types.ts`. Every route validates input with zod, is rate-limited per IP and returns `{ error }` without upstream details. `/status` shows the integrations and runs a live check.

## Honesty rules

- Every estimate and every sample is labeled; nothing labels a person's purchases as "impulse".
- No invented testimonials, user counts, savings or results; quotes are original lines, not attributed to anyone.
- The wallet runs only in Stripe test mode and every money screen says so. A real launch would hold money through a licensed partner.
- No scraping, no bank credentials, no loans, no lotteries. Bank statements are read once to build a summary; the file isn't kept.

## Project structure

```text
app/            landing, onboarding, discover, event/[id], envelopes (wallet), roadmap/[id], insights, profile,
                assistant, pricing, status, api/*
components/     landing/* and app/* UI components (Assistant, AppNav, EventCard, …)
lib/            types.ts (contract), catalog.ts, ticketmaster.ts, thesportsdb.ts, cost.ts, compare.ts, score.ts,
                roadmap.ts, spending.ts, llm.ts, assistant.ts, stripe.ts, wallet.ts, autosave.ts, alerts.ts,
                telegram*.ts, quotes.ts, kv.ts, ratelimit.ts, schemas.ts, storage.ts, client-api.ts, …
data/           experiences.json, sample-events.json, sample-profile.json, sample-statement.csv
scripts/        telegram-setup.mjs, test mocks for Stripe and Telegram
public/assets/  fonts, licenses, trail media, Telegram images, CREDITS.md
docs/           TECH_REQUIREMENTS.md, DEPLOY.md, DEMO.md
```

## Credits

Image, font and media credits: [`public/assets/CREDITS.md`](public/assets/CREDITS.md). Event data from TheSportsDB and Ticketmaster where shown.
