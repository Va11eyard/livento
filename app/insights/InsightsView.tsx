"use client";

import * as Slider from "@radix-ui/react-slider";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { formatDate, formatMonth, usd0, weeksLabel } from "@/components/app/format";
import { PremiumGate } from "@/components/app/PremiumGate";
import { NoProfile, Notice, PageSkeleton, SampleBanner } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { errorMessage, insights, isAbortError } from "@/lib/client-api";
import { clearInsights, getAppState, hasPremium, setInsights, useAppState, useHydrated } from "@/lib/storage";
import type { AppState, Envelope, InsightsMonth, InsightsRequest, InsightsSummary } from "@/lib/types";
import {
  categoryTotals,
  coveredDays,
  goalImpact,
  monthLength,
  monthlyAverage,
  topMerchants,
  trimPlan,
  type CategoryTotal,
} from "./plan";
import styles from "./insights.module.css";

const MAX_BYTES = 1_000_000; // same limit as the server (lib/spending MAX_CSV_BYTES)
const MAX_RANKED = 7;
const MAX_MERCHANTS = 8;
const PCT_MIN = 10;
const PCT_MAX = 100;
const PCT_DEFAULT = 25;
const SHORT_DAYS = 28;

type Phase =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "error"; message: string }
  | { status: "done"; note: string; warnings: string[] };

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function monthRange(months: InsightsMonth[]): string {
  if (months.length === 0) return "";
  const first = formatMonth(months[0].month);
  const last = formatMonth(months[months.length - 1].month);
  return first === last ? first : `${first} – ${last}`;
}

function savedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function biggestCategory(m: InsightsMonth): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of Object.entries(m.byCategory)) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0];
}

/** Top categories plus one "Everything else" row, by monthly average. */
function rankedCategories(categories: CategoryTotal[]): CategoryTotal[] {
  if (categories.length <= MAX_RANKED + 1) return categories;
  const rest = categories.slice(MAX_RANKED);
  return [
    ...categories.slice(0, MAX_RANKED),
    {
      name: "Everything else",
      total: rest.reduce((sum, c) => sum + c.total, 0),
      perMonth: rest.reduce((sum, c) => sum + c.perMonth, 0),
    },
  ];
}

/** What changed in the saved summary, in a sentence or two. */
function describeSave(
  before: InsightsSummary | undefined,
  incoming: InsightsMonth[],
  source: InsightsSummary["source"],
  label: string,
): string {
  const months = plural(incoming.length, "month");
  if (source === "sample") {
    return before?.source === "upload"
      ? `The sample statement replaced the months saved from your files (${months} of sample data).`
      : `Saved ${months} from the sample statement.`;
  }
  if (before?.source === "upload") {
    const had = new Set(before.months.map((m) => m.month));
    const replaced = incoming.filter((m) => had.has(m.month)).map((m) => formatMonth(m.month));
    const parts = [`Added ${plural(incoming.length - replaced.length, "new month")} from ${label}.`];
    if (replaced.length) {
      parts.push(`${replaced.join(", ")} ${replaced.length === 1 ? "was" : "were"} replaced by the newer file.`);
    }
    return parts.join(" ");
  }
  if (before?.source === "sample") return `Saved ${months} from ${label}, replacing the sample.`;
  return `Saved ${months} from ${label}.`;
}

function GoalRow({ envelope, extraWeekly }: { envelope: Envelope; extraWeekly: number }) {
  const impact = goalImpact(envelope, extraWeekly);
  let text: ReactNode;
  if (impact.kind === "funded") {
    text = "Fully set aside.";
  } else if (impact.kind === "passed") {
    text = impact.weeksWithExtra
      ? `Its date has passed. ${usd0(extraWeekly)} a week would cover the remaining ${usd0(impact.remaining)} in ${weeksLabel(impact.weeksWithExtra)}.`
      : `Its date has passed, with ${usd0(impact.remaining)} to go. You can update the date from the event page.`;
  } else if (extraWeekly <= 0) {
    text = `Planned: about ${usd0(impact.weekly)} a week, there by ${formatDate(impact.reachOn, "medium")}.`;
  } else if (impact.weeksSooner > 0) {
    text = (
      <>
        <strong>You could get there {weeksLabel(impact.weeksSooner)} sooner:</strong> by{" "}
        {formatDate(impact.reachWithExtraOn, "medium")} instead of {formatDate(impact.reachOn, "medium")} (planned
        about {usd0(impact.weekly)} a week).
      </>
    );
  } else {
    text = `About the same date (${formatDate(impact.reachOn, "medium")}): it's close already, so the extra changes it by less than a week.`;
  }
  return (
    <li className={styles.goal}>
      <p className={styles.goalName}>
        {envelope.eventName} <span className={styles.goalTarget}>· goal {usd0(envelope.target)}</span>
      </p>
      <EnvelopeBar balance={impact.balance} target={envelope.target} label={`Set aside for ${envelope.eventName}`} />
      <p className={styles.goalText}>{text}</p>
    </li>
  );
}

/** "Pick what you'd spend less on": user-chosen categories and percentage; nothing is preselected. */
function SpendLessPlan({ categories, envelopes }: { categories: CategoryTotal[]; envelopes: Envelope[] }) {
  const id = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [pct, setPct] = useState(PCT_DEFAULT);
  const plan = trimPlan(categories, picked, pct);
  const hasPick = plan.lines.length > 0;
  const monthly = Math.round(plan.perMonth);
  const weekly = Math.round(plan.perWeek);

  return (
    <section className={ui.blockRule} aria-labelledby={`${id}-title`}>
      <div className={styles.planHead}>
        <h2 id={`${id}-title`} className={ui.sectionTitle}>
          Pick what you&rsquo;d spend less on
        </h2>
        <p className={ui.meta}>Your call: choose any categories and how much less. Nothing is picked for you.</p>
      </div>

      <div className={styles.planGrid}>
        <div className={styles.planControls}>
          <div className={styles.control}>
            <p className="label" id={`${id}-cats`}>
              Categories
            </p>
            <ToggleGroup.Root
              type="multiple"
              value={picked}
              onValueChange={setPicked}
              aria-labelledby={`${id}-cats`}
              className={ui.chips}
            >
              {categories.map((c) => (
                <ToggleGroup.Item key={c.name} value={c.name} className={ui.chip}>
                  {c.name}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>

          <div className={styles.sliderBlock}>
            <div className={styles.sliderHead}>
              <span className="label">How much less</span>
              <span className={styles.sliderValue} aria-hidden="true">
                {pct}%
              </span>
            </div>
            <Slider.Root
              className={styles.slider}
              value={[pct]}
              min={PCT_MIN}
              max={PCT_MAX}
              step={5}
              onValueChange={(value) => setPct(value[0] ?? PCT_DEFAULT)}
            >
              <Slider.Track className={styles.sliderTrack}>
                <Slider.Range className={styles.sliderRange} />
              </Slider.Track>
              <Slider.Thumb className={styles.sliderThumb} aria-label="How much less" aria-valuetext={`${pct}% less`} />
            </Slider.Root>
            <div className={styles.sliderScale} aria-hidden="true">
              <span>10% less</span>
              <span>100% less</span>
            </div>
          </div>
        </div>

        <div className={styles.frees}>
          {hasPick ? (
            <>
              <p className={styles.freesLabel}>
                You could free about <span className="tag estimate">Estimate</span>
              </p>
              <p className={styles.freesValue}>
                {usd0(monthly)}
                <span className={styles.freesUnit}> a month</span>
              </p>
              <p className={styles.freesWeek}>{usd0(weekly)} a week</p>
              <ul className={`${ui.plainList} ${styles.trimLines}`} aria-label="By category, per month">
                {plan.lines.map((l) => (
                  <li key={l.name}>
                    <span>{l.name}</span>
                    <span>
                      {usd0(l.perMonth)} → {usd0(l.perMonth - l.less)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={styles.freesEmpty}>
              Pick one or more categories to see what spending {pct}% less there could free each month and week.
            </p>
          )}
          <p className="sr-only" aria-live="polite">
            {hasPick ? `You could free about ${usd0(monthly)} a month, ${usd0(weekly)} a week.` : ""}
          </p>
        </div>
      </div>

      <div className={styles.goals}>
        <h3 className={styles.goalsTitle}>
          Your saving goals <span className="tag estimate">Estimate</span>
        </h3>
        {envelopes.length ? (
          <>
            <p className={ui.meta}>
              {hasPick && weekly > 0
                ? `Each goal assumes the whole ${usd0(weekly)} a week goes to it, on top of its planned weekly amount.`
                : "Pick categories above to see how much sooner each goal could arrive."}
            </p>
            <ul className={`${ui.plainList} ${styles.goalList}`}>
              {envelopes.map((env) => (
                <GoalRow key={env.id} envelope={env} extraWeekly={hasPick ? weekly : 0} />
              ))}
            </ul>
            <p className={styles.planAction}>
              <Link href="/envelopes" className="pill">
                Turn on auto-save <span aria-hidden="true">↗</span>
              </Link>
            </p>
          </>
        ) : (
          <div className={ui.outline}>
            <p>No saving goals yet. Pick an experience to save for, and this shows how much sooner you could get there.</p>
            <p className={styles.planAction}>
              <Link href="/discover" className="pill small">
                Find an experience <span aria-hidden="true">↗</span>
              </Link>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function Results({
  summary,
  envelopes,
  onDeleted,
}: {
  summary: InsightsSummary;
  envelopes: Envelope[];
  onDeleted: () => void;
}) {
  const notify = useToast();
  const { months } = summary;
  const days = coveredDays(months);
  const categories = categoryTotals(months);
  const ranked = rankedCategories(categories);
  const maxRanked = Math.max(1, ...ranked.map((c) => c.perMonth));
  const merchants = topMerchants(months, MAX_MERCHANTS);
  const maxSpend = Math.max(1, ...months.map((m) => m.spendTotal));
  const purchases = months.reduce((sum, m) => sum + m.count, 0);
  const partial = months.filter((m) => m.days < monthLength(m.month)).length;
  const isSample = summary.source === "sample";
  const biggest = categories[0];

  return (
    <div className={styles.results}>
      <div className={styles.resultHead}>
        <p className={ui.meta}>
          {isSample ? <span className="tag sample">Sample data</span> : null} Saved on this device · {monthRange(months)} ·{" "}
          {plural(purchases, "purchase")} ·{" "}
          {summary.classifier === "rules+llm" ? "Rules, plus AI for unclear merchants" : "Rule-based categories"} · Updated{" "}
          {savedOn(summary.analyzedAt)}
        </p>
        <ConfirmDialog
          triggerLabel="Delete summary"
          triggerClassName="pill small alt"
          title="Delete the saved summary?"
          description="This removes the spending summary from this device. The bank file itself was never kept, so there's nothing else to delete."
          confirmLabel="Delete summary"
          cancelLabel="Keep it"
          onConfirm={() => {
            clearInsights();
            onDeleted();
            notify("Summary deleted", "Upload a statement or use the sample to see it again.");
          }}
        />
      </div>

      {isSample ? (
        <SampleBanner>This is a fictional sample statement, so the numbers below are for trying Livento only.</SampleBanner>
      ) : null}
      {days < SHORT_DAYS ? (
        <Notice label="Note">
          These statements cover {plural(days, "day")}, so the monthly figures are a rough estimate.
        </Notice>
      ) : null}

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>
            Spent per month <span className="tag estimate">Estimate</span>
          </p>
          <p className={styles.tileValue}>{usd0(monthlyAverage(months))}</p>
          <p className={ui.meta}>average over {plural(days, "day")}</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>Biggest category</p>
          <p className={`${styles.tileValue} ${styles.tileText}`}>{biggest?.name ?? "None"}</p>
          <p className={ui.meta}>{biggest ? `about ${usd0(biggest.perMonth)} a month` : "No spending found"}</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>Months covered</p>
          <p className={styles.tileValue}>{months.length}</p>
          <p className={ui.meta}>
            {monthRange(months)}
            {partial ? ` · ${partial} partial` : ""}
          </p>
        </div>
      </div>

      <section className={ui.block} aria-labelledby="months-title">
        <div className={ui.sectionHead}>
          <h2 id="months-title" className={ui.sectionTitle}>
            Month by month
          </h2>
          <p className={ui.meta}>Total spending, without transfers or income</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">
              Total spending by month, with each month&rsquo;s biggest category. Partial months show how many days the
              statement covers.
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className={styles.chartCol}>
                  <span className="sr-only">Chart</span>
                </th>
                <th scope="col" className={styles.num}>
                  Spent
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const length = monthLength(m.month);
                const top = biggestCategory(m);
                return (
                  <tr key={m.month}>
                    <th scope="row">
                      {formatMonth(m.month)}
                      {m.days < length ? (
                        <span className={styles.sub}>
                          Partial: {m.days} of {length} days
                        </span>
                      ) : null}
                      {top ? <span className={styles.sub}>Most on {top}</span> : null}
                    </th>
                    <td className={styles.chartCol} aria-hidden="true">
                      {m.spendTotal > 0 ? (
                        <div className={styles.bar} style={{ width: `${Math.max(1.5, (m.spendTotal / maxSpend) * 100)}%` }} />
                      ) : null}
                    </td>
                    <td className={styles.num}>{usd0(m.spendTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className={`${ui.block} ${styles.split}`}>
        <section aria-labelledby="categories-title">
          <div className={styles.subHead}>
            <h2 id="categories-title" className={ui.sectionTitle}>
              By category
            </h2>
            <p className={styles.subMeta}>
              Average per month <span className="tag estimate">Estimate</span>
            </p>
          </div>
          {ranked.length ? (
            <ul className={`${ui.plainList} ${styles.rank}`}>
              {ranked.map((c) => (
                <li key={c.name}>
                  <span className={styles.rankName}>{c.name}</span>
                  <span className={styles.rankTrack} aria-hidden="true">
                    <span className={styles.rankBar} style={{ width: `${Math.max(1.5, (c.perMonth / maxRanked) * 100)}%` }} />
                  </span>
                  <span className={styles.rankValue}>
                    {usd0(c.perMonth)}
                    <span className="sr-only"> a month</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={ui.status}>No spending categories found.</p>
          )}
        </section>

        <section aria-labelledby="merchants-title">
          <div className={styles.subHead}>
            <h2 id="merchants-title" className={ui.sectionTitle}>
              Top merchants
            </h2>
            <p className={styles.subMeta}>All saved months · bills and rent not included</p>
          </div>
          {merchants.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">Top merchants by total spent over the saved months, bills and rent not included</caption>
                <thead>
                  <tr>
                    <th scope="col">Merchant</th>
                    <th scope="col" className={styles.num}>
                      Purchases
                    </th>
                    <th scope="col" className={styles.num}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {merchants.map((m) => (
                    <tr key={m.name}>
                      <th scope="row">{m.name}</th>
                      <td className={styles.num}>{m.count}</td>
                      <td className={styles.num}>{usd0(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={ui.status}>No merchants found.</p>
          )}
        </section>
      </div>

      {categories.length ? <SpendLessPlan categories={categories} envelopes={envelopes} /> : null}

      <p className={`${ui.meta} ${styles.method}`}>
        Categories come from merchant names
        {summary.classifier === "rules+llm" ? "; AI sorted the merchants the rules didn't recognize" : ""}. Transfers and
        income are left out. Monthly figures are averages over the days the statements cover; weekly figures are monthly
        ÷ 4.33.
      </p>
    </div>
  );
}

function Insights({ state }: { state: AppState }) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const summary = state.insights;

  useEffect(() => () => controller.current?.abort(), []);

  async function run(req: InsightsRequest, label: string) {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setPhase({ status: "loading", label });
    try {
      const data = await insights(req, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const source = data.isSample ? "sample" : "upload";
      const before = getAppState().insights;
      const saved = setInsights({ source, classifier: data.classifier, months: data.months });
      if (!saved) {
        setPhase({ status: "error", message: "We couldn't find any months with spending in that file." });
        return;
      }
      setPhase({ status: "done", note: describeSave(before, data.months, source, label), warnings: data.warnings });
    } catch (err) {
      if (isAbortError(err) || ctrl.signal.aborted) return;
      setPhase({ status: "error", message: errorMessage(err) });
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // allow choosing the same file again
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setPhase({ status: "error", message: "That file is larger than 1 MB. Export a shorter date range and try again." });
      return;
    }
    if (!/\.csv$/i.test(file.name) && !/csv|plain|excel/i.test(file.type)) {
      setPhase({ status: "error", message: "Please choose a .csv file exported from your bank." });
      return;
    }
    let text = "";
    try {
      text = await file.text();
    } catch {
      setPhase({ status: "error", message: "We couldn't read that file. Try exporting it again." });
      return;
    }
    if (!text.trim()) {
      setPhase({ status: "error", message: "That file looks empty." });
      return;
    }
    void run({ csv: text }, file.name);
  }

  const loading = phase.status === "loading";
  const runSample = () => void run({ sample: true }, "the sample statement");

  return (
    <>
      <div className={`${ui.panel} ${styles.upload}`}>
        <div className={styles.uploadText}>
          <h2 className={ui.smallTitle}>{summary ? "Add another statement" : "Add a bank statement"}</h2>
          <p className={ui.meta}>
            Export a CSV from your bank&rsquo;s website (most offer &ldquo;Download transactions&rdquo;). Up to 1 MB. We never
            ask for bank logins.
            {summary?.source === "upload" ? " Months you already have are replaced by the newer file." : ""}
          </p>
        </div>
        <div className={styles.uploadActions}>
          <label htmlFor={`${id}-file`} className={`pill ${loading ? styles.disabledLabel : ""}`}>
            Choose CSV file <span aria-hidden="true">↗</span>
          </label>
          <input
            id={`${id}-file`}
            className="sr-only"
            type="file"
            accept=".csv,text/csv"
            disabled={loading}
            onChange={(event) => void onFile(event)}
          />
          {summary?.source === "upload" ? (
            <ConfirmDialog
              triggerLabel="Use sample statement"
              triggerClassName="pill alt"
              title="Replace your summary with the sample?"
              description="The fictional sample replaces the months saved from your files on this device. You can upload your files again anytime."
              confirmLabel="Use the sample"
              cancelLabel="Keep mine"
              onConfirm={runSample}
            />
          ) : (
            <button type="button" className="pill alt" disabled={loading} onClick={runSample}>
              Use sample statement <span aria-hidden="true">●</span>
            </button>
          )}
        </div>
        <p className={styles.privacy}>
          <strong>The summary is saved on this device. The file itself isn&rsquo;t kept.</strong> Your browser sends the CSV
          to Livento&rsquo;s server once, where it&rsquo;s parsed in memory and discarded. Only totals by month, category
          and merchant stay in this browser.
        </p>
      </div>

      <div aria-live="polite" aria-busy={loading} className={styles.output}>
        {phase.status === "loading" ? (
          <div className={styles.loading}>
            <p className={ui.status}>Reading {phase.label}…</p>
            <div className={ui.skeleton} aria-hidden="true">
              <div className={ui.skelTitle} />
              <div className={ui.skelLine} />
            </div>
          </div>
        ) : null}
        {phase.status === "error" ? (
          <Notice tone="error" label="Couldn't analyze">
            {phase.message}
          </Notice>
        ) : null}
        {phase.status === "done" ? (
          <Notice tone="ok" label="Saved">
            {phase.note}
            {phase.warnings.length ? ` ${phase.warnings.slice(0, 4).join(" ")}` : ""}
          </Notice>
        ) : null}
      </div>

      {summary ? (
        <Results summary={summary} envelopes={state.envelopes} onDeleted={() => setPhase({ status: "idle" })} />
      ) : null}
    </>
  );
}

/** /insights — where your money goes, from a bank CSV or the labeled sample statement (Premium). */
export function InsightsView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading insights…" />;
  if (!state.profile) {
    return (
      <NoProfile text="Set up a quick profile (or use the sample) first, then see where your money goes and what spending a little less could free for your goals." />
    );
  }
  const premium = hasPremium(state);
  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">04 / Insights</p>
        <h1 className="title">Where your money goes</h1>
        <p className="lead muted">
          Upload a bank CSV or try the sample statement. See your spending by category, month and merchant, then pick what
          you&rsquo;d spend less on and see what it frees for your goals.
        </p>
      </header>
      {premium ? (
        <Insights state={state} />
      ) : (
        <PremiumGate
          title="Insights are Premium"
          description="Upload a bank CSV (or use the sample) to see spending by category, month and merchant, and what spending less in a few categories could free for your goals. The summary is saved on this device; the file itself isn't kept."
        />
      )}
    </div>
  );
}
