"use client";

import Link from "next/link";
import { AssistantChat } from "@/components/app/Assistant";
import ui from "@/components/app/ui.module.css";
import { useAppState, useHydrated } from "@/lib/storage";

/** /assistant: Ask Livento as a full page (the floating button is hidden here). */
export function AssistantView() {
  const state = useAppState();
  const hydrated = useHydrated();
  const noProfile = hydrated && !state.profile;

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">06 / Ask Livento</p>
        <h1 className="title">Ask Livento</h1>
        <p className="lead muted">
          Ask how to afford a goal, what&rsquo;s cheap this month or where you could cut back. Answers use the
          Livento data saved in this browser.
        </p>
        {noProfile ? (
          <p className="help">
            Answers get personal once you{" "}
            <Link className={ui.inlineLink} href="/onboarding">
              set up your profile
            </Link>{" "}
            (city, interests and budget).
          </p>
        ) : null}
      </header>
      <AssistantChat variant="page" />
    </div>
  );
}
