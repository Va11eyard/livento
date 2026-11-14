# Livento — how to demonstrate that it works

Live site: https://livento-lilac.vercel.app · Repo: https://github.com/Va11eyard/livento · Bot: https://t.me/livento_help_bot · Status: https://livento-lilac.vercel.app/status

## Proof points judges can check themselves (no account)
1. **Their own inputs change the result.** Ask a judge for a US city and a budget; run onboarding with it. Picks, distances, costs and the weekly amount all change.
2. **Live data:** sports games on Discover are real (NBA, NFL, NHL, MLS, MLB near that city) with "TheSportsDB" on the card. With a Ticketmaster key, concerts and theatre are live too; until then they're labeled "Sample data".
3. **Numbers are computed, not canned:** on an event page, change ticket quantity or hotel nights — the total, the weekly amount and the deadline update instantly.
4. **The wallet really moves (test) money:** Wallet → Add money → Stripe's checkout page → card 4242 4242 4242 4242 → back in Livento with the new balance. Turn on auto-save: the first week is withdrawn now, the next one is scheduled. Withdraw to card refunds it. Every screen says "Stripe test mode".
5. **Ask Livento is real AI, with real math:** ask "How do I afford my goal by March?" — Claude calls Livento's calculators (weekly amount, trim plan, events, hotel/map links), so every number traces back to data.
6. **Upload a real bank CSV** (any bank's "download transactions" export) on Insights → spending by category and month; pick what to spend less on and see how much sooner each goal is reached. Only the summary is kept, in the browser.
7. **Telegram on stage:** open @livento_help_bot on a judge's phone → Start → pick a city and interests with buttons → top picks arrive; /profile, /quote, "Open Livento" opens the app inside Telegram. Or link from the site: Discover → "Alerts on Telegram".
8. **Nothing is faked:** /status lists each integration as Live / Test mode / Sample data / Off, and "Run check" calls the real endpoints.

## 2-minute live script (inside the 5-minute pitch)
| Time | Action | What to say |
|---|---|---|
| 0:00 | Landing → move the cursor, then "Start planning" | "Spend on memories, not impulses." |
| 0:15 | Onboarding with a judge's city + $150/month | "Eight questions, no account." |
| 0:35 | Discover: picks with "why this" (a real game near them) | "Real events near you, ranked for you — every reason shown." |
| 0:50 | Event → tickets to 2 → total + weekly amount update | "The full cost, not the sticker price — every estimate labeled." |
| 1:05 | Demo unlock → envelope → Turn on auto-save → Stripe test card | "Your Livento wallet saves for you every week, automatically." |
| 1:25 | Ask Livento: "How do I afford this by March?" | "An AI finance helper whose numbers come from our calculators." |
| 1:45 | Telegram: Start → picks on the judge's phone | "And it lives where you already chat." |

## Backup plan
- Keep a second tab already on Discover with the sample profile loaded (`/onboarding?sample=1`) and Premium demo-unlocked.
- If venue Wi-Fi fails: run `npm run dev` locally (sample data works offline; live events, AI and Stripe need the network).
- Record a 60–90 s screen capture of the script above as a last resort.

## Before the pitch (checklist)
- [ ] /status: AI live, Wallet test mode, Telegram live, Live sports live.
- [ ] Telegram: `node scripts/telegram-setup.mjs --avatar` ran once after the last deploy; description picture set in @BotFather.
- [ ] Open the live site on a phone once (mobile layout check).
- [ ] Clear demo data in the presenting browser ("Clear my data" in the footer) and rehearse once.
