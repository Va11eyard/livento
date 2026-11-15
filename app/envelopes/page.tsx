import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { PageSkeleton } from "@/components/app/States";
import { EnvelopesView } from "./EnvelopesView";

export const metadata: Metadata = {
  title: "Wallet · Livento",
  description:
    "Your Livento wallet: add money by card, keep an envelope for each experience you're saving for, save automatically every week and withdraw to your card anytime.",
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
