"use client";

import Link from "next/link";
import { resetAll } from "@/lib/storage";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import styles from "./AppFooter.module.css";

/** Compact yellow footer: motto, where data and money live, and a one-click way to clear this browser. */
export function AppFooter() {
  const notify = useToast();
  return (
    <footer className={styles.footer}>
      <div className={`wrap ${styles.inner}`}>
        <p className={styles.motto}>Spend on memories, not impulses.</p>
        <p className={styles.note}>
          No account needed: your profile, goals and spending summary stay in this browser. Money you add is kept in
          your Livento wallet until you withdraw it.
        </p>
        <div className={styles.row}>
          <Link href="/" className="brand">
            Livento
          </Link>
          <nav aria-label="Footer" className={styles.links}>
            <Link href="/discover">Discover</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/profile">Profile</Link>
            <Link href="/status">Status</Link>
            <ConfirmDialog
              triggerLabel="Clear my data"
              triggerClassName={styles.clear}
              title="Clear everything?"
              description="This removes your profile and photos, envelopes, saved events, spending summary and Premium unlock from this browser, and unlinks your wallet from it. Withdraw any money in your wallet first. It can't be undone."
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
