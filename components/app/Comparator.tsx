"use client";

import { useId } from "react";
import { NEVER_WEEKS } from "@/lib/compare";
import type { ComparatorEvent, ComparatorResult } from "@/lib/types";
import { formatDate, usd0, weeksLabel } from "./format";
import styles from "./Comparator.module.css";

function weeksText(weeks: number, name: string): string {
  if (weeks <= 0) return `${name} is already covered`;
  if (weeks >= NEVER_WEEKS) return "No date yet: add a weekly amount to your budget";
  return weeksLabel(weeks);
}

function DeadlineStatus({ makes, deadline }: { makes: boolean | null; deadline?: string }) {
  if (makes === null || !deadline) return <>No deadline announced</>;
  return makes ? (
    <span className={styles.ok}>Ready before {formatDate(deadline, "medium")}</span>
  ) : (
    <span className={styles.warn}>Lands after {formatDate(deadline, "medium")}</span>
  );
}

interface ComparatorProps {
  a: ComparatorEvent; // cheaper / sooner: "go now"
  b: ComparatorEvent; // bigger one: "save for it"
  result: ComparatorResult;
  balance: number;
  weekly: number;
}

/** FR-9: two neutral columns. Shows timing for both paths and never picks one. */
export function Comparator({ a, b, result, balance, weekly }: ComparatorProps) {
  const id = useId();
  const { goNow, skip } = result;
  return (
    <div className={styles.wrap}>
      <div className={styles.cols}>
        <section className={styles.col} aria-labelledby={`${id}-go`}>
          <p className={styles.kicker}>Path 1 · Go now</p>
          <h3 id={`${id}-go`} className={styles.heading}>
            Go to {a.name} now
          </h3>
          <p className={styles.cost}>
            {usd0(a.cost)} <span className="tag estimate">Estimate</span>
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>Left in your envelopes after</dt>
              <dd>
                {goNow.shortfallForA > 0
                  ? `$0 — you'd need ${usd0(goNow.shortfallForA)} more first`
                  : usd0(goNow.remainingAfterA)}
              </dd>
            </div>
            <div>
              <dt>Then {b.name} is fully saved in</dt>
              <dd>{weeksText(goNow.weeksToB, b.name)}</dd>
            </div>
            {goNow.weeksToB > 0 && goNow.weeksToB < NEVER_WEEKS ? (
              <div>
                <dt>Around</dt>
                <dd>{formatDate(goNow.reachBOn)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{b.name} deadline</dt>
              <dd>
                <DeadlineStatus makes={goNow.makesBDeadline} deadline={b.deadline} />
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.col} aria-labelledby={`${id}-save`}>
          <p className={styles.kicker}>Path 2 · Save for the bigger one</p>
          <h3 id={`${id}-save`} className={styles.heading}>
            Keep saving for {b.name}
          </h3>
          <p className={styles.cost}>
            {usd0(b.cost)} <span className="tag estimate">Estimate</span>
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>Kept in your envelopes</dt>
              <dd>{usd0(balance)}</dd>
            </div>
            <div>
              <dt>{b.name} is fully saved in</dt>
              <dd>{weeksText(skip.weeksToB, b.name)}</dd>
            </div>
            {skip.weeksToB > 0 && skip.weeksToB < NEVER_WEEKS ? (
              <div>
                <dt>Around</dt>
                <dd>{formatDate(skip.reachBOn)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{b.name} deadline</dt>
              <dd>
                <DeadlineStatus makes={skip.makesBDeadline} deadline={b.deadline} />
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <p className={styles.footnote}>
        Based on {usd0(balance)} set aside now and about {usd0(weekly)} a week (your monthly fun budget ÷ 4.33). Both
        paths are fine choices. This only shows the timing.
      </p>
    </div>
  );
}
