# Livento — how to demonstrate that it works

Live site: https://livento-lilac.vercel.app · Repo: https://github.com/Va11eyard/livento

## Proof points judges can check themselves (no account)
1. **Their own inputs change the result.** Ask a judge for a US city and a budget; run onboarding with it. Recommendations, distances, costs and the weekly amount all change.
2. **Live data (once `TICKETMASTER_API_KEY` is set):** Discover shows real upcoming events near that city with "Event data: Ticketmaster" on each card and no "Sample data" banner. Open the event's ticket link — it goes to the real event page.
3. **Numbers are computed, not canned:** on an event page, change ticket quantity or the hotel nights — the total, the weekly amount and the deadline update instantly.
4. **AI is real but bounded (once `ANTHROPIC_API_KEY` is set):** the "why this" lines and roadmap wording come from the model; every price and date still comes from data/rules (so it can't invent a price).
5. **Upload a real bank CSV** (any bank's "download transactions" export) on Insights → months, categories and likely impulse spend appear. Nothing is stored.
6. **Telegram alert live on stage** (once the bot is configured): Discover → "Alerts on Telegram" → the bot replies to the judge's phone.
7. **Works without keys too:** every integration falls back to clearly labeled sample data — the judge path never dead-ends.

## 2-minute live script (inside the 5-minute pitch)
| Time | Action | What to say |
|---|---|---|
| 0:00 | Landing → move the cursor, then "Start planning" | "Livento turns impulse spending into planned experiences." |
| 0:15 | Onboarding with a judge's city + $150/month | "Eight questions, no account." |
| 0:40 | Discover: top picks with "why this" | "Live events near you, ranked for you — every reason shown." |
| 1:00 | Event → edit tickets to 2 → total + weekly amount update | "The full cost, not the sticker price — every estimate labeled." |
| 1:15 | Demo unlock → Create envelope → Comparator | "Spend $62 now, or save for the $76 jazz weekend? Both paths, side by side." |
| 1:35 | Roadmap | "Dated steps: presale, on-sale, vacation request, hotel links." |
| 1:50 | Insights → sample statement (or a real CSV) | "$425 a month of impulse spend = this trip." |

## Backup plan
- Keep a second tab already on Discover with the sample profile loaded (`/onboarding?sample=1`).
- If venue Wi-Fi fails: run `npm run dev` locally and demo on `http://localhost:3000` (sample data works offline except live events/AI).
- Record a 60–90 s screen capture of the script above as a last resort.

## Before the pitch (checklist)
- [ ] Ticketmaster + Anthropic keys added in Vercel and redeployed (live data + AI).
- [ ] Telegram bot webhook set (docs/DEPLOY.md §3).
- [ ] Open the live site on a phone once (mobile layout check).
- [ ] Clear demo data in the browser you present from ("Clear my data" in the footer) and rehearse once.
