import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { InsightsView } from "./InsightsView";

export const metadata: Metadata = {
  title: "Insights · Livento",
  description: "See where impulse money goes and what experiences it could cover. Processed in memory, never stored.",
};

export default function InsightsPage() {
  return (
    <AppShell>
      <InsightsView />
    </AppShell>
  );
}
