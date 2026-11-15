"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { sendTelegramPicks, watchTelegramLink } from "@/components/app/TelegramLinkCatcher";
import ui from "@/components/app/ui.module.css";
import { errorMessage, getHealth, subscribeAlerts } from "@/lib/client-api";
import { useAppState } from "@/lib/storage";
import type { IntegrationStatus, Profile } from "@/lib/types";
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

/**
 * FR-5: subscribe to new matching events by email or Telegram. Only channels that are
 * actually connected on this deployment are shown; with none connected the box is hidden,
 * so there is never a button that leads nowhere. Once Telegram is linked to this browser
 * (components/app/TelegramLinkCatcher) the Telegram button becomes "Send my picks now".
 */
export function AlertsBox({ profile }: { profile: Profile }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<null | "email" | "telegram" | "picks">(null);
  const [result, setResult] = useState<Result | null>(null);
  // email needs storage; Telegram answers with picks right away and adds daily alerts when storage exists
  const [channels, setChannels] = useState<{ email: boolean; telegram: boolean; daily: boolean } | null>(null);
  const linked = useAppState().telegram;

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((health) => {
        const live = (key: IntegrationStatus["key"]) =>
          health.integrations.some((i) => i.key === key && i.state === "live");
        const storage = live("storage");
        setChannels({ email: storage && live("email"), telegram: live("telegram"), daily: storage });
      })
      .catch(() => setChannels({ email: false, telegram: false, daily: false }));
    return () => controller.abort();
  }, []);

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
        if (telegramUrl && res.linkId) watchTelegramLink(res.linkId);
        const finish = res.linkId
          ? "This box updates once you tap Start."
          : "Then tap “✓ Show on Livento” in the chat to finish.";
        setResult(
          telegramUrl
            ? {
                tone: "ok",
                text: `${res.message || "One more step: open Telegram and press Start to confirm."} ${finish}`,
                telegramUrl,
              }
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

  async function sendPicksNow() {
    if (!linked || pending) return;
    setPending("picks");
    setResult(null);
    setResult(await sendTelegramPicks(linked, profile));
    setPending(null);
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (channels?.email) void subscribe("email");
  };

  if (!channels || (!channels.email && !channels.telegram)) return null;
  const telegramOnly = channels.telegram && !channels.email;

  return (
    <section className={`${ui.panel} ${styles.alerts}`} aria-labelledby={`${id}-title`}>
      <div className={styles.alertsIntro}>
        <h2 id={`${id}-title`} className={ui.sectionTitle}>
          {linked && telegramOnly
            ? "Connected to Telegram ✓"
            : channels.daily
              ? "Get alerts for new matches"
              : "Get your picks in Telegram"}
        </h2>
        <p className={ui.meta}>
          {linked && telegramOnly
            ? `Your top picks for ${profile.city} go straight to your Telegram chat${
                channels.daily ? ", and new matches arrive there once a day" : ""
              }.`
            : channels.daily
              ? `Free. We check daily for new events that match your interests in ${profile.city}.`
              : `Free. Tap Start in our bot and it sends your top picks for ${profile.city} right away.`}
          {channels.email ? " Your email is used only for these alerts." : ""}
        </p>
      </div>
      <form className={styles.alertsForm} onSubmit={onSubmit} noValidate>
        {channels.email ? (
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
        ) : null}
        <div className={ui.actions}>
          {channels.email ? (
            <button type="submit" className="pill" disabled={pending !== null}>
              {pending === "email" ? "Subscribing…" : "Email me matches"}
            </button>
          ) : null}
          {channels.telegram && linked ? (
            <>
              {telegramOnly ? null : <span className={styles.okText}>Connected to Telegram ✓</span>}
              <button
                type="button"
                className={channels.email ? "pill alt" : "pill"}
                disabled={pending !== null}
                onClick={() => void sendPicksNow()}
              >
                {pending === "picks" ? "Sending…" : "Send my picks now"}
              </button>
            </>
          ) : channels.telegram ? (
            <button
              type="button"
              className={channels.email ? "pill alt" : "pill"}
              disabled={pending !== null}
              onClick={() => void subscribe("telegram")}
            >
              {pending === "telegram" ? "Connecting…" : "Alerts on Telegram"}
            </button>
          ) : null}
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
