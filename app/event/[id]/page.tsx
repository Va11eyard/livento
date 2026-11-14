import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { EventView } from "./EventView";

export const metadata: Metadata = {
  title: "Event · Livento",
  description: "The full cost of an event: tickets, estimated fees, travel, hotel and a buffer, plus a plan to save for it.",
};

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <EventView id={id} />
    </AppShell>
  );
}
