"use client";

import Link from "next/link";
import { useId } from "react";
import { setPremium } from "@/lib/storage";
import { PRICING } from "@/lib/types";
import { usd } from "./format";
import { useToast } from "./Toast";
import styles from "./PremiumGate.module.css";

export const PREMIUM_FEATURES = [
  "Livento wallet with an envelope for each goal",
  "Automatic weekly withdrawal from your card into the wallet",
  "Spend-vs-save comparator between two events",
  "Trip roadmap with dated steps and hotel links",
  "Spending breakdown from your bank statement",
] as const;

interface PremiumGateProps {
  title?: string;
  description?: string;
  headingLevel?: 1 | 2;
}

/** Lock panel: what Premium adds, the price up front, demo unlock, link to pricing. */
export function PremiumGate({
  title = "This part is Premium",
  description,
  headingLevel = 2,
}: PremiumGateProps) {
  const id = useId();
  const notify = useToast();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className={styles.gate} aria-labelledby={id}>
      <span className="tag premium">Premium</span>
      <Heading id={id} className={styles.title}>
        {title}
      </Heading>
      {description ? <p className={styles.description}>{description}</p> : null}
      <ul className={styles.features}>
        {PREMIUM_FEATURES.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <p className={styles.price}>
        <strong>{usd(PRICING.monthly)}/month</strong> or <strong>{usd(PRICING.yearly)}/year</strong>{" "}
        <span className="tag">Test price</span>
      </p>
      <p className={styles.fine}>Cancel anytime in one click. No hidden renewals.</p>
      <div className={styles.actions}>
        <button
          type="button"
          className="pill"
          onClick={() => {
            setPremium("demo");
            notify("Premium demo unlocked", "No charge. You can turn it off on the Pricing page.");
          }}
        >
          Demo unlock (no charge) <span aria-hidden="true">●</span>
        </button>
        <Link href="/pricing" className="pill alt">
          See pricing <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </section>
  );
}
