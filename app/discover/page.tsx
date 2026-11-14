import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { DiscoverView } from "./DiscoverView";

export const metadata: Metadata = {
  title: "Discover · Livento",
  description: "Your top picks nearby: concerts, theatre, festivals and big experiences, with the full cost up front.",
};

export default function DiscoverPage() {
  return (
    <AppShell>
      <DiscoverView />
    </AppShell>
  );
}
