/* eslint-disable @next/next/no-img-element -- pre-sized local WebP files (see public/assets/assets.json) */
import Link from "next/link";
import { preload } from "react-dom";
import LandingNav from "@/components/landing/LandingNav";
import Trail from "@/components/landing/Trail";
import WishDialog from "@/components/landing/WishDialog";
import { PRICING } from "@/lib/types";
import "./landing.css";

/*
 * Landing page in the Loop Dept design-template style, with Livento content.
 * Styles: app/landing.css, all scoped under .lv-landing.
 */

const CATEGORIES = ["Concerts", "Theatre", "Festivals", "Cinema", "Big experiences"];

/** Section 01 roadmap. Plain content in an ordered list: nothing here is a control. */
const ROADMAP = [
  { title: "Discover", text: "Events near you, ranked for your interests and budget." },
  { title: "Plan", text: "The full cost: tickets, fees and travel, plus a hotel when the trip needs one." },
  { title: "Save", text: "Add money to your Livento wallet, or turn on auto-save and a weekly amount moves in from your card." },
  { title: "Go", text: "Dated steps to the day, hotel links for trips out of town and a day-of checklist." },
];

const EXPERIENCES = [
  {
    title: "Concerts",
    label: "Live music",
    image: "/assets/trail/concert.webp",
    alt: "A crowd with raised hands in front of a stage lit in warm yellow",
    line: "Tours, club shows and big nights out, close to home or worth the trip.",
    more: "Tell us the artists and genres you love. Livento matches them to live dates and adds up the real cost: tickets, fees, travel and a hotel if you need one.",
  },
  {
    title: "Theatre & comedy",
    label: "On stage",
    image: "/assets/trail/theatre.webp",
    alt: "Silhouettes of three performers in front of a red stage curtain",
    line: "Musicals, plays and stand-up, with the full cost before you book.",
    more: "From a big musical to a comedy club on a weeknight. Every pick comes with a reason it fits you and a clearly labeled cost estimate.",
  },
  {
    title: "Festivals",
    label: "Outdoors",
    image: "/assets/trail/festival.webp",
    alt: "A festival crowd on the grass watching an outdoor stage at golden hour",
    line: "Weekends worth planning months ahead, travel and a place to stay included.",
    more: "Big weekends can sell out early. Livento shows on-sale dates when they’re known and works out how much your wallet should save each week to be ready.",
  },
  {
    title: "Cinema nights",
    label: "On screen",
    image: "/assets/trail/cinema.webp",
    alt: "An audience in a vintage cinema facing a bright screen",
    line: "Special screenings and film nights that turn an evening into a plan.",
    more: "Smaller plans count too. See what a cheaper night out costs next to the bigger thing you’re saving for, then decide.",
  },
];

const STEPS = [
  {
    title: "Tell us what you love",
    text: "Answer 9 quick questions about what you’re into, where you live and what you’d like to spend. No account, no email.",
  },
  {
    title: "Get picks that fit",
    text: "Get personalized events, each with a one-line reason it fits you. Like or skip to sharpen the next picks.",
  },
  {
    title: "See the full cost",
    text: "Tickets, fees, travel and a hotel night when you need one, added up in one total. Every estimate is labeled, and you can edit it.",
  },
  {
    title: "Save in your wallet",
    premium: true,
    text: "Every goal gets its own envelope in your Livento wallet. Turn on auto-save and the weekly amount is withdrawn from your card automatically. Withdraw it back anytime.",
  },
  {
    title: "Get your roadmap",
    premium: true,
    text: "Dated steps from today to the day of: when to save and buy tickets, and a day-of checklist. Trips out of town also get time off, travel and hotel links for your dates.",
  },
  {
    title: "See where your money goes",
    premium: true,
    text: "Upload a bank statement (CSV) to see your spending by category and month. Pick what you’d spend less on and see how much sooner you’d get there. The summary is saved on this device; the file itself isn’t kept.",
  },
];

const FREE_FEATURES = [
  "Events near you, from concerts to big trips",
  "Personalized recommendations",
  "Event alerts on Telegram",
];

const PREMIUM_FEATURES = [
  "Livento wallet with an envelope per goal",
  "Automatic weekly withdrawal from your card",
  "Spend-vs-save comparator",
  "Trip roadmap",
  "Spending breakdown from your bank statement",
];

export default function Home() {
  // The wordmark is the largest text above the fold; fetch its font early (as the reference did).
  preload("/assets/fonts/oswald.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });

  return (
    <div className="lv-landing">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <LandingNav />

      <main id="main">
        <section className="hero" id="top" aria-labelledby="lv-word">
          <Trail
            copy={
              <>
                <h1 id="lv-word" className="wordmark">
                  Livento
                </h1>
                <h2 className="motto">Spend on memories, not impulses.</h2>
                <p className="hero-lead">
                  Livento finds concerts, shows and trips you’ll actually love, shows what they really cost, and saves
                  for them in your Livento wallet, one week at a time.
                </p>
                <div className="actions hero-actions">
                  <Link className="pill" href="/onboarding">
                    Start planning <span aria-hidden="true">↗</span>
                  </Link>
                  <a className="pill alt" href="#how">
                    How it works <span aria-hidden="true">●</span>
                  </a>
                </div>
              </>
            }
            foot={
              <div className="rails">
                <ul>
                  {CATEGORIES.map((category) => (
                    <li key={category}>{category}</li>
                  ))}
                </ul>
                <ol>
                  {ROADMAP.map((step) => (
                    <li key={step.title}>{step.title}</li>
                  ))}
                </ol>
                <ul className="rail-links">
                  <li>
                    <Link href="/onboarding">
                      Start <span aria-hidden="true">↗</span>
                    </Link>
                  </li>
                  <li>
                    <Link href="/onboarding?sample=1">
                      Sample profile <span aria-hidden="true">↗</span>
                    </Link>
                  </li>
                  <li>
                    <a href="#pricing">
                      Pricing <span aria-hidden="true">↗</span>
                    </a>
                  </li>
                </ul>
              </div>
            }
          />
        </section>

        <section id="about" className="wrap section" aria-labelledby="about-title">
          <div className="kicker">01 / Why Livento</div>
          <h2 id="about-title" className="display">
            Turn everyday spending into experiences you’ll remember
          </h2>
          <ol className="roadmap" aria-label="How Livento works, in four steps">
            {ROADMAP.map((step, index) => (
              <li key={step.title}>
                <h3>
                  <span className="roadmap-num">{String(index + 1).padStart(2, "0")}</span> {step.title}
                </h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="experiences" className="works" aria-labelledby="experiences-title">
          <div className="wrap section">
            <div className="kicker">02 / Experiences</div>
            <h2 id="experiences-title" className="display">
              Plan the things
              <br />
              you’ll talk about
            </h2>
            <div className="workgrid">
              {EXPERIENCES.map((item) => (
                <article key={item.title}>
                  <img src={item.image} alt={item.alt} width={800} height={600} loading="lazy" decoding="async" />
                  <div>
                    <h3>{item.title}</h3>
                    <span>( {item.label} )</span>
                  </div>
                  <p className="card-line">{item.line}</p>
                  <details>
                    <summary>Discover more</summary>
                    <p>{item.more}</p>
                  </details>
                  <Link className="pill alt small explore" href="/onboarding">
                    Explore<span className="sr-only"> {item.title}</span> <span aria-hidden="true">↗</span>
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="dark" aria-labelledby="how-title">
          <div className="wrap section">
            <div className="kicker">03 / How it works</div>
            <h2 id="how-title" className="display">
              From wish to plan
            </h2>
            <div className="service-list">
              {STEPS.map((step, index) => (
                <details key={step.title} open={index === 0}>
                  <summary>
                    {step.title}
                    {step.premium ? <span className="tag premium">Premium</span> : null}
                  </summary>
                  <p>{step.text}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="wrap section" aria-labelledby="pricing-title">
          <div className="kicker">04 / Pricing</div>
          <h2 id="pricing-title" className="display">
            Free to start. Premium when you’re ready.
          </h2>
          <div className="plans">
            <article className="plan">
              <h3>Free</h3>
              <p className="price">$0</p>
              <ul>
                {FREE_FEATURES.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </article>
            <article className="plan">
              <h3>Premium</h3>
              <p className="price">
                ${PRICING.monthly}
                <small>/month</small>
              </p>
              <p className="price-alt">or ${PRICING.yearly}/year</p>
              <ul>
                {PREMIUM_FEATURES.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <p className="plan-note">Cancel anytime in one click. No hidden renewals.</p>
            </article>
          </div>
          <div className="actions">
            <Link className="pill" href="/onboarding">
              Start free <span aria-hidden="true">↗</span>
            </Link>
            <Link className="pill alt" href="/pricing">
              See Premium <span aria-hidden="true">●</span>
            </Link>
          </div>
        </section>
      </main>

      <footer id="start" className="foot" aria-labelledby="start-title">
        <div className="wrap section">
          <div className="kicker">05 / Start</div>
          <h2 id="start-title" className="display foot-title">
            Where do you want to be next?
          </h2>
          <div className="foot-row">
            <p className="foot-copy">
              Answer 9 quick questions and get your first plan in under two minutes. No account needed.
            </p>
            <div className="actions foot-actions">
              <Link className="pill" href="/onboarding">
                Start planning <span aria-hidden="true">↗</span>
              </Link>
              <Link className="pill alt" href="/onboarding?sample=1">
                Try a sample profile <span aria-hidden="true">●</span>
              </Link>
              <WishDialog />
            </div>
          </div>
          <div className="end">
            <b className="brand">Livento</b>
            <a href="/assets/CREDITS.md">Image credits</a>
            <a href="#top">
              Back to top <span aria-hidden="true">↑</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
