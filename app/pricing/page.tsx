import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { PageSkeleton } from "@/components/app/States";
import { PricingView } from "./PricingView";

export const metadata: Metadata = {
  title: "Pricing · Livento",
  description: "Free: events, picks and alerts. Premium ($4.99/month or $39/year, test price): the Livento wallet with automatic weekly saving, comparator, roadmap and spending breakdown.",
};

export default function PricingPage() {
  return (
    <AppShell>
      {/* useSearchParams (?checkout=success|cancel) must sit inside a Suspense boundary. */}
      <Suspense fallback={<PageSkeleton label="Loading pricing…" />}>
        <PricingView />
      </Suspense>
    </AppShell>
  );
}
