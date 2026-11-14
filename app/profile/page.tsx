import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { ProfileView } from "./ProfileView";

export const metadata: Metadata = {
  title: "Profile · Livento",
  description:
    "Your Livento profile: photo, cover, name, a short bio, a quote that keeps you going, the goals you're saving for and your upcoming plans. Saved only in this browser.",
};

export default function ProfilePage() {
  return (
    <AppShell>
      <ProfileView />
    </AppShell>
  );
}
