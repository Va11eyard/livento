"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { eventHref } from "@/components/app/EventCard";
import { formatDate, usd, usd0, weeksLabel } from "@/components/app/format";
import { buildIcs, downloadFile, slugify } from "@/components/app/ics";
import { PremiumGate } from "@/components/app/PremiumGate";
import { reminderSchedule } from "@/components/app/savings";
import { NoProfile, PageSkeleton } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import {
  addDeposit,
  envelopeBalance,
  hasPremium,
  removeEnvelope,
  totalSetAside,
  useAppState,
  useHydrated,
} from "@/lib/storage";
import type { AppState, Envelope, LiventoEvent } from "@/lib/types";
import styles from "./envelopes.module.css";

const QUICK_AMOUNTS = [10, 25, 50];
const MAX_ENTRY = 100_000;

function EnvelopeCard({ envelope, event }: { envelope: Envelope; event?: LiventoEvent }) {
  const id = useId();
  const notify = useToast();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const balance = envelopeBalance(envelope);
  const schedule = reminderSchedule(envelope.target, balance, envelope.deadline, 6);
  const funded = envelope.target > 0 && balance >= envelope.target;
  const recent = [...envelope.deposits].reverse().slice(0, 5);

  const record = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter an amount above $0, like 25.");
      return;
    }
    if (value > MAX_ENTRY) {
      setError("That's more than one entry can hold. Split it into smaller amounts.");
      return;
    }
    addDeposit(envelope.id, value);
    setAmount("");
    setError(null);
    notify(`Logged ${usd(value)} for ${envelope.eventName}`, "The money stays in your bank. This only keeps count.");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const cleaned = amount.replace(/[$,\s]/g, "");
    record(cleaned === "" ? NaN : Number(cleaned));
  };

  const downloadReminders = () => {
    const all = reminderSchedule(envelope.target, balance, envelope.deadline, 52);
    if (!all.items.length) {
      notify("No reminders needed", "This envelope is already funded.");
      return;
    }
    const items = all.items.map((r, i) => ({
      uid: `${envelope.id}-${r.date}-${i}@livento`,
      date: r.date,
      summary: `Set aside ${usd0(r.amount)} for ${envelope.eventName}`,
      description: `Livento reminder: move ${usd0(r.amount)} into your own savings for ${envelope.eventName}, then log it in Livento. Livento never holds or moves money.`,
    }));
    downloadFile(`livento-reminders-${slugify(envelope.eventName)}.ics`, buildIcs(items, `Livento: ${envelope.eventName}`));
    notify(
      "Reminders downloaded",
      `${items.length} weekly reminder${items.length === 1 ? "" : "s"}. Open the file to add them to your calendar.`,
    );
  };

  return (
    <article className={styles.card} aria-labelledby={`${id}-title`}>
      <div className={styles.cardHead}>
        <div className={styles.cardIntro}>
          <h2 id={`${id}-title`} className={styles.cardTitle}>
            {event ? <Link href={eventHref(envelope.eventId)}>{envelope.eventName}</Link> : envelope.eventName}
          </h2>
          <p className={ui.meta}>
            {envelope.eventDate ? `Event ${formatDate(envelope.eventDate, "medium")} · ` : ""}
            Needed by {formatDate(envelope.deadline, "medium")} · Goal {usd0(envelope.target)}{" "}
            <span className="tag estimate">Estimate</span>
          </p>
        </div>
        <ConfirmDialog
          triggerLabel="Delete"
          triggerAriaLabel={`Delete the envelope for ${envelope.eventName}`}
          triggerClassName={styles.delete}
          title="Delete this envelope?"
          description={`This removes the ${envelope.eventName} envelope and its ${envelope.deposits.length} logged ${
            envelope.deposits.length === 1 ? "entry" : "entries"
          } from this browser. Your actual money isn't affected.`}
          confirmLabel="Delete envelope"
          cancelLabel="Keep it"
          onConfirm={() => {
            removeEnvelope(envelope.id);
            notify("Envelope deleted");
          }}
        />
      </div>

      <EnvelopeBar balance={balance} target={envelope.target} label={`Set aside for ${envelope.eventName}`} />

      <div className={styles.cardBody}>
        <form className={styles.deposit} onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor={`${id}-amount`}>I set aside ($)</label>
            <div className={styles.depositRow}>
              <input
                id={`${id}-amount`}
                inputMode="decimal"
                placeholder="e.g. 25"
                value={amount}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : `${id}-help`}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setError(null);
                }}
              />
              <button type="submit" className="pill small">
                Log it
              </button>
            </div>
          </div>
          <div className={ui.chips} role="group" aria-label={`Quick amounts for ${envelope.eventName}`}>
            {QUICK_AMOUNTS.map((value) => (
              <button key={value} type="button" className={ui.chip} onClick={() => record(value)}>
                + ${value}
              </button>
            ))}
          </div>
          {error ? (
            <p id={`${id}-error`} className={ui.error} role="alert">
              {error}
            </p>
          ) : (
            <p id={`${id}-help`} className="help">
              Move the money in your own bank first, then log it here.
            </p>
          )}
          {recent.length ? (
            <details className={styles.history}>
              <summary>
                History ({envelope.deposits.length} {envelope.deposits.length === 1 ? "entry" : "entries"})
              </summary>
              <ul className={ui.plainList}>
                {recent.map((d, i) => (
                  <li key={`${d.date}-${i}`}>
                    <span>{formatDate(d.date, "medium")}</span>
                    <span>
                      {d.amount >= 0 ? "+" : "−"}
                      {usd(Math.abs(d.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </form>

        <div className={styles.schedule}>
          <h3 className={styles.scheduleTitle}>Weekly reminders</h3>
          {funded ? (
            <p>You&rsquo;ve set aside the full {usd0(envelope.target)}. Enjoy it.</p>
          ) : (
            <>
              <p className={ui.meta}>
                About {usd0(schedule.weekly)} a week for {weeksLabel(schedule.weeksLeft)}.
                {schedule.deadlinePassed ? " The deadline has passed; update it from the event page." : ""}
              </p>
              <ol className={styles.reminders} aria-label="Next reminders">
                {schedule.items.map((r, i) => (
                  <li key={r.date}>
                    <span>{i === 0 ? "Today" : formatDate(r.date, "medium")}</span>
                    <strong>{usd0(r.amount)}</strong>
                  </li>
                ))}
              </ol>
            </>
          )}
          <button type="button" className="pill small alt" onClick={downloadReminders} disabled={funded}>
            Download reminders (.ics)
          </button>
        </div>
      </div>
    </article>
  );
}

function Envelopes({ state }: { state: AppState }) {
  const premium = hasPremium(state);
  const total = totalSetAside(state.envelopes);
  const goals = state.envelopes.reduce((sum, e) => sum + e.target, 0);

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">02 / Envelopes</p>
        <div className={ui.headRow}>
          <h1 className="title">Money set aside for experiences</h1>
          {premium && state.envelopes.length ? (
            <div className={styles.total}>
              <span className={styles.totalLabel}>Total set aside</span>
              <span className={ui.figure}>{usd(total)}</span>
              <span className={ui.meta}>toward {usd0(goals)} in goals</span>
            </div>
          ) : null}
        </div>
        <p className="lead muted">
          Your money stays in your own bank. Livento only tracks it: log what you move, and the plan stays honest.
        </p>
      </header>

      {!premium ? (
        <PremiumGate
          title="Envelopes are Premium"
          description="Create an envelope from any event's cost plan, log money as you set it aside, and get a weekly reminder schedule for your calendar."
        />
      ) : state.envelopes.length === 0 ? (
        <div className={ui.outline}>
          <h2 className={ui.smallTitle}>No envelopes yet</h2>
          <p className={styles.emptyText}>
            Open any event, check its full cost, then choose &ldquo;Create envelope&rdquo; in the Plan it section.
          </p>
          <Link href="/discover" className="pill small">
            Find an event <span aria-hidden="true">↗</span>
          </Link>
        </div>
      ) : (
        <div className={styles.list}>
          {state.envelopes.map((envelope) => (
            <EnvelopeCard key={envelope.id} envelope={envelope} event={state.savedEvents[envelope.eventId]} />
          ))}
        </div>
      )}
    </div>
  );
}

/** /envelopes — balances, quick "I set aside $X", reminder schedule + .ics. */
export function EnvelopesView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading envelopes…" />;
  if (!state.profile && state.envelopes.length === 0) {
    return <NoProfile text="Set up a quick profile (or use the sample), pick an event, and create an envelope from its cost plan." />;
  }
  return <Envelopes state={state} />;
}
