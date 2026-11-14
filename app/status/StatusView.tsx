"use client";

import { useEffect, useState } from "react";
import { usd0 } from "@/components/app/format";
import { Notice } from "@/components/app/States";
import ui from "@/components/app/ui.module.css";
import sampleProfileJson from "@/data/sample-profile.json";
import {
  errorMessage,
  eventsQueryFromProfile,
  getEvents,
  getHealth,
  isAbortError,
  plan,
  recommend,
} from "@/lib/client-api";
import { sanitizeProfile, useAppState, useHydrated } from "@/lib/storage";
import type { HealthResponse, IntegrationState, Profile } from "@/lib/types";
import styles from "./status.module.css";

const STATE_LABEL: Record<IntegrationState, string> = {
  live: "Live",
  sample: "Sample data",
  off: "Off",
  test: "Test mode",
  demo: "Demo",
};

const STATE_CLASS: Record<IntegrationState, string> = {
  live: `tag ${styles.live}`,
  sample: "tag sample",
  off: "tag",
  test: "tag estimate",
  demo: "tag sample",
};

interface CheckRow {
  step: string;
  ok: boolean;
  result: string;
  ms: number;
}

const since = (t: number) => Math.round(performance.now() - t);

export function StatusView() {
  const state = useAppState();
  const hydrated = useHydrated();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [running, setRunning] = useState(false);
  const [ranWith, setRanWith] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then(setHealth)
      .catch((err) => {
        if (!isAbortError(err)) setHealthError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  // End-to-end check through the same public APIs the app uses.
  async function runCheck() {
    const own = hydrated ? state.profile : undefined;
    const profile: Profile | undefined = own ?? sanitizeProfile(sampleProfileJson);
    if (!profile) return;
    setRunning(true);
    setRows([]);
    setRanWith(own ? `your profile (${profile.city})` : `the sample profile (${profile.city})`);
    const done: CheckRow[] = [];
    const push = (row: CheckRow) => {
      done.push(row);
      setRows([...done]);
    };
    try {
      let t = performance.now();
      const events = await getEvents(eventsQueryFromProfile(profile));
      const source =
        events.source === "ticketmaster"
          ? "Ticketmaster (live)"
          : events.source === "mixed"
            ? "live data + curated/sample"
            : "sample data";
      push({
        step: "Events",
        ok: events.events.length > 0,
        result: `${events.events.length} events near ${profile.city} · source: ${source}`,
        ms: since(t),
      });
      if (!events.events.length) return;

      t = performance.now();
      const picks = await recommend({ profile, events: events.events.slice(0, 300) });
      push({
        step: "Recommendations",
        ok: picks.items.length > 0,
        result: `${picks.items.length} picks · ranked by ${picks.ranker === "llm" ? "AI + rules" : "rules"}`,
        ms: since(t),
      });

      const top = events.events.find((e) => e.id === picks.items[0]?.eventId) ?? events.events[0];
      t = performance.now();
      const cost = await plan({ event: top, profile, envelopeBalance: 0 });
      push({
        step: "Cost plan",
        ok: cost.total >= 0 && cost.weeks >= 1,
        result: `${top.name}: ${usd0(cost.total)} total · ${usd0(cost.weekly)}/week for ${cost.weeks} week${cost.weeks === 1 ? "" : "s"}`,
        ms: since(t),
      });
    } catch (err) {
      if (!isAbortError(err)) push({ step: "Check stopped", ok: false, result: errorMessage(err), ms: 0 });
    } finally {
      setRunning(false);
    }
  }

  const dep = health?.deployment;

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">Status</p>
        <h1 className="title">Is Livento working right now?</h1>
        <p className="lead muted">
          What&apos;s connected on this deployment, and a one-click check that runs the real APIs. Keys are never
          shown, only whether each one is set.
        </p>
      </header>

      {healthError ? <Notice tone="error">{healthError}</Notice> : null}

      <section aria-labelledby="integrations-title">
        <h2 id="integrations-title" className={ui.sectionTitle}>
          Integrations
        </h2>
        <ul className={styles.list} aria-busy={!health}>
          {(health?.integrations ?? []).map((item) => (
            <li key={item.key} className={styles.row}>
              <div>
                <p className={styles.name}>{item.name}</p>
                <p className={styles.detail}>{item.detail}</p>
              </div>
              <span className={STATE_CLASS[item.state]}>{STATE_LABEL[item.state]}</span>
            </li>
          ))}
          {!health && !healthError ? <li className={styles.loading}>Checking configuration…</li> : null}
        </ul>
        <p className={styles.note}>
          &ldquo;Sample data&rdquo; and &ldquo;Off&rdquo; are safe fallbacks: every screen keeps working with labeled
          sample data or rule-based text.
        </p>
      </section>

      <section className={ui.blockRule} aria-labelledby="check-title">
        <div className={ui.headRow}>
          <div>
            <h2 id="check-title" className={ui.sectionTitle}>
              End-to-end check
            </h2>
            <p className="muted">Events → recommendations → cost plan, through the same public APIs the app uses.</p>
          </div>
          <button type="button" className="pill" onClick={runCheck} disabled={running}>
            {running ? "Running…" : "Run check"} <span aria-hidden="true">↗</span>
          </button>
        </div>
        <div aria-live="polite">
          {rows.length ? (
            <>
              <p className={styles.ranWith}>Ran with {ranWith}.</p>
              <ol className={styles.checks}>
                {rows.map((row) => (
                  <li key={row.step} className={styles.check}>
                    <span className={row.ok ? styles.ok : styles.fail}>{row.ok ? "Pass" : "Fail"}</span>
                    <span className={styles.step}>{row.step}</span>
                    <span className={styles.result}>{row.result}</span>
                    <span className={styles.ms}>{row.ms ? `${row.ms} ms` : ""}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      </section>

      <section className={ui.blockRule} aria-labelledby="deploy-title">
        <h2 id="deploy-title" className={ui.sectionTitle}>
          Deployment
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>Environment</dt>
            <dd>{dep?.environment ?? "…"}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>
              {dep?.commit ? (
                dep.commitUrl ? (
                  <a href={dep.commitUrl} target="_blank" rel="noreferrer">
                    {dep.commit}
                  </a>
                ) : (
                  dep.commit
                )
              ) : dep?.environment === "development" ? (
                "Local development build"
              ) : (
                "Deployed from the command line"
              )}
              {dep?.commitMessage ? <span className={styles.message}> · {dep.commitMessage}</span> : null}
            </dd>
          </div>
          {dep?.branch ? (
            <div>
              <dt>Branch</dt>
              <dd>{dep.branch}</dd>
            </div>
          ) : null}
          {dep?.region ? (
            <div>
              <dt>Server region</dt>
              <dd>{dep.region}</dd>
            </div>
          ) : null}
          <div>
            <dt>Checked</dt>
            <dd>{health ? new Date(health.checkedAt).toLocaleString() : "…"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
