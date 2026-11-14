"use client";

import * as Accordion from "@radix-ui/react-accordion";
import Link from "next/link";
import { useState } from "react";
import { deadlineText } from "@/components/app/CostTable";
import { eventHref } from "@/components/app/EventCard";
import { EventLookup } from "@/components/app/EventLookup";
import { eventPlace, eventWhen, formatDate, safeDecode, safeExternalUrl, usd0 } from "@/components/app/format";
import { buildIcs, downloadFile, slugify } from "@/components/app/ics";
import { PremiumGate } from "@/components/app/PremiumGate";
import { ErrorState, NoProfile, PageSkeleton } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import { useAsync } from "@/components/app/useAsync";
import ui from "@/components/app/ui.module.css";
import { roadmap } from "@/lib/client-api";
import { buildPlan } from "@/lib/cost";
import { envelopeBalance, envelopeForEvent, hasPremium, useAppState, useHydrated } from "@/lib/storage";
import type { AppState, LiventoEvent, Profile, RoadmapStep, RoadmapStepKind } from "@/lib/types";
import styles from "./roadmap.module.css";

const KIND_LABELS: Record<RoadmapStepKind, string> = {
  money: "Money",
  tickets: "Tickets",
  vacation: "Time off",
  travel: "Travel",
  stay: "Stay",
  "day-of": "Day of",
};

function sortSteps(steps: RoadmapStep[]): RoadmapStep[] {
  // Dated steps in date order; undated ones keep their order at the end.
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      if (a.step.date && b.step.date) return a.step.date.localeCompare(b.step.date) || a.index - b.index;
      if (a.step.date) return -1;
      if (b.step.date) return 1;
      return a.index - b.index;
    })
    .map((x) => x.step);
}

function Roadmap({ event, profile, state }: { event: LiventoEvent; profile: Profile; state: AppState }) {
  const notify = useToast();
  const premium = hasPremium(state);
  const [attempt, setAttempt] = useState(0);
  const envelope = envelopeForEvent(state, event.id);
  const balance = envelope ? envelopeBalance(envelope) : 0;
  const plan = buildPlan(event, profile, balance);
  const result = useAsync(premium ? `${event.id}#${attempt}` : null, (signal) =>
    // The roadmap doesn't use like/skip history; leaving it out keeps the request small (64 KB limit).
    roadmap({ event, profile: { ...profile, liked: [], skipped: [], likedTags: [] }, plan }, signal),
  );
  const steps = result.data ? sortSteps(result.data.steps) : [];
  const dated = steps.filter((s) => s.date);

  const download = () => {
    if (!dated.length) {
      notify("No dated steps yet", "There's nothing to add to a calendar for this event.");
      return;
    }
    const items = dated.map((step, i) => {
      const url = safeExternalUrl(step.link?.url);
      return {
        uid: `roadmap-${slugify(event.id)}-${i}@livento`,
        date: step.date as string,
        summary: `${step.title} · ${event.name}`,
        description: `${step.detail}${url && step.link ? `\n${step.link.label}: ${url}` : ""}`,
        url,
      };
    });
    downloadFile(`livento-roadmap-${slugify(event.name)}.ics`, buildIcs(items, `Livento: ${event.name}`));
    notify("Roadmap downloaded", `${items.length} dated step${items.length === 1 ? "" : "s"} for your calendar.`);
  };

  return (
    <div className={`wrap ${ui.page}`}>
      <p className={styles.crumbs}>
        <Link href={eventHref(event.id)} className={ui.inlineLink}>
          <span aria-hidden="true">←</span> {event.name}
        </Link>
      </p>
      <header className={ui.head}>
        <p className="kicker">03 / Roadmap</p>
        <h1 className="title">Your plan for {event.name}</h1>
        <p className="lead muted">
          {[eventWhen(event), event.venue, eventPlace(event)].filter(Boolean).join(" · ")}
        </p>
        <div className={styles.summary}>
          <span>
            Total {usd0(plan.total)} <span className="tag estimate">Estimate</span>
          </span>
          {plan.weekly > 0 ? (
            <span>
              About {usd0(plan.weekly)}/week until {deadlineText(plan)}
            </span>
          ) : (
            <span>Already covered by your envelope</span>
          )}
        </div>
      </header>

      {!premium ? (
        <PremiumGate
          title="Roadmaps are Premium"
          description="Get dated steps for this event: when to start saving, presale reminders, when to ask for time off, travel and hotel links with your dates, and a day-of checklist."
        />
      ) : (
        <section aria-labelledby="steps-title" aria-busy={result.loading}>
          <div className={ui.sectionHead}>
            <h2 id="steps-title" className={ui.sectionTitle}>
              Step by step
            </h2>
            {result.data ? (
              <button type="button" className="pill small alt" onClick={download} disabled={!dated.length}>
                Download dated steps (.ics)
              </button>
            ) : null}
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {result.loading
              ? "Building your roadmap…"
              : result.data
                ? `Roadmap ready with ${steps.length} steps.`
                : result.error
                  ? "Couldn't build the roadmap."
                  : ""}
          </p>

          {result.loading ? (
            <div className={styles.loading} aria-hidden="true">
              <p className={ui.status}>Building your roadmap. This can take up to 20 seconds.</p>
              <div className={ui.skeleton}>
                <div className={ui.skelTitle} />
                <div className={ui.skelTitle} />
                <div className={ui.skelTitle} />
              </div>
            </div>
          ) : null}

          {result.error ? (
            <ErrorState
              title="We couldn't build the roadmap"
              message={result.error}
              onRetry={() => setAttempt((a) => a + 1)}
              backHref={eventHref(event.id)}
              backLabel="Back to the event"
            />
          ) : null}

          {result.data ? (
            steps.length ? (
              <>
                <Accordion.Root type="multiple" defaultValue={["step-0"]} className={styles.steps}>
                  {steps.map((step, i) => {
                    const url = safeExternalUrl(step.link?.url);
                    return (
                      <Accordion.Item key={`${step.title}-${i}`} value={`step-${i}`} className={styles.step}>
                        <Accordion.Header className={styles.stepHeader}>
                          <Accordion.Trigger className={styles.trigger}>
                            <span className={styles.when}>
                              {step.date ? formatDate(step.date, "medium") : "Any time"}
                            </span>
                            <span className={styles.stepTitle}>{step.title}</span>
                            <span className={styles.kind}>{KIND_LABELS[step.kind] ?? step.kind}</span>
                            <span className={styles.chevron} aria-hidden="true" />
                          </Accordion.Trigger>
                        </Accordion.Header>
                        <Accordion.Content className={styles.content}>
                          <div className={styles.contentInner}>
                            <p>{step.detail}</p>
                            {url && step.link ? (
                              <a className="pill small alt" href={url} target="_blank" rel="noopener noreferrer">
                                {step.link.label}
                                <span className="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span>
                              </a>
                            ) : null}
                          </div>
                        </Accordion.Content>
                      </Accordion.Item>
                    );
                  })}
                </Accordion.Root>
                <p className={`${ui.meta} ${styles.footnote}`}>
                  {result.data.writer === "llm"
                    ? "Step text written by AI from your plan. Every date and dollar amount comes from Livento's rules, not the AI."
                    : "Built from Livento's templates and your plan's numbers."}{" "}
                  Links open the official or search pages in a new tab; Livento doesn&rsquo;t book anything.
                  {steps.length > dated.length
                    ? ` ${steps.length - dated.length} step${steps.length - dated.length === 1 ? " has" : "s have"} no date and ${steps.length - dated.length === 1 ? "isn't" : "aren't"} in the calendar file.`
                    : ""}
                </p>
              </>
            ) : (
              <ErrorState
                title="No steps came back"
                message="Try again in a moment."
                onRetry={() => setAttempt((a) => a + 1)}
                backHref={eventHref(event.id)}
                backLabel="Back to the event"
              />
            )
          ) : null}
        </section>
      )}
    </div>
  );
}

/** /roadmap/[id] — ordered, dated steps for one event (Premium). */
export function RoadmapView({ id }: { id: string }) {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading roadmap…" />;
  if (!state.profile) {
    return <NoProfile text="Set up a quick profile (or use the sample) so the roadmap can use your city, budget and vacation days." />;
  }
  const eventId = safeDecode(id);
  const event = state.savedEvents[eventId];
  if (!event) {
    return <EventLookup id={eventId} kicker="Roadmap" hint="Pick an event in Discover, then choose “Open roadmap”." />;
  }
  return <Roadmap key={event.id} event={event} profile={state.profile} state={state} />;
}
