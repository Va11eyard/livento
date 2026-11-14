# Livento

**Spend on memories, not impulses.**

Livento turns impulse spending into planned experiences. Pick concerts, theatre, festivals or a big trip. Livento shows the full cost and how much to set aside each week, then gives you a dated roadmap to get there. It also shows where your impulse money went.

Built for Zimran Business Cup 2.0 (24-hour build) for US adults aged 25–45. No signup: your profile and envelopes stay in your browser.

- Onboarding quiz → personalized recommendations → event detail with a full cost estimate → spend-vs-save comparator → virtual savings envelope → trip roadmap → impulse-spending insights.
- **Free:** event catalogue, recommendations, alerts (email or Telegram).
- **Premium** ($4.99/mo or $39/yr, test price): envelopes, reminder schedule, comparator, roadmap, insights.

## Demo path for judges

1. Open the app and choose **Try with a sample profile** (a labeled Chicago profile).
2. **Discover**: recommendations with a one-line "why this". Without a Ticketmaster key these are labeled **sample events**.
3. Open an event: every cost line (tickets, estimated fees, travel, hotel, buffer) is editable and labeled.
4. Compare "go now" with "save for the bigger one", then add the goal to an envelope.
5. Premium screens: use **Demo unlock (no charge)** on the pricing page. With a Stripe test key, a test-mode checkout is available too (card `4242 4242 4242 4242`).
6. **Roadmap**: dated steps with Booking.com, Google Hotels and Google Maps links prefilled with dates and city.
7. **Insights**: try the labeled sample statement, or upload your own bank CSV. The file is processed in memory and never stored.

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
| `TICKETMASTER_API_KEY` | Live events, prices, presale and on-sale dates | Labeled sample events + notice |
| `ANTHROPIC_API_KEY` | Re-ranking, roadmap wording, ambiguous spend lines (`claude-opus-5-5`) | Rule order, template text, rule-only categories |
| `STRIPE_SECRET_KEY` | Test-mode checkout (`sk_test_…` only; live keys are refused) | `{ demo: true }` → Demo unlock |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | Telegram alert bot | Telegram alerts report "not set up" |
| `RESEND_API_KEY`, `ALERTS_FROM_EMAIL` | Email alerts | Email alerts report "not set up" |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Alert subscriptions, 1-hour event cache, rate limits, interaction log | In-memory store per server instance; alerts disabled |
| `CRON_SECRET` | Protects `/api/cron/alerts` | The cron route always answers 401 |
| `NEXT_PUBLIC_SITE_URL` | Absolute links in emails and checkout return URLs | The request's own origin |

### Alerts setup

- **Telegram:** create a bot with @BotFather, set the token and username, then register the webhook:
  `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-site>/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`.
  Users tap the `t.me/<bot>?start=<id>` link from the app; `/stop` unsubscribes.
- **Email:** Resend API key and a verified sender. Every email has a one-click unsubscribe link.
- **Daily job:** `vercel.json` schedules `GET /api/cron/alerts` once a day (15:00 UTC). Vercel sends `Authorization: Bearer $CRON_SECRET`. Each subscription gets up to 3 new matching events per day and never the same event twice.

## Data sources and limits

| Source | Used for | Limits and rules |
| --- | --- | --- |
| Ticketmaster Discovery API v2 | Events, venues, price ranges, presale/on-sale dates | 5,000 calls/day, 5 req/s; cached 1 hour; price ranges may exclude fees, so fees are a labeled estimate; attribution "Event data: Ticketmaster" |
| `data/experiences.json` | Curated big experiences (theme parks, festivals, conventions) | Official links only; prices and 2027 dates only where shown on the official site (checked 2026-11-14), otherwise "Price varies — check the official site" |
| `data/sample-events.json`, `data/sample-profile.json`, `data/sample-statement.csv` | Judge path and insights demo | Fictional and labeled as sample |
| Booking.com / Google Hotels / Google Maps / Google Flights | Roadmap stay and travel steps | Search links only, with no scraping and no booking |
| Claude API | Re-rank, roadmap wording, merchant categories | Structured output, validated; never the source of a price or a date |
| Telegram Bot API, Resend | Alerts | Free tiers |
| Upstash Redis | Subscriptions, cache, rate limits, logs | Free tier; in-memory fallback |

Not used by design: Amadeus Self-Service (shut down), Eventbrite public search (closed), Spotify extended access. Favourites are typed by hand.

## How it works without keys

Every route has a fallback, so the judge path never breaks:

- `/api/events`: sample events, nearest first, plus curated experiences, with `source: "sample"` and a notice.
- `/api/recommend`: rule score (`0.35 match + 0.20 distance + 0.20 price + 0.15 date + 0.10 novelty`) + template "why".
- `/api/plan`, `/api/roadmap`: pure rules and a deterministic template.
- `/api/insights`: merchant rules only.
- `/api/alerts`: `ok: false` with a clear message. It never pretends to subscribe.
- `/api/checkout`: `{ demo: true }`.

## API

| Route | Method | Notes |
| --- | --- | --- |
| `/api/events` | GET | `city, state, lat, lng, radius, categories, from, to, keyword` |
| `/api/recommend` | POST | Top 8 with "why"; `ranker: "llm" \| "rules"` |
| `/api/plan` | POST | Cost lines, total, deadline, weekly amount |
| `/api/roadmap` | POST | Dated steps; `writer: "llm" \| "template"` |
| `/api/insights` | POST | CSV text (≤ 1 MB, ≤ 5,000 rows) or `sample: true` |
| `/api/alerts` | POST / GET | Subscribe; `GET ?unsubscribe=<id>` |
| `/api/telegram` | POST | Telegram webhook |
| `/api/checkout` | POST | Stripe test mode or `{ demo: true }` |
| `/api/cron/alerts` | GET | Daily alert job (Bearer `CRON_SECRET`) |
| `/api/log` | POST | Anonymous like/skip/save/open, kept 90 days |

Shapes live in `lib/types.ts`. Every route validates input with zod, is rate-limited per IP (60/min; 20/min for LLM routes; 10/min for insights and alerts) and returns `{ error }` without upstream details.

## Honesty rules

- Every estimate and every sample is labeled.
- No invented testimonials, user counts, savings or results.
- No scraping; hotels and travel are outbound links only.
- No money is held, no bank credentials are accepted, no loans, no lotteries.
- Uploaded statements are parsed in memory and discarded.

## Project structure

```text
app/            landing page, app screens (onboarding, discover, event/[id], envelopes, roadmap/[id], insights, pricing), api/*
components/     landing/* and app/* UI components
lib/            types.ts (contract), cost.ts, compare.ts, score.ts, roadmap.ts, impulse.ts, catalog.ts, ticketmaster.ts,
                llm.ts, alerts.ts, kv.ts, ratelimit.ts, http.ts, schemas.ts, cities.ts, geo.ts, dates.ts, storage.ts, client-api.ts
data/           experiences.json, sample-events.json, sample-profile.json, sample-statement.csv
public/assets/  fonts, licenses, trail media, CREDITS.md
docs/           TECH_REQUIREMENTS.md
vercel.json     daily cron for alerts
```

## Credits

Image, font and media credits: [`public/assets/CREDITS.md`](public/assets/CREDITS.md). Event data from Ticketmaster where shown.

## Deploy

Import the GitHub repo in Vercel, add the environment variables you have, and keep the cron in `vercel.json`.
