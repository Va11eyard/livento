import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { PageSkeleton } from "@/components/app/States";
import { EnvelopesView } from "./EnvelopesView";

export const metadata: Metadata = {
  title: "Wallet · Livento",
  description:
    "Your Livento wallet: an envelope for each experience you're saving for. Add money by card, save automatically every week, withdraw to your card anytime. Stripe test mode: no real money moves.",
};

export default function EnvelopesPage() {
  return (
    <AppShell>
      {/* useSearchParams (?wallet=return|cancel after Stripe Checkout) must sit inside a Suspense boundary. */}
      <Suspense fallback={<PageSkeleton label="Loading your wallet…" />}>
        <EnvelopesView />
      </Suspense>
    </AppShell>
  );
}
