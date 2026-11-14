"use client";

import Link from "next/link";
import { resetAll } from "@/lib/storage";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import styles from "./AppFooter.module.css";

/** Compact yellow footer: motto, where data lives, and a one-click way to clear it. */
export function AppFooter() {
  const notify = useToast();
  return (
    <footer className={styles.footer}>
      <div className={`wrap ${styles.inner}`}>
        <p className={styles.motto}>Spend on memories, not impulses.</p>
        <p className={styles.note}>
          Your profile, envelopes and saved events are stored only in this browser. No account, and Livento never
          holds your money.
        </p>
        <div className={styles.row}>
          <Link href="/" className="brand">
            Livento
          </Link>
          <nav aria-label="Footer" className={styles.links}>
            <Link href="/discover">Discover</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/onboarding">Edit profile</Link>
            <ConfirmDialog
              triggerLabel="Clear my data"
              triggerClassName={styles.clear}
              title="Clear everything?"
              description="This removes your profile, envelopes, saved events and Premium unlock from this browser. It can't be undone."
              confirmLabel="Clear my data"
              cancelLabel="Keep it"
              onConfirm={() => {
                resetAll();
                notify("Your data was cleared from this browser.");
              }}
            />
          </nav>
        </div>
      </div>
    </footer>
  );
}
