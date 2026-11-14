import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { EnvelopesView } from "./EnvelopesView";

export const metadata: Metadata = {
  title: "Envelopes · Livento",
  description: "Virtual envelopes for the experiences you're saving for. Your money stays in your own bank; Livento only tracks it.",
};

export default function EnvelopesPage() {
  return (
    <AppShell>
      <EnvelopesView />
    </AppShell>
  );
}
