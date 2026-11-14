"use client";

import { useId, type ReactNode } from "react";
import { needsTrip } from "@/lib/cost";
import {
  DEFAULT_BUFFER_PCT,
  DEFAULT_FEES_PCT,
  type CostLine,
  type CostLineKey,
  type CostOverrides,
  type LiventoEvent,
  type PlanResult,
  type Profile,
} from "@/lib/types";
import { formatDate, usd0, weeksLabel } from "./format";
import { NumberInput } from "./NumberInput";
import styles from "./CostTable.module.css";

function nonNeg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

const toPct = (fraction: number) => Math.round(fraction * 1000) / 10;

/** "the public on-sale (Fri, Dec 5, 2026)" etc. */
export function deadlineText(plan: PlanResult): string {
  const date = formatDate(plan.deadline);
  if (plan.deadlineKind === "on-sale") return `the public on-sale on ${date}`;
  if (plan.deadlineKind === "event") return `the event on ${date}`;
  return `${date} (an 8-week goal, since no date is announced)`;
}

function Row({ line, fallbackLabel, children }: { line?: CostLine; fallbackLabel: string; children: ReactNode }) {
  return (
    <div className={styles.row} role="group" aria-label={line?.label ?? fallbackLabel}>
      <div className={styles.head}>
        <span className={styles.label}>{line?.label ?? fallbackLabel}</span>
        {line?.estimate ? <span className="tag estimate">Estimate</span> : null}
      </div>
      <div className={styles.inputs}>{children}</div>
      <div className={styles.amount}>{usd0(line?.amount ?? 0)}</div>
      {line?.note ? <p className={styles.note}>{line.note}</p> : null}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

interface CostTableProps {
  event: LiventoEvent;
  profile: Profile;
  plan: PlanResult;
  overrides: CostOverrides;
  onChange: (next: CostOverrides) => void;
  /** Weekly savings line (Premium: FR-7). */
  showWeekly?: boolean;
}

/** Editable cost estimate (FR-6). Every default is labeled; totals update as you type. */
export function CostTable({ event, profile, plan, overrides, onChange, showWeekly = false }: CostTableProps) {
  const id = useId();
  const trip = needsTrip(event, profile);
  // Effective inputs: the user's edit, else the same default rule lib/cost uses.
  const v = {
    tickets: overrides.tickets ?? 1,
    ticketPrice: overrides.ticketPrice ?? nonNeg(event.priceMin) ?? nonNeg(event.priceMax),
    feesPct: overrides.feesPct ?? DEFAULT_FEES_PCT,
    travel: overrides.travel ?? (trip ? profile.travelPerTrip : 0),
    hotelNights: overrides.hotelNights ?? (trip ? 1 : 0),
    hotelPerNight: overrides.hotelPerNight ?? profile.hotelPerNight,
    bufferPct: overrides.bufferPct ?? DEFAULT_BUFFER_PCT,
  };
  const line = (key: CostLineKey) => plan.lines.find((l) => l.key === key);
  const set = (patch: Partial<CostOverrides>) => {
    const next: CostOverrides = { ...overrides, ...patch };
    for (const key of Object.keys(next) as (keyof CostOverrides)[]) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next);
  };
  const edited = Object.keys(overrides).length > 0;
  const anyEstimate = plan.lines.some((l) => l.estimate);

  return (
    <div className={styles.table}>
      <Row line={line("ticket")} fallbackLabel="Tickets">
        <Field id={`${id}-qty`} label="Tickets">
          <NumberInput
            id={`${id}-qty`}
            value={v.tickets}
            min={1}
            max={20}
            integer
            onValueChange={(n) => set({ tickets: n })}
          />
        </Field>
        <span className={styles.times} aria-hidden="true">
          ×
        </span>
        <Field id={`${id}-price`} label="Price each ($)">
          <NumberInput
            id={`${id}-price`}
            value={v.ticketPrice}
            min={0}
            max={20000}
            placeholder="Enter"
            onValueChange={(n) => set({ ticketPrice: n })}
          />
        </Field>
      </Row>

      <Row line={line("fees")} fallbackLabel="Estimated fees">
        <Field id={`${id}-fees`} label="Fee rate (%)">
          <NumberInput
            id={`${id}-fees`}
            value={toPct(v.feesPct)}
            min={0}
            max={60}
            onValueChange={(n) => set({ feesPct: n === undefined ? undefined : n / 100 })}
          />
        </Field>
      </Row>

      <Row line={line("travel")} fallbackLabel="Travel">
        <Field id={`${id}-travel`} label="Travel ($)">
          <NumberInput
            id={`${id}-travel`}
            value={v.travel}
            min={0}
            max={20000}
            onValueChange={(n) => set({ travel: n })}
          />
        </Field>
      </Row>

      <Row line={line("hotel")} fallbackLabel="Hotel">
        <Field id={`${id}-nights`} label="Nights">
          <NumberInput
            id={`${id}-nights`}
            value={v.hotelNights}
            min={0}
            max={30}
            integer
            onValueChange={(n) => set({ hotelNights: n })}
          />
        </Field>
        <span className={styles.times} aria-hidden="true">
          ×
        </span>
        <Field id={`${id}-night`} label="Per night ($)">
          <NumberInput
            id={`${id}-night`}
            value={v.hotelPerNight}
            min={0}
            max={10000}
            onValueChange={(n) => set({ hotelPerNight: n })}
          />
        </Field>
      </Row>

      <Row line={line("buffer")} fallbackLabel="Buffer">
        <Field id={`${id}-buffer`} label="Buffer (%)">
          <NumberInput
            id={`${id}-buffer`}
            value={toPct(v.bufferPct)}
            min={0}
            max={60}
            onValueChange={(n) => set({ bufferPct: n === undefined ? undefined : n / 100 })}
          />
        </Field>
      </Row>

      <div className={styles.total}>
        <span className={styles.totalLabel}>
          Total {anyEstimate ? <span className="tag estimate">Estimate</span> : null}
        </span>
        <output className={styles.totalValue} aria-live="polite" htmlFor={`${id}-qty ${id}-price`}>
          {usd0(plan.total)}
        </output>
      </div>

      {showWeekly ? (
        <p className={styles.weekly}>
          {plan.weekly > 0 ? (
            <>
              About <strong>{usd0(plan.weekly)}/week</strong> for {weeksLabel(plan.weeks)} gets you there by{" "}
              {deadlineText(plan)}.
            </>
          ) : (
            <>What you&rsquo;ve set aside already covers this estimate.</>
          )}
        </p>
      ) : null}

      <div className={styles.footer}>
        <p className={styles.footnote}>
          Edit any number. Ticket prices come from the listing; fees, travel, hotel and buffer are estimates from your
          profile until you change them.
        </p>
        <button type="button" className={styles.reset} onClick={() => onChange({})} disabled={!edited}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
