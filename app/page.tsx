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
    more: "Big weekends can sell out early. Livento shows on-sale dates when they’re known and works out what to set aside each week to be ready.",
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
    text: "Answer 8 quick questions about what you’re into, where you live and what you’d like to spend. No account, no email.",
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
    title: "Save in envelopes",
    premium: true,
    text: "See the weekly amount to set aside and get reminders to do it. Envelopes only track your plan: your money stays in your own bank.",
  },
  {
    title: "Get your roadmap",
    premium: true,
    text: "A step-by-step plan for the trip: when to ask for time off, when presales open, and hotel links for your dates.",
  },
  {
    title: "See your impulse spend",
    premium: true,
    text: "Upload a bank statement (CSV) to see where small impulse buys add up. It’s processed in memory and never stored.",
  },
];

const FREE_FEATURES = [
  "Events near you, from concerts to big trips",
  "Personalized recommendations",
  "Event alerts by email or Telegram",
];

const PREMIUM_FEATURES = [
  "Savings envelopes",
  "Weekly reminders to set money aside",
  "Spend-vs-save comparator",
  "Trip roadmap",
  "Impulse-spending insights",
];

export default function Home() {
  // The wordmark is the largest thing above the fold; fetch its font early (as the reference did).
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
            top={
              <div className="top">
                <h1 id="lv-word" className="wordmark">
                  Livento
                </h1>
                <div className="rails">
                  <div>
                    Concerts
                    <br />
                    Theatre
                    <br />
                    Festivals
                    <br />
                    Cinema
                    <br />
                    Big experiences
                  </div>
                  <div>
                    Discover
                    <br />
                    Plan
                    <br />
                    Save
                    <br />
                    Go
                  </div>
                  <div className="rail-links">
                    <Link href="/onboarding">
                      Start <span aria-hidden="true">↗</span>
                    </Link>
                    <Link href="/onboarding?sample=1">
                      Sample profile <span aria-hidden="true">↗</span>
                    </Link>
                    <a href="#pricing">
                      Pricing <span aria-hidden="true">↗</span>
                    </a>
                  </div>
                </div>
              </div>
            }
            foot={
              <div className="hero-foot">
                <h2>Spend on memories, not impulses.</h2>
                <div>
                  <p>
                    Livento finds concerts, shows and trips you’ll actually love, shows what they really cost, and
                    helps you set money aside, one week at a time.
                  </p>
                  <div className="actions">
                    <Link className="pill" href="/onboarding">
                      Start planning <span aria-hidden="true">↗</span>
                    </Link>
                    <a className="pill alt" href="#how">
                      How it works <span aria-hidden="true">●</span>
                    </a>
                  </div>
                </div>
              </div>
            }
          />
        </section>

        <section id="about" className="wrap section" aria-labelledby="about-title">
          <div className="kicker">01 / Why Livento</div>
          <h2 id="about-title" className="display">
            Turn impulse spending into experiences you’ll remember
          </h2>
          <div className="steps">
            <strong>How it works</strong>
            <span>Discover</span>
            <span>Save</span>
            <span>Go</span>
          </div>
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
                    <Link className="explore" href="/onboarding">
                      Explore <span aria-hidden="true">↗</span>
                    </Link>
                  </details>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="dark" aria-labelledby="how-title">
          <div className="wrap section">
            <div className="kicker">03 / How it works</div>
            <h2 id="how-title" className="display">
              From impulse to plan
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
          <h2 id="start-title" className="display">
            Where do you want to be next?
          </h2>
          <p className="foot-copy">
            Answer 8 quick questions and get your first plan in under two minutes. No account needed.
          </p>
          <div className="actions">
            <Link className="pill" href="/onboarding">
              Start planning <span aria-hidden="true">↗</span>
            </Link>
            <Link className="pill alt" href="/onboarding?sample=1">
              Try a sample profile <span aria-hidden="true">●</span>
            </Link>
            <WishDialog />
          </div>
          <div className="end">
            <b className="brand">Livento</b>
            <a href="/assets/CREDITS.md">Image credits</a>
            <Link href="/status">Status</Link>
            <a href="#top">
              Back to top <span aria-hidden="true">↑</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
