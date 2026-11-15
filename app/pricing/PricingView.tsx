"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { safeExternalUrl, usd } from "@/components/app/format";
import { PREMIUM_FEATURES } from "@/components/app/PremiumGate";
import { Notice } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { checkout, checkoutSession, ClientApiError, errorMessage, getHealth, stopAllAutosaves } from "@/lib/client-api";
import { setPremium, syncEnvelopeLedger, useAppState, useHydrated } from "@/lib/storage";
import { PRICING } from "@/lib/types";
import { GoodbyeDialog } from "./GoodbyeDialog";
import styles from "./pricing.module.css";

type Billing = "monthly" | "yearly";

const FREE_FEATURES = [
  "Events near you: concerts, theatre, sports, family and big experiences",
  "Top 8 picks with a one-line reason for each",
  "The full cost of any event, every estimate labeled",
  "Alerts for new matches on Telegram",
];

/** /pricing — Free vs Premium, test-mode checkout, demo unlock, one-click cancel. */
export function PricingView() {
  const params = useSearchParams();
  const router = useRouter();
  const notify = useToast();
  const state = useAppState();
  const hydrated = useHydrated();
  const checkoutParam = params.get("checkout");
  const sessionParam = params.get("session_id");
  // Remember why we arrived even after the URL is cleaned up.
  const [arrival, setArrival] = useState<"confirming" | "success" | "unpaid" | "cancel" | null>(
    checkoutParam === "cancel" ? "cancel" : checkoutParam === "success" && sessionParam ? "confirming" : null,
  );
  const [turnOffError, setTurnOffError] = useState<string | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
  const handledReturn = useRef(false);
  const [billing, setBilling] = useState<Billing>("monthly");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  // Show the checkout button only when test-mode payments are actually connected on this deployment.
  const [checkoutLive, setCheckoutLive] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((h) => setCheckoutLive(h.integrations.some((i) => i.key === "payments" && i.state === "test")))
      .catch(() => setCheckoutLive(false));
    return () => controller.abort();
  }, []);

  // Returning from the test-mode checkout: check with Stripe that the session was really paid before
  // unlocking, then drop the query so a reload doesn't repeat it. Runs once per arrival.
  useEffect(() => {
    if (handledReturn.current || (checkoutParam !== "success" && checkoutParam !== "cancel")) return;
    handledReturn.current = true;
    router.replace("/pricing", { scroll: false });
    if (checkoutParam !== "success" || !sessionParam) return;
    const sessionId = sessionParam;
    checkoutSession({ sessionId, action: "confirm" })
      .then((res) => {
        if (res.ok && res.paid) {
          setPremium("paid", sessionId);
          setArrival("success");
        } else {
          setArrival("unpaid");
        }
      })
      .catch(() => setArrival("unpaid"));
  }, [checkoutParam, sessionParam, router]);

  const premium = hydrated ? state.premium : "none";
  const hasProfile = hydrated && !!state.profile;
  const price = billing === "monthly" ? PRICING.monthly : PRICING.yearly;

  const demoUnlock = () => {
    setPremium("demo");
    setMessage(null);
    setTurnedOff(false);
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

  /**
   * Stops every auto-save first (auto-save is a Premium feature), then cancels the test subscription
   * if Premium was bought, so "nothing renews" and "auto-save stops" stay true. Money in the wallet
   * stays there; withdrawing never needs Premium.
   */
  const turnOff = async (): Promise<boolean> => {
    setTurnOffError(null);
    const token = state.wallet?.token;
    if (token) {
      try {
        syncEnvelopeLedger(await stopAllAutosaves(token));
      } catch (err) {
        // 503: payments aren't connected here, so nothing can be withdrawn anyway.
        // 401/404: the wallet link is gone, so there is no schedule left to stop.
        const nothingToStop = err instanceof ClientApiError && [401, 404, 503].includes(err.status);
        if (!nothingToStop) {
          setTurnOffError(`${errorMessage(err)} Auto-save is still on, so Premium stays on for now.`);
          return false;
        }
      }
    }
    if (state.premium === "paid" && state.premiumSession) {
      try {
        const res = await checkoutSession({ sessionId: state.premiumSession, action: "cancel" });
        if (!res.ok || !res.canceled) {
          setTurnOffError(res.message || "We couldn't cancel the subscription, so Premium stays on. Please try again.");
          return false;
        }
      } catch (err) {
        setTurnOffError(`${errorMessage(err)} Premium stays on for now.`);
        return false;
      }
    }
    setPremium("none");
    setTurnedOff(true);
    setArrival(null);
    return true;
  };

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">05 / Pricing</p>
        <h1 className="title">Plan for free. Save with Premium.</h1>
        <p className="lead muted">
          Events, picks and alerts are free. Premium adds the wallet that saves for you automatically, plus the
          planning tools. The price is shown before checkout, and you can cancel in one click.
        </p>
      </header>

      <div className={styles.notices} aria-live="polite">
        {arrival === "confirming" ? <Notice label="Checking your checkout">One moment…</Notice> : null}
        {arrival === "unpaid" ? (
          <Notice tone="error" label="Checkout not confirmed">
            We couldn&rsquo;t confirm this payment, so Premium stays off. You can try again or use Demo unlock.
          </Notice>
        ) : null}
        {turnedOff && premium === "none" ? (
          <Notice label="Premium is off">Nothing renews. You can turn it back on anytime.</Notice>
        ) : null}
        {arrival === "success" ? (
          <Notice tone="ok" label="Premium unlocked">
            Thanks! Your wallet and planning tools are ready.
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
              {premium === "demo" ? "is on as a free demo unlock." : "is on."} Turning it off takes one click and
              nothing renews.
            </p>
            <GoodbyeDialog onTurnOff={turnOff} error={turnOffError} />
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
            {checkoutLive ? (
              <button type="button" className="pill" onClick={() => void upgrade()} disabled={pending}>
                {pending ? "Opening checkout…" : `Upgrade for ${usd(price)}`} <span aria-hidden="true">↗</span>
              </button>
            ) : null}
            <button
              type="button"
              className={checkoutLive ? "pill alt" : "pill"}
              onClick={demoUnlock}
              disabled={premium !== "none"}
            >
              Demo unlock (no charge) <span aria-hidden="true">●</span>
            </button>
          </div>
          <p className={styles.fine}>
            Cancel anytime in one click. No hidden renewals.
            {checkoutLive ? "" : " Payments aren't connected in this demo, so Premium unlocks for free."}
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
            <dd>The price above, shown before checkout.</dd>
          </div>
          <div>
            <dt>Cancelling</dt>
            <dd>
              One click on this page turns Premium off and cancels the subscription, so nothing renews behind your back.
            </dd>
          </div>
          <div>
            <dt>Your money</dt>
            <dd>
              Money you add goes into your Livento wallet, on its own or in an envelope per goal, and stays there
              until you withdraw it back to your card.
              {checkoutLive ? "" : " Payments aren't connected on this deployment yet, so the wallet can't take money."}
            </dd>
          </div>
          <div>
            <dt>Your data</dt>
            <dd>
              Your profile, goals and spending summary are saved in this browser, and there&rsquo;s no account. Wallet
              payments go through Stripe, and your wallet is linked to this browser. A bank statement you upload is
              read once to build your summary; the file itself isn&rsquo;t kept.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
