# Livento design system

One design for every screen, derived from the user-supplied **Loop Dept** reference
(monochrome creative-studio site with a pointer-driven trail of photos and GIFs).
Tokens live in `app/globals.css`; landing-only styles live in `app/landing.css`
scoped under `.lv-landing`; app screens use CSS modules plus the shared utilities.

## Voice
- Motto: **"Spend on memories, not impulses."** (the motto only: never label a user's purchases as "impulse"; show spending by category and let the user choose what to trim)
- Short, concrete, friendly. Numbers with units ("$212 total", "$18/week").
- Never invent testimonials, user counts, savings or results.
- Every non-fact number carries a label: `.tag.estimate` ("Estimate") or `.tag.sample` ("Sample data").
- Neutral money language: show options, never shame ("You could…", not "You wasted…").

## Color
| Token | Value | Use |
|---|---|---|
| `--ink` | `#141414` | text, borders, primary buttons, dark section |
| `--ink-soft` | `#616161` | secondary text, hints |
| `--paper` | `#ffffff` | page background |
| `--yellow` | `#fffa8d` | the one accent: hover, highlight, progress fill, footer, estimate tags |
| `--surface` | `#f2f2ef` | light section background (works grid), cards |
| `--line` | `#cccccc` | section rules, dividers |
| `--line-soft` | `#dededd` | header border |
| `--focus` | `#3461ff` | focus ring only (3px, 4px offset) |
| `--ok` / `--warn` / `--danger` | `#1f7a3d` / `#8a5a00` / `#b3261e` | status text only, sparingly |

Monochrome first. Yellow is used for emphasis, never as body text color.

## Typography
| Role | Font | Spec |
|---|---|---|
| Wordmark / hero word | Oswald | 600–650, uppercase, tracking −0.06em, slanted `skewX(-12deg)` like the header logo; hero `clamp(80px, min(15vw, 21vh), 210px)` (`clamp(64px, 22vw, 115px)` under 768px) so the motto, lead and CTAs stay above the fold |
| Display heading `.display` | TASA Orbiter | 610, `clamp(40px, 5.6vw, 78px)/0.99`, tracking −0.055em, max 20ch |
| Screen title `.title` | TASA Orbiter | 610, `clamp(30px, 3.6vw, 48px)/1.02`, tracking −0.045em |
| Kicker `.kicker` | TASA Orbiter | 650, 14px, uppercase, tracking 0.035em, format "01 / Label" |
| UI labels, buttons | TASA Orbiter | 650, 14–15px |
| Body | Inter | 16px/1.45; lead text `clamp(16px, 1.28vw, 19px)/1.37` |

Fonts are bundled in `public/assets/fonts` with their licenses in `public/assets/licenses`.

## Layout
- Container `.wrap`: `min(1200px, 100% − 2 × clamp(20px, 4.5vw, 72px))`.
- Fixed header 59px, white, 1px `--line-soft` bottom border; brand left, nav right; "Menu" toggle below 992px.
- Sections `.section`: vertical padding `clamp(55px, 7vw, 102px)` with a 1px top rule.
- Section rhythm on the landing: white → `--surface` (works grid) → `--ink` (dark accordion) → white → `--yellow` footer.
- Breakpoints: 991px (nav collapses), 767px (single column). Verify at 390×844, 768×1024, 1440×900.

## Components
- **Pill button** `.pill`: black fill, white text, 100px radius, min-height 44px; hover = yellow fill + ink text. `.pill.alt` = white fill. `.pill.small` for dense rows. Trailing glyph `↗` (forward) or `●` (secondary).
- **Kicker + display heading** open every section.
- **Card** (event, envelope): image 1.5:1 with `object-fit: cover`, title in TASA 650 `clamp(22px, 2.4vw, 32px)` tracking −0.05em, meta line 14px, `details`/"Discover more" or a pill action. No drop shadows except the trail stamps.
- **Accordion** (how it works, roadmap steps): full-width rows with 1px top rule; summary in TASA 550 `clamp(22px, 3vw, 40px)`; open row summary turns yellow on dark backgrounds.
- **Tags** `.tag`: tiny uppercase pills — `estimate` (yellow), `sample` (dashed, surface), `premium` (ink).
- **Form fields** `.field`: 1px ink border, 12px radius, 44px min height, label above in TASA 650 14px, `.help` text below.
- **Progress** (envelopes): 10px tall track `--surface` with ink outline, fill `--yellow` with ink right edge; show "$X of $Y" beside it.
- **Dialog**: 1px ink border, 32px padding, `min(470px, 90vw)`, backdrop `#14141470`.
- Interactive behavior comes from Radix UI Primitives (Dialog, Accordion, Progress, Slider, Toggle Group, Tabs, Toast), styled through `data-state` attributes. No Tailwind, no other UI kit.

## Motion
- Hero pointer trail: stamps (4 photos + 3 animated loops interleaved) appear along the cursor, ~1.33s life, scale .79→1, fade out with 12px drop; max 7 on screen; "Play the trail" button runs an automatic path.
- Intro card arrives with `cubic-bezier(.19,1,.22,1)` over .75s.
- Everything else: short (≤ 200ms) color/opacity transitions only.
- `prefers-reduced-motion`: static posters instead of GIFs, no trail animation, no smooth scroll.

## Imagery
- Free-licensed photos (Unsplash / Pexels) of crowds, stages, festivals, cinemas; credited in `public/assets/CREDITS.md`, hashed in `public/assets/assets.json`.
- No trademarked imagery: no theme-park castles or characters, no logos, no identifiable artist photos. Name places in text with official links.
- Event images from Ticketmaster are shown only with the event data they belong to.

## Accessibility
- Visible focus ring on every interactive element; keyboard reachable; skip link.
- Alt text on content images; decorative trail images `alt=""` + `aria-hidden`.
- Color is never the only signal (labels on estimates, text on statuses).
