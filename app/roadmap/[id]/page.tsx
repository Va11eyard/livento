import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { RoadmapView } from "./RoadmapView";

export const metadata: Metadata = {
  title: "Roadmap · Livento",
  description:
    "Dated steps for one experience: money, tickets and the day itself, plus time off, travel and hotel for trips out of town.",
};

export default async function RoadmapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <RoadmapView id={id} />
    </AppShell>
  );
}
