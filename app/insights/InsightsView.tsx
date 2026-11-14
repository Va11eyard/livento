"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { formatMonth, usd0 } from "@/components/app/format";
import { PremiumGate } from "@/components/app/PremiumGate";
import { NoProfile, Notice, PageSkeleton, SampleBanner } from "@/components/app/States";
import ui from "@/components/app/ui.module.css";
import { errorMessage, insights, isAbortError } from "@/lib/client-api";
import { hasPremium, useAppState, useHydrated } from "@/lib/storage";
import type { AppState, InsightsRequest, InsightsResponse } from "@/lib/types";
import styles from "./insights.module.css";

const MAX_BYTES = 1_000_000; // same limit as the server (lib/impulse MAX_CSV_BYTES)
const MAX_CATEGORIES = 7;
const MAX_MERCHANTS = 8;

type Phase =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "error"; message: string }
  | { status: "done"; data: InsightsResponse; label: string };

function aggregateCategories(data: InsightsResponse): { name: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const m of data.months) {
    for (const [name, amount] of Object.entries(m.byCategory ?? {})) {
      if (Number.isFinite(amount) && amount > 0) totals.set(name, (totals.get(name) ?? 0) + amount);
    }
  }
  const sorted = [...totals.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  if (sorted.length <= MAX_CATEGORIES + 1) return sorted;
  const top = sorted.slice(0, MAX_CATEGORIES);
  const rest = sorted.slice(MAX_CATEGORIES).reduce((sum, c) => sum + c.amount, 0);
  return [...top, { name: "Everything else", amount: rest }];
}

function aggregateMerchants(data: InsightsResponse): { name: string; amount: number; count: number }[] {
  const totals = new Map<string, { amount: number; count: number }>();
  for (const m of data.months) {
    for (const t of m.topMerchants ?? []) {
      const cur = totals.get(t.name) ?? { amount: 0, count: 0 };
      cur.amount += t.amount;
      cur.count += t.count;
      totals.set(t.name, cur);
    }
  }
  return [...totals.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_MERCHANTS);
}

function Results({ data, label }: { data: InsightsResponse; label: string }) {
  const monthsCount = data.months.length;
  const maxSpend = Math.max(1, ...data.months.map((m) => m.spendTotal));
  const categories = aggregateCategories(data);
  const maxCategory = Math.max(1, ...categories.map((c) => c.amount));
  const merchants = aggregateMerchants(data);
  const monthsText = `${monthsCount} month${monthsCount === 1 ? "" : "s"}`;

  return (
    <div className={styles.results}>
      <div className={styles.resultHead}>
        <p className={ui.meta}>
          {data.isSample ? <span className="tag sample">Sample data</span> : null} {label} · {data.rowsParsed}{" "}
          transactions · {data.classifier === "rules+llm" ? "Rules, plus AI for unclear merchants" : "Rule-based"}
        </p>
      </div>

      {data.isSample ? (
        <SampleBanner>This is a fictional sample statement, so the numbers below are for trying Livento only.</SampleBanner>
      ) : null}

      {data.warnings.length ? (
        <Notice label="Note">
          {data.warnings.slice(0, 4).join(" ")}
        </Notice>
      ) : null}

      {/* KPI row */}
      <div className={styles.tiles}>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>
            Likely impulse spend <span className="tag estimate">Estimate</span>
          </p>
          <p className={styles.tileValue}>{usd0(data.impulseTotal)}</p>
          <p className={ui.meta}>over {monthsText}</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>
            Monthly average <span className="tag estimate">Estimate</span>
          </p>
          <p className={styles.tileValue}>{usd0(data.monthlyImpulseAverage)}</p>
          <p className={ui.meta}>likely impulse per month</p>
        </div>
        <div className={styles.tile}>
          <p className={styles.tileLabel}>Transactions read</p>
          <p className={styles.tileValue}>{data.rowsParsed.toLocaleString("en-US")}</p>
          <p className={ui.meta}>from {label}</p>
        </div>
      </div>

      {/* What it could become */}
      <section className={ui.block} aria-labelledby="equivalents-title">
        <h2 id="equivalents-title" className={`${ui.sectionTitle} ${styles.h2}`}>
          What it could have covered
        </h2>
        {data.equivalents.length ? (
          <ul className={`${ui.plainList} ${styles.equivalents}`}>
            {data.equivalents.map((eq) => (
              <li key={eq.envelopeId ?? eq.eventName} className={styles.equivalent}>
                <p>
                  <strong>
                    {monthsText} of likely impulse spend ≈ {eq.coveredPct}%
                  </strong>{" "}
                  of your &ldquo;{eq.eventName}&rdquo; goal ({usd0(eq.target)}).
                </p>
                <EnvelopeBar
                  balance={data.impulseTotal}
                  target={eq.target}
                  label={`Likely impulse spend compared with the ${eq.eventName} goal`}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className={ui.outline}>
            <p>
              Create an envelope for an event you&rsquo;d love, and we&rsquo;ll show how much of it this spending could
              cover.
            </p>
            <p className={styles.equivalentAction}>
              <Link href="/discover" className="pill small">
                Find an event <span aria-hidden="true">↗</span>
              </Link>
            </p>
          </div>
        )}
        <p className={`${ui.meta} ${styles.neutral}`}>
          Not a judgment: everyday treats count too. This just shows the option.
        </p>
      </section>

      {/* Monthly bars: emphasis on likely impulse (ink) vs other spending (soft ink). */}
      <section className={ui.block} aria-labelledby="months-title">
        <div className={ui.sectionHead}>
          <h2 id="months-title" className={ui.sectionTitle}>
            Month by month
          </h2>
          <div className={styles.legend} aria-hidden="true">
            <span>
              <i className={styles.swatchImpulse} /> Likely impulse
            </span>
            <span>
              <i className={styles.swatchRest} /> Other spending
            </span>
          </div>
        </div>
        <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Spending by month: likely impulse and total</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className={styles.chartCol}>
                <span className="sr-only">Chart</span>
              </th>
              <th scope="col" className={styles.num}>
                Likely impulse
              </th>
              <th scope="col" className={styles.num}>
                Total spend
              </th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((m) => {
              const rest = Math.max(0, m.spendTotal - m.impulseTotal);
              const share = m.spendTotal > 0 ? Math.round((m.impulseTotal / m.spendTotal) * 100) : 0;
              return (
                <tr key={m.month}>
                  <th scope="row">{formatMonth(m.month)}</th>
                  <td className={styles.chartCol} aria-hidden="true">
                    <div className={styles.bar} style={{ width: `${Math.max(2, (m.spendTotal / maxSpend) * 100)}%` }}>
                      {m.impulseTotal > 0 ? (
                        <span className={styles.segImpulse} style={{ flexGrow: m.impulseTotal }} />
                      ) : null}
                      {rest > 0 ? <span className={styles.segRest} style={{ flexGrow: rest }} /> : null}
                    </div>
                  </td>
                  <td className={styles.num}>
                    {usd0(m.impulseTotal)}
                    <span className={styles.share}>{share}%</span>
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
        {/* Ranked bars: one series, one hue, largest first. */}
        <section aria-labelledby="categories-title">
          <h2 id="categories-title" className={`${ui.sectionTitle} ${styles.h2}`}>
            Where it went
          </h2>
          {categories.length ? (
            <ul className={`${ui.plainList} ${styles.rank}`}>
              {categories.map((c) => (
                <li key={c.name}>
                  <span className={styles.rankName}>{c.name}</span>
                  <span className={styles.rankTrack} aria-hidden="true">
                    <span className={styles.rankBar} style={{ width: `${Math.max(1.5, (c.amount / maxCategory) * 100)}%` }} />
                  </span>
                  <span className={styles.rankValue}>{usd0(c.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={ui.status}>No spending categories found.</p>
          )}
        </section>

        <section aria-labelledby="merchants-title">
          <h2 id="merchants-title" className={`${ui.sectionTitle} ${styles.h2}`}>
            Top merchants
          </h2>
          {merchants.length ? (
            <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.merchants}`}>
              <caption className="sr-only">Top merchants by total spent</caption>
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

      <p className={`${ui.meta} ${styles.method}`}>
        &ldquo;Likely impulse&rdquo; is a rough guess from merchant rules: food delivery, small online orders under $50,
        app stores and in-app purchases, convenience stores and late-night buys.
        {data.classifier === "rules+llm" ? " Merchants the rules didn't recognize were sorted by AI." : ""}
      </p>
    </div>
  );
}

function Insights({ state }: { state: AppState }) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const goals = state.envelopes.map((e) => ({ envelopeId: e.id, eventName: e.eventName, target: e.target }));

  async function run(req: InsightsRequest, label: string) {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setPhase({ status: "loading", label });
    try {
      const data = await insights(req, ctrl.signal);
      if (!ctrl.signal.aborted) setPhase({ status: "done", data, label });
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
    void run({ csv: text, goals }, file.name);
  }

  const loading = phase.status === "loading";

  return (
    <>
      <div className={`${ui.panel} ${styles.upload}`}>
        <div className={styles.uploadText}>
          <h2 className={ui.smallTitle}>Add a bank statement</h2>
          <p className={ui.meta}>
            Export a CSV from your bank&rsquo;s website (most offer &ldquo;Download transactions&rdquo;). Up to 1 MB. We never ask
            for bank logins.
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
          <button
            type="button"
            className="pill alt"
            disabled={loading}
            onClick={() => void run({ sample: true, goals }, "Sample statement")}
          >
            Use sample statement <span aria-hidden="true">●</span>
          </button>
        </div>
        <p className={styles.privacy}>
          <strong>Processed in memory, never stored.</strong> The file is read in your browser and sent once for
          analysis; nothing is saved on our side or in this browser.
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
        {phase.status === "done" ? <Results data={phase.data} label={phase.label} /> : null}
      </div>
    </>
  );
}

/** /insights — impulse-spending insights from a CSV or the labeled sample statement (Premium). */
export function InsightsView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading insights…" />;
  if (!state.profile) {
    return <NoProfile text="Set up a quick profile (or use the sample) first, then see where impulse money goes and what it could cover." />;
  }
  const premium = hasPremium(state);
  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">04 / Insights</p>
        <h1 className="title">Where impulse money goes</h1>
        <p className="lead muted">
          Upload a bank CSV or try the sample statement. We group your spending, flag likely impulse buys and show what
          they could add up to.
        </p>
      </header>
      {premium ? (
        <Insights state={state} />
      ) : (
        <PremiumGate
          title="Insights are Premium"
          description="Upload a bank CSV (or use the sample) to see likely impulse spending by month and what it could cover from your goals. Processed in memory, never stored."
        />
      )}
    </div>
  );
}
