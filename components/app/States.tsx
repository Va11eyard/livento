"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { loadSampleProfile } from "@/lib/storage";
import ui from "./ui.module.css";

/** Neutral placeholder shown until local state is readable (server render + hydration). */
export function PageSkeleton({ label = "Loading your plan…" }: { label?: string }) {
  return (
    <div className={`wrap ${ui.page}`} aria-busy="true">
      <p className="sr-only" role="status">
        {label}
      </p>
      <div className={ui.skeleton} aria-hidden="true">
        <div className={ui.skelBar} />
        <div className={ui.skelTitle} />
        <div className={ui.skelLine} />
        <div className={ui.skelGrid}>
          <div className={ui.skelCard} />
          <div className={ui.skelCard} />
        </div>
      </div>
    </div>
  );
}

interface NoProfileProps {
  title?: string;
  text?: string;
  onSampleLoaded?: () => void;
}

/** "No profile yet" state used by every app screen: onboarding or the labeled sample profile. */
export function NoProfile({ title, text, onSampleLoaded }: NoProfileProps) {
  const headingId = useId();
  return (
    <div className="wrap">
      <section className={ui.empty} aria-labelledby={headingId}>
        <p className="kicker">Start here</p>
        <h1 id={headingId} className="title">
          {title ?? "First, tell us what you love going to"}
        </h1>
        <p className="lead muted">
          {text ??
            "Ten quick questions, no account. Your answers are saved only in this browser. Or look around with a sample profile first."}
        </p>
        <div className={ui.actions}>
          <Link href="/onboarding" className="pill">
            Start onboarding <span aria-hidden="true">↗</span>
          </Link>
          <button
            type="button"
            className="pill alt"
            onClick={() => {
              loadSampleProfile();
              onSampleLoaded?.();
            }}
          >
            Try a sample profile <span aria-hidden="true">●</span>
          </button>
        </div>
        <p className="help">The sample profile is fictional and labeled &ldquo;Sample&rdquo; wherever it appears.</p>
      </section>
    </div>
  );
}

/** Dashed "Sample data" banner. */
export function SampleBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`${ui.notice} ${ui.noticeSample}`} role="note">
      <span className="tag sample">Sample data</span>
      <p>{children}</p>
      {action}
    </div>
  );
}

type Tone = "info" | "error" | "ok";

/** Inline status box. Use `live` for results that arrive asynchronously. */
export function Notice({
  tone = "info",
  label,
  children,
  action,
  live = false,
}: {
  tone?: Tone;
  label?: string;
  children: ReactNode;
  action?: ReactNode;
  live?: boolean;
}) {
  const toneClass = tone === "error" ? ui.noticeError : tone === "ok" ? ui.noticeOk : "";
  return (
    <div
      className={`${ui.notice} ${toneClass}`}
      role={tone === "error" ? "alert" : live ? "status" : undefined}
    >
      {label ? <span className={ui.noticeLabel}>{label}</span> : null}
      <p>{children}</p>
      {action}
    </div>
  );
}

/** Friendly dead-end guard: message + a way forward. */
export function ErrorState({
  title,
  message,
  onRetry,
  backHref = "/discover",
  backLabel = "Back to Discover",
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className={ui.outline} role="alert">
      <h2 className={ui.smallTitle}>{title}</h2>
      <p style={{ margin: "8px 0 18px" }}>{message}</p>
      <div className={ui.actions}>
        {onRetry ? (
          <button type="button" className="pill small" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <Link href={backHref} className="pill small alt">
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
