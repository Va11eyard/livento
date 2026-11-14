"use client";

import { useId, useState, type FormEvent } from "react";
import ui from "@/components/app/ui.module.css";
import { errorMessage, subscribeAlerts } from "@/lib/client-api";
import type { Profile } from "@/lib/types";
import styles from "./discover.module.css";

type Result = { tone: "ok" | "info" | "error"; text: string; telegramUrl?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Only https://t.me/... links are rendered. */
function safeTelegramUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "t.me" || u.hostname === "telegram.me") ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** FR-5: subscribe to new matching events by email or Telegram. Shows the API's message as-is when alerts aren't configured. */
export function AlertsBox({ profile }: { profile: Profile }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<null | "email" | "telegram">(null);
  const [result, setResult] = useState<Result | null>(null);

  async function subscribe(channel: "email" | "telegram") {
    if (channel === "email" && !EMAIL_RE.test(email.trim())) {
      setResult({ tone: "error", text: "Enter a valid email address, like you@example.com." });
      return;
    }
    setPending(channel);
    setResult(null);
    try {
      const res = await subscribeAlerts({
        channel,
        address: channel === "email" ? email.trim() : undefined,
        interests: profile.interests,
        favourites: profile.favourites,
        city: profile.city,
        stateCode: profile.stateCode,
      });
      if (!res.ok) {
        setResult({ tone: "info", text: res.message || "Alerts aren't available on this deployment yet." });
      } else if (channel === "telegram") {
        const telegramUrl = safeTelegramUrl(res.telegramStartUrl);
        setResult(
          telegramUrl
            ? { tone: "ok", text: res.message || "One more step: open Telegram and press Start to confirm.", telegramUrl }
            : { tone: "info", text: res.message || "The Telegram bot isn't set up on this deployment yet." },
        );
      } else {
        setResult({ tone: "ok", text: res.message || "You're subscribed. We'll email you new events that match." });
      }
    } catch (err) {
      setResult({ tone: "error", text: errorMessage(err) });
    } finally {
      setPending(null);
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void subscribe("email");
  };

  return (
    <section className={`${ui.panel} ${styles.alerts}`} aria-labelledby={`${id}-title`}>
      <div className={styles.alertsIntro}>
        <h2 id={`${id}-title`} className={ui.sectionTitle}>
          Get alerts for new matches
        </h2>
        <p className={ui.meta}>
          Free. We check daily for new events that match your interests in {profile.city}. Your email is used only for
          these alerts.
        </p>
      </div>
      <form className={styles.alertsForm} onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className={ui.actions}>
          <button type="submit" className="pill" disabled={pending !== null}>
            {pending === "email" ? "Subscribing…" : "Email me matches"}
          </button>
          <button
            type="button"
            className="pill alt"
            disabled={pending !== null}
            onClick={() => void subscribe("telegram")}
          >
            {pending === "telegram" ? "Connecting…" : "Alerts on Telegram"}
          </button>
        </div>
      </form>
      <div aria-live="polite" className={styles.alertsResult}>
        {result ? (
          <p className={result.tone === "error" ? ui.error : result.tone === "ok" ? styles.okText : ui.status}>
            {result.text}{" "}
            {result.telegramUrl ? (
              <a href={result.telegramUrl} target="_blank" rel="noopener noreferrer" className={ui.inlineLink}>
                Open Telegram<span className="sr-only"> (opens in a new tab)</span> ↗
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
