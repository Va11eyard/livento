import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { AssistantView } from "./AssistantView";

export const metadata: Metadata = {
  title: "Ask Livento · Livento",
  description:
    "Ask how to afford a goal, find something cheap to do this month or see where you could cut back. Every number comes from Livento's calculators.",
};

export default function AssistantPage() {
  return (
    <AppShell>
      <AssistantView />
    </AppShell>
  );
}
