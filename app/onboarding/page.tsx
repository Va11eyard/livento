import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { PageSkeleton } from "@/components/app/States";
import { OnboardingView } from "./OnboardingView";

export const metadata: Metadata = {
  title: "Set up your profile · Livento",
  description: "Ten quick questions so Livento can find experiences you'll love and plan what they really cost.",
};

export default function OnboardingPage() {
  return (
    <AppShell>
      {/* useSearchParams (?sample=1) must sit inside a Suspense boundary. */}
      <Suspense fallback={<PageSkeleton label="Loading onboarding…" />}>
        <OnboardingView />
      </Suspense>
    </AppShell>
  );
}
