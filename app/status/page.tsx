import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { StatusView } from "./StatusView";

export const metadata: Metadata = {
  title: "Status · Livento",
  description: "Which Livento integrations are live on this deployment, and a one-click end-to-end check.",
};

export default function StatusPage() {
  return (
    <AppShell>
      <StatusView />
    </AppShell>
  );
}
