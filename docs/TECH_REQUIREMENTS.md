# Livento — Technical Requirements (MVP)

As of 2026-11-14 · Zimran Business Cup 2.0 (24-hour build)

## 1. Overview

Livento is a web app that turns everyday spending into planned experiences: it finds events, shows the full cost, and saves for them in a Livento wallet. Motto: **"Spend on memories, not impulses."** Target users: US adults aged 25–45. The core must work for real; judges must be able to use it without signing up.

**User journey:** onboarding quiz → personalized event recommendations → pick an event → see its full cost → compare "spend $200 now" vs "save for the $550 one" → save in a wallet envelope (automatic weekly withdrawal) → get a trip roadmap → see where your money goes → ask the AI finance helper.

| Tier | What it includes |
| --- | --- |
| Free | Event catalogue (live sports via TheSportsDB; Ticketmaster when keyed), personalized recommendations, full cost, alerts (email or Telegram bot), profile page, Ask Livento |
| Premium ($4.99/mo or $39/yr, test price, shown transparently) | Livento wallet with an envelope per goal, automatic weekly withdrawal from the card (auto-save), spend-vs-save comparator, trip roadmap, spending breakdown from a bank statement |

**Judge path:** "Try with a sample profile" (labeled sample) + "Demo unlock (no charge)" for Premium. A test-mode checkout shows the real payment flow.

**Hard rules:** no real money is held, no bank credentials, no scraping, no loans, no lotteries. Every estimate and every sample is labeled.

## 2. Stack and architecture

One Next.js 16 (App Router, TypeScript) app on Vercel: pages and server API routes in a single deploy; user state lives in the browser.

```text
Browser (React pages, localStorage: profile, envelopes, premium flag)
   │  fetch JSON
   ▼
Next.js on Vercel
   ├─ Pages: landing + 7 app screens
   ├─ API routes (rate-limited, with fallbacks) ──► Ticketmaster Discovery API (events, prices, sale dates)
   │                                            ├─► Claude API (re-rank, roadmap text, ambiguous spend lines)
   │                                            ├─► Checkout (test mode)
   │                                            ├─► Telegram Bot API + email API (alerts)
   │                                            └─► Upstash Redis / Vercel KV (alerts, cache, logs)
   └─ Vercel Cron (daily) → /api/cron/alerts
```

- **Frontend:** React pages, plain CSS ported from the Loop Dept reference, Radix UI Primitives for accessible interactive parts. No Tailwind.
- **State:** localStorage (`livento:v1`) for profile, envelopes, saved events, premium flag. No accounts.
- **Server:** route handlers with input validation, per-IP rate limits and fallbacks.
- **Storage:** Upstash Redis or Vercel KV (free tier) for alert subscriptions, event cache, anonymous interaction logs. In-memory fallback when not configured.
- **LLM:** Anthropic SDK, model `claude-opus-5-5`, structured JSON output, server-side only, refusal fallbacks enabled, rule-based fallback on any failure. The LLM never produces a price or a date.
- **Payments:** test-mode checkout only. Stripe may not support a Kazakhstan-based entity; a merchant-of-record (Paddle, Lemon Squeezy) is the post-hackathon option.

## 3. Functional requirements

| ID | Requirement | Tier |
| --- | --- | --- |
| FR-1 | Landing page (Loop Dept design, Livento content) with a CTA to onboarding | Free |
| FR-2 | Onboarding quiz, 8–10 steps: interests/categories, favourite artists or genres (typed), home city + travel radius, monthly fun budget, hotel budget per night, travel cost per trip, vacation days left, preferred months. Saved in localStorage; no account | Free |
| FR-3 | Catalogue: live Ticketmaster events near the user (concerts, theatre, sports, family) + a curated big-experiences list with official links and prices labeled "estimate" | Free |
| FR-4 | Recommendations: top 8 with a one-line "why this"; like / skip updates the profile | Free |
| FR-5 | Event alerts: subscribe by email or Telegram bot; a daily job sends new events matching saved interests | Free |
| FR-6 | Event detail: full cost estimate (tickets, estimated fees, travel, hotel nights, buffer — each editable and labeled) + presale and on-sale dates | Free (detail) / Premium (plan) |
| FR-7 | Savings plan: weekly amount needed by the on-sale or event date; add to an envelope | Premium |
| FR-8 | Livento wallet (user decision, 2026-11-14): an envelope per goal funded by card; auto-save withdraws the weekly amount from the saved card every week (daily job) and stops at the goal; withdraw back to the card anytime (refund). Stripe test mode only; balances come from Stripe (PaymentIntents and refunds per customer); the wallet is linked to the browser by a signed token | Premium |
| FR-9 | Spend-vs-save comparator: from an envelope balance and two events, show "go now" (what's left, weeks to reach B) vs "skip" (date B is reached) | Premium |
| FR-10 | Roadmap: AI itinerary per event (vacation request date, presale reminders, travel options, hotel deep links to Booking/Google Hotels with dates and city prefilled, day-of checklist) | Premium |
| FR-11 | Spending breakdown: upload a bank CSV or use a labeled sample statement; spending by category and month (nothing is labeled "impulse"); the user picks categories and a percentage to spend less, and sees how much sooner each goal is reached. The summary is kept in the browser; the file isn't kept | Premium |
| FR-12 | Pricing page and paywall: test-mode checkout + demo unlock | — |
| FR-13 | Sample mode: one click loads a labeled sample profile | — |
| FR-14 | Anonymous interaction log (like, skip, save) to enable item-based recommendations later | — |
| FR-15 | Profile page: cover (preset or photo), avatar, name, bio, stats, goals, upcoming plans, motivational quote (random, own text, or AI-written about the user's goals). Stored in the browser | Free |
| FR-16 | Ask Livento: AI finance helper (Claude with tools: savings plan, events, cost plan, trim plan, hotel/map links). All numbers come from tools; actions are deterministic links. Also answers in the Telegram bot | Free |
| FR-17 | Telegram bot: link the web profile by deep link, or set city and interests in the chat (buttons); /picks, /profile, /quote, /stop; profile kept on a pinned card (no database needed); "Open Livento" Mini App | Free |

## 4. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Signup | None. Profile, envelopes, spending summary and profile photos live in localStorage; the wallet lives in Stripe (test mode), linked to the browser. Email or Telegram chat only for alerts, with consent |
| Security | All keys server-side only. Per-IP rate limit on every API route. No raw upstream errors returned to the browser |
| Privacy | Uploaded CSV is parsed in memory; only the summary is kept, in the browser. Card details are entered on Stripe's page, never on Livento. Never accept bank credentials or SSNs |
| Honesty | Label every estimated price and every sample record. No invented testimonials, savings or user counts. Disclose affiliate links if added |
| Data terms | No scraping. Follow Ticketmaster API terms (attribution, branding, caching). Hotels are outbound links only |
| Performance | Landing LCP < 2.5 s on 4G. API responses < 3 s. Event queries cached 1 hour |
| Accessibility | Keyboard navigation, visible focus, alt text, `prefers-reduced-motion` fallbacks |
| Resilience | If Ticketmaster or the LLM fails, fall back to cached or labeled sample events and rule-based text; the judge path never breaks |
| Responsive | Verified at 390×844, 768×1024, 1440×900 |
| Pricing | Price shown before checkout; no hidden renewals; one-click cancel (California auto-renewal rules) |

## 5. Data sources and external APIs

| Source | Used for | Limits and rules |
| --- | --- | --- |
| Ticketmaster Discovery API (free key) | Events, venues, price ranges, presale/on-sale dates | Default quota 5,000 calls/day. Price ranges may exclude fees → fees added as a labeled estimate. Ticketmaster inventory only |
| `data/experiences.json` (hand-made) | Theme parks, festivals, signature experiences | Static; prices only if verified on the official site, otherwise "Price varies — check the official site"; no third-party logos or photos |
| Booking.com / Google Hotels search URLs | Hotel step of the roadmap | Links only (Booking's Demand API requires a signed affiliate contract) |
| Claude API | Re-ranking, itinerary text, ambiguous spend lines | Structured JSON; never the source of a price or date |
| Telegram Bot API | Alert bot | Free |
| Transactional email API (e.g. Resend) | Alerts for US users | Free tier |
| Upstash Redis / Vercel KV | Alert subscriptions, event cache, interaction log | Free tier; in-memory fallback |
| `data/sample-*.json/.csv` (hand-made) | Judge path, insights demo | Fictional and labeled |

Not available by design: Amadeus Self-Service (portal shut July 2026), Eventbrite public event search (closed 2019), Spotify extended API access (established businesses only) — favourites are typed by hand.

## 6. Core logic

All numbers come from rules and data; the LLM only re-orders and writes words. Weights are starting values to tune.

**Recommendation score** (each factor 0–1):

`score = 0.35·match + 0.20·distance + 0.20·price + 0.15·date + 0.10·novelty`

- match: overlap of the event's tags (category, genre, sub-genre, attraction) with onboarding interests and liked tags; 1.0 if the attraction equals a typed favourite.
- distance: 1 within radius r; beyond it `max(0, 1 − (d − r) / r)`; unknown distance = 0.6.
- price: 1 if total cost ≤ monthly fun budget b; else `max(0, 1 − (cost − b) / 2b)`; unknown price = 0.5.
- date: 1 if month is preferred and needed nights fit vacation days; else 0.5; undated = 0.6.
- novelty: 1 if the category isn't among the last 3 saved goals; else 0.5.
- Top 20 by score → LLM returns top 8 with a "why this" line. LLM failure → rule order + template line.
- Later: item-based CF from FR-14 logs, then user-based. Not in the MVP (cold start).

**Cost model** (every line editable, every default labeled):

| Line | Default |
| --- | --- |
| Tickets | quantity (1) × Ticketmaster min price (or `priceMax` if min missing); "price TBA" → user enters |
| Fees | 15% of tickets, labeled "estimated fees" |
| Travel | 0 within the radius; beyond it the user's "travel cost per trip" |
| Hotel | nights (1 if beyond radius, else 0) × user's "hotel budget per night" |
| Buffer | 10% of subtotal |

**Savings plan:** deadline = public on-sale date if in the future, else event date (none → 8 weeks from today).
`weekly = ceil( max(0, total − envelope) / max(1, ceil((deadline − today) / 7)) )`

**Spend-vs-save comparator** (weekly contribution c = monthly fun budget ÷ 4.33):
- Go now: remaining = balance − costA; weeks to B = `ceil(max(0, costB − remaining) / c)`; flag if after B's deadline.
- Skip: weeks to B = `ceil(max(0, costB − balance) / c)`.
- Neutral wording; never tell the user which to pick.

**Spending breakdown (no "impulse" labels):**
1. Normalize CSV rows to date, description, amount (spend = negative or a debit column); income and transfers are excluded.
2. Merchant rules assign a category; unmatched merchants → one LLM batch call for a category only (skipped without a key).
3. Output per month: total, covered days, category totals, top merchants. Category monthly average = total ÷ covered days × 30.44.
4. Trim plan (client): freed per month = Σ picked category averages × percent; per week = ÷ 4.33; goal weeks sooner = ceil(remaining ÷ weekly) − ceil(remaining ÷ (weekly + freed)).

## 7. API contract

All JSON; exact TypeScript shapes in `lib/types.ts`.

| Route | Method | Input | Output | Fallback |
| --- | --- | --- | --- | --- |
| `/api/events` | GET | `city, state, lat, lng, radius, categories, from, to, keyword`, or `id=<event id>` for one event (shared links, alerts) | `EventsResponse` | sample events, `source: "sample"` + notice |
| `/api/recommend` | POST | `RecommendRequest` | `RecommendResponse` | rule order + template "why" |
| `/api/plan` | POST | `PlanRequest` | `PlanResponse` | pure rules |
| `/api/roadmap` | POST | `RoadmapRequest` | `RoadmapResponse` | template steps |
| `/api/insights` | POST | `InsightsRequest` (CSV text or `sample: true`) | `InsightsResponse` | rules only |
| `/api/alerts` | POST | `AlertSubscribeRequest` | `AlertSubscribeResponse` | `ok: false` + message if not configured |
| `/api/telegram` | POST | Telegram webhook update | 200 | — |
| `/api/checkout` | POST | `CheckoutRequest` | `CheckoutResponse` | `{ demo: true }` → demo unlock |
| `/api/cron/alerts` | GET | `Authorization: Bearer CRON_SECRET` | `{ sent }` | — |
| `/api/log` | POST | `{ anonId, eventId, action }` | `{ ok }` | in-memory |
| `/api/health` | GET | — | `HealthResponse` (configuration only, no key values) | — |

## 8. Data models

Client (localStorage `livento:v1`): `AppState { profile, envelopes, savedEvents, premium, anonId }` — see `Profile`, `Envelope`, `LiventoEvent` in `lib/types.ts`.

Server (Redis/KV):

| Key | Value | TTL |
| --- | --- | --- |
| `events:<hash of query>` | cached `LiventoEvent[]` | 1 hour |
| `alert:<id>` | `{ channel, address, chatId, interests, favourites, city, createdAt, lastSentAt }` | none |
| `alerts:index` | set of alert ids | none |
| `ix:<YYYY-MM-DD>` | list of `{ anonId, eventId, action }` | 90 days |
| `rl:<ip>:<route>` | request counter | 60 s |

## 9. Design system and UI

See `DESIGN.md`. Tokens: ink `#141414`, white, accent yellow `#fffa8d`, surface `#f2f2ef`, line `#ccc`, focus `#3461ff`. Fonts: Oswald (wordmark), TASA Orbiter (headings/UI), Inter (body). Pill buttons, "01 / Kicker" labels, display headings, top-bordered sections, dark accordion, yellow footer.

Landing mapping: header nav (LIVENTO · How it works · Experiences · Pricing · Start) · hero (LIVENTO wordmark, rails "Concerts / Theatre / Festivals / Cinema" and "Plan · Save · Go", pointer trail of 4 photos + 3 loops, motto, "Start planning ↗" / "How it works ●") · 01 Why Livento · 02 Experiences (4 cards) · 03 How it works (dark accordion) · 04 Pricing (replaces the testimonial) · yellow footer "Where do you want to be next?".

App screens: `/onboarding`, `/discover`, `/event/[id]`, `/envelopes`, `/roadmap/[id]`, `/insights`, `/pricing`.

## 10. Project structure, environment, setup

```text
livento/
  app/            page.tsx (landing), onboarding/, discover/, event/[id]/, envelopes/, roadmap/[id]/, insights/, pricing/, api/*
  components/     landing/* (Trail, LandingNav…), app/* (AppNav, EventCard, CostTable, Comparator, EnvelopeBar…)
  lib/            types.ts, catalog.ts, ticketmaster.ts, thesportsdb.ts, score.ts, cost.ts, compare.ts, spending.ts, llm.ts, assistant.ts,
                  stripe.ts, wallet.ts, autosave.ts, alerts.ts, telegram*.ts, quotes.ts, kv.ts, ratelimit.ts, geo.ts, storage.ts
  data/           experiences.json, sample-profile.json, sample-events.json, sample-statement.csv
  public/assets/  fonts/, licenses/, trail/, CREDITS.md, assets.json
  scripts/        download-assets.mjs
  DESIGN.md  README.md  .env.example  vercel.json
```

Environment variables (`.env.local`; all optional — the app falls back when missing):

| Variable | Purpose |
| --- | --- |
| `TICKETMASTER_API_KEY` | live events |
| `ANTHROPIC_API_KEY` | re-rank, roadmap text, ambiguous spend lines |
| `STRIPE_SECRET_KEY` (test mode) | checkout session |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | alert bot (@BotFather) |
| `RESEND_API_KEY`, `ALERTS_FROM_EMAIL` | email alerts |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | subscriptions, cache, logs |
| `CRON_SECRET` | protects `/api/cron/alerts` |
| `NEXT_PUBLIC_SITE_URL` | absolute links in alerts |

Setup: `npm install` → copy `.env.example` to `.env.local` → `npm run assets` (fonts/media, SHA-256 verified) → `npm run dev` → http://localhost:3000. `npm run build` must pass before every deploy. Deploy by importing the GitHub repo in the Vercel dashboard, adding env vars, and keeping the cron in `vercel.json`.

## 11. Acceptance criteria

- [ ] `npm run build` and lint pass.
- [ ] No secrets in the client bundle (search `.next/static` for key prefixes).
- [ ] Live Ticketmaster results for 3 US cities (New York, Chicago, Los Angeles).
- [ ] With every key removed, the app works end to end on labeled sample data.
- [ ] Sample profile → recommendations → event detail → comparator → envelope → roadmap → insights all work.
- [ ] Cost lines editable; total and weekly amount update instantly; every estimate labeled.
- [ ] Demo unlock opens Premium; test-mode checkout returns to the app.
- [ ] Telegram bot message and email alert arrive for a test subscription.
- [ ] CSV upload works with a real bank export; the file is not stored.
- [ ] Landing at 390×844, 768×1024, 1440×900: no horizontal overflow; trail works with mouse and touch.
- [ ] Reduced motion shows static posters; keyboard reaches every control with a visible focus ring.
- [ ] Outbound links work; image credits listed in `public/assets/CREDITS.md`.

## 12. Out of scope and roadmap

Not in the MVP: holding real money, automatic withdrawals, bank linking; Spotify import; scraping; loans, credit products, lotteries; user accounts; collaborative filtering; in-app ticket purchase.

After the hackathon, in order:
1. Planner (this MVP).
2. Affiliate programs for tickets and hotels.
3. Partner-funded save-to-buy: wallet held by a partner bank; organizers add a match for money saved toward their events.
4. Event Credit Builder with a partner bank: monthly payments into a deposit the user owns, reported to credit bureaus, unlocked before the event.
5. Item-based, then user-based recommendations once interaction logs are large enough.

Each step needs its own legal review; steps 3 and 4 need a bank partner.
