import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { InsightsView } from "./InsightsView";

export const metadata: Metadata = {
  title: "Insights · Livento",
  description:
    "See where your money goes by category, month and merchant, and what spending a little less could free for your goals. The summary stays on your device; the file isn't kept.",
};

export default function InsightsPage() {
  return (
    <AppShell>
      <InsightsView />
    </AppShell>
  );
}
