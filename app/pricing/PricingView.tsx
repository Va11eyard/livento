"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { safeExternalUrl, usd } from "@/components/app/format";
import { PREMIUM_FEATURES } from "@/components/app/PremiumGate";
import { Notice } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { checkout, errorMessage } from "@/lib/client-api";
import { setPremium, useAppState, useHydrated } from "@/lib/storage";
import { PRICING } from "@/lib/types";
import styles from "./pricing.module.css";

type Billing = "monthly" | "yearly";

const FREE_FEATURES = [
  "Events near you: concerts, theatre, sports, family and big experiences",
  "Top 8 picks with a one-line reason for each",
  "The full cost of any event, every estimate labeled",
  "Alerts for new matches by email or Telegram",
];

/** /pricing — Free vs Premium, test-mode checkout, demo unlock, one-click cancel. */
export function PricingView() {
  const params = useSearchParams();
  const router = useRouter();
  const notify = useToast();
  const state = useAppState();
  const hydrated = useHydrated();
  const checkoutParam = params.get("checkout");
  // Remember why we arrived even after the URL is cleaned up.
  const [arrival] = useState<"success" | "cancel" | null>(
    checkoutParam === "success" || checkoutParam === "cancel" ? checkoutParam : null,
  );
  const [billing, setBilling] = useState<Billing>("monthly");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  // Returning from the test-mode checkout: unlock and drop the query so a reload doesn't repeat it.
  useEffect(() => {
    if (checkoutParam !== "success" && checkoutParam !== "cancel") return;
    if (checkoutParam === "success") setPremium("paid");
    router.replace("/pricing", { scroll: false });
  }, [checkoutParam, router]);

  const premium = hydrated ? state.premium : "none";
  const hasProfile = hydrated && !!state.profile;
  const price = billing === "monthly" ? PRICING.monthly : PRICING.yearly;

  const demoUnlock = () => {
    setPremium("demo");
    setMessage(null);
    notify("Premium demo unlocked", "No charge. Turn it off here anytime.");
  };

  const upgrade = async () => {
    setPending(true);
    setMessage(null);
    try {
      const res = await checkout({ plan: billing });
      const url = safeExternalUrl(res.url);
      if (url) {
        window.location.assign(url);
        return; // keep the button busy while the browser navigates
      }
      setMessage({
        tone: res.demo ? "info" : "error",
        text:
          res.message ||
          (res.demo
            ? "Payments aren't set up on this deployment, so there's nothing to charge. Use Demo unlock (no charge) to try Premium."
            : "Checkout isn't available right now. Use Demo unlock (no charge) instead."),
      });
    } catch (err) {
      setMessage({ tone: "error", text: `${errorMessage(err)} You can use Demo unlock (no charge) meanwhile.` });
    }
    setPending(false);
  };

  const turnOff = () => {
    setPremium("none");
    notify("Premium is off", "Nothing else to cancel, and nothing renews.");
  };

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">05 / Pricing</p>
        <h1 className="title">Plan for free. Save with Premium.</h1>
        <p className="lead muted">
          Events, picks and alerts are free. Premium adds the planning tools. The price is shown before checkout, and
          you can cancel in one click.
        </p>
      </header>

      <div className={styles.notices} aria-live="polite">
        {arrival === "success" ? (
          <Notice tone="ok" label="Premium unlocked">
            Thanks for trying it. This is test mode, so no real money was charged.
          </Notice>
        ) : null}
        {arrival === "cancel" ? (
          <Notice label="Checkout canceled">You haven&rsquo;t been charged. Premium stays off.</Notice>
        ) : null}
        {message ? (
          <Notice tone={message.tone === "error" ? "error" : "info"} label={message.tone === "error" ? "Checkout" : "Heads up"}>
            {message.text}
          </Notice>
        ) : null}
        {premium !== "none" ? (
          <div className={styles.status}>
            <p>
              <span className="tag premium">Premium</span>{" "}
              {premium === "demo" ? "is on as a free demo unlock." : "is on (test mode)."} Turning it off takes one
              click and nothing renews.
            </p>
            <button type="button" className="pill small alt" onClick={turnOff}>
              Turn off Premium
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.plans}>
        <section className={styles.plan} aria-labelledby="plan-free">
          <p className={styles.planKicker}>Free</p>
          <h2 id="plan-free" className={styles.planTitle}>
            Find it and know the cost
          </h2>
          <p className={styles.price}>
            $0<span className={styles.per}>/forever</span>
          </p>
          <ul className={styles.features}>
            {FREE_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className={styles.planActions}>
            <Link href={hasProfile ? "/discover" : "/onboarding"} className="pill alt">
              {hasProfile ? "Go to Discover" : "Start free"} <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </section>

        <section className={`${styles.plan} ${styles.premiumPlan}`} aria-labelledby="plan-premium">
          <div className={styles.planTop}>
            <p className={styles.planKicker}>Premium</p>
            <span className="tag">Test price</span>
          </div>
          <h2 id="plan-premium" className={styles.planTitle}>
            Plan it, save for it, go
          </h2>
          <ToggleGroup.Root
            type="single"
            value={billing}
            onValueChange={(v) => {
              if (v === "monthly" || v === "yearly") setBilling(v);
            }}
            aria-label="Billing period"
            className={`${ui.chips} ${styles.billing}`}
          >
            <ToggleGroup.Item value="monthly" className={ui.chip}>
              Monthly
            </ToggleGroup.Item>
            <ToggleGroup.Item value="yearly" className={ui.chip}>
              Yearly
            </ToggleGroup.Item>
          </ToggleGroup.Root>
          <p className={styles.price} aria-live="polite">
            {usd(price)}
            <span className={styles.per}>/{billing === "monthly" ? "month" : "year"}</span>
          </p>
          <p className={ui.meta}>
            {billing === "monthly"
              ? `Billed monthly. Or ${usd(PRICING.yearly)}/year.`
              : `Billed yearly, about ${usd(Math.round((PRICING.yearly / 12) * 100) / 100)}/month. Or ${usd(PRICING.monthly)}/month.`}
          </p>
          <ul className={styles.features}>
            {PREMIUM_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className={styles.planActions}>
            <button type="button" className="pill" onClick={() => void upgrade()} disabled={pending}>
              {pending ? "Opening checkout…" : `Upgrade for ${usd(price)} (test checkout)`} <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="pill alt" onClick={demoUnlock} disabled={premium !== "none"}>
              Demo unlock (no charge) <span aria-hidden="true">●</span>
            </button>
          </div>
          <p className={styles.fine}>
            Cancel anytime in one click. No hidden renewals. Test mode: no real card is charged.
          </p>
        </section>
      </div>

      <section className={ui.blockRule} aria-labelledby="billing-facts">
        <h2 id="billing-facts" className={ui.sectionTitle}>
          The fine print, in plain words
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>What you pay</dt>
            <dd>The price above, shown before checkout. This demo runs in test mode, so no real money moves.</dd>
          </div>
          <div>
            <dt>Cancelling</dt>
            <dd>One click on this page turns Premium off. Nothing renews behind your back.</dd>
          </div>
          <div>
            <dt>Your money</dt>
            <dd>Livento never holds or moves your money. Envelopes only track what you set aside in your own bank.</dd>
          </div>
          <div>
            <dt>Your data</dt>
            <dd>
              Your profile and envelopes live in this browser. Bank CSVs are processed in memory and never stored.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
