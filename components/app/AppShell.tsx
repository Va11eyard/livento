"use client";

import type { ReactNode } from "react";
import { AppFooter } from "./AppFooter";
import { AppNav } from "./AppNav";
import { AssistantLauncher } from "./Assistant";
import { ToastProvider } from "./Toast";
import styles from "./AppShell.module.css";

/** Frame for every app screen: skip link, fixed header, main landmark, footer, Ask Livento, toasts. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <AppNav />
      <main id="main" tabIndex={-1} className={styles.main}>
        {children}
      </main>
      <AppFooter />
      <AssistantLauncher />
    </ToastProvider>
  );
}
