"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { eventHref } from "@/components/app/EventCard";
import { categoryLabel, eventPlace, formatDate, formatMonth, formatTime, localDate, usd } from "@/components/app/format";
import { NoProfile, PageSkeleton } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { errorMessage, getHealth, subscribeAlerts } from "@/lib/client-api";
import { isoDatePart, todayISO } from "@/lib/dates";
import { envelopeBalance, socialOf, totalSetAside, useAppState, useHydrated, useProfileMedia } from "@/lib/storage";
import type { AppState, Profile } from "@/lib/types";
import { Avatar } from "./Avatar";
import { EditProfileDialog } from "./EditProfileDialog";
import { QuoteCard } from "./QuoteCard";
import { coverSrc, safeTelegramUrl } from "./social";
import styles from "./profile.module.css";

const MAX_PLANS = 8;
const MAX_INTERESTS_SHOWN = 4;

interface Plan {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD
  time?: string;
  place: string;
  saving: boolean; // the event has an envelope
}

/** Liked events and events with an envelope, dated today or later, soonest first. */
function upcomingPlans(state: AppState, profile: Profile, today: string): Plan[] {
  const saving = new Set(state.envelopes.map((e) => e.eventId));
  const plans = new Map<string, Plan>();
  const add = (id: string, fallbackName?: string, fallbackDate?: string) => {
    if (plans.has(id)) return;
    const event = state.savedEvents[id];
    const date = isoDatePart(event?.date ?? fallbackDate);
    const name = event?.name ?? fallbackName;
    if (!date || date < today || !name) return;
    const place = event ? [event.venue, eventPlace(event)].filter(Boolean).join(", ") : "";
    plans.set(id, { id, name, date, time: event?.time, place, saving: saving.has(id) });
  };
  for (const id of profile.liked) add(id);
  for (const env of state.envelopes) add(env.eventId, env.eventName, env.eventDate);
  return [...plans.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.name.localeCompare(b.name),
  );
}

function interestsText(profile: Profile): string {
  const labels = profile.interests.map(categoryLabel);
  if (labels.length <= MAX_INTERESTS_SHOWN) return labels.join(", ");
  return `${labels.slice(0, MAX_INTERESTS_SHOWN).join(", ")} +${labels.length - MAX_INTERESTS_SHOWN} more`;
}

type TelegramResult = { tone: "ok" | "info" | "error"; text: string; url?: string };

/** "Connect Telegram": the same flow as Discover's alerts box, offered only when the bot is live. */
function useTelegram(profile: Profile) {
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TelegramResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal)
      .then((health) => setLive(health.integrations.some((i) => i.key === "telegram" && i.state === "live")))
      .catch(() => setLive(false));
    return () => controller.abort();
  }, []);

  async function connect() {
    if (pending) return;
    setPending(true);
    setResult(null);
    try {
      const res = await subscribeAlerts({
        channel: "telegram",
        interests: profile.interests,
        favourites: profile.favourites,
        city: profile.city,
        stateCode: profile.stateCode,
      });
      const url = res.ok ? safeTelegramUrl(res.telegramStartUrl) : undefined;
      if (url) {
        const win = window.open(url, "_blank");
        if (win) win.opener = null;
        setResult({ tone: "ok", text: "One more step: press Start in Telegram to connect.", url });
      } else {
        setResult({ tone: "info", text: res.message || "The Telegram bot isn't set up on this deployment yet." });
      }
    } catch (err) {
      setResult({ tone: "error", text: errorMessage(err) });
    } finally {
      setPending(false);
    }
  }

  return { live, pending, result, connect };
}

function ProfileScreen({ state, profile }: { state: AppState; profile: Profile }) {
  const id = useId();
  const notify = useToast();
  const media = useProfileMedia();
  const social = socialOf(state);
  const telegram = useTelegram(profile);

  const name = social.displayName;
  const place = [profile.city, profile.stateCode].filter(Boolean).join(", ");
  const interests = interestsText(profile);
  const since = localDate(profile.createdAt) ? formatMonth(profile.createdAt.slice(0, 7)) : "";
  const goals = [...state.envelopes].sort((a, b) => a.deadline.localeCompare(b.deadline));
  const savedCount = new Set([...profile.liked, ...state.envelopes.map((e) => e.eventId)]).size;
  const plans = upcomingPlans(state, profile, todayISO());

  async function share() {
    const url = `${window.location.origin}/`;
    const text = "I'm saving for the live events I love with Livento.";
    const data = { title: "Livento", text, url };
    if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return; // the user closed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      notify("Link copied", "Paste it anywhere to share Livento.");
    } catch {
      notify("Couldn't copy the link", url);
    }
  }

  return (
    <div className={`wrap ${styles.page}`}>
      <section className={styles.hero} aria-labelledby={`${id}-name`}>
        <div className={styles.cover}>
          {/* Decorative cover: a local preset or the user's own photo. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverSrc(social.cover, profile, media)} alt="" className={styles.coverImg} decoding="async" />
        </div>
        <div className={styles.identity}>
          <Avatar src={media.avatar} name={name} alt="Your profile photo" className={styles.avatar} />
          <div className={styles.headRow}>
            <div className={styles.who}>
              <h1 id={`${id}-name`} className={name ? `display ${styles.name}` : "sr-only"}>
                {name || "Your profile"}
              </h1>
              <p className={styles.meta}>
                <span>{place}</span>
                {interests ? <span className={styles.dot}>{interests}</span> : null}
                {profile.isSample ? <span className="tag sample">Sample profile</span> : null}
              </p>
            </div>
            <div className={ui.actions}>
              <EditProfileDialog profile={profile} social={social} media={media} />
              <button type="button" className="pill alt" onClick={() => void share()}>
                Share
              </button>
            </div>
          </div>
          {social.bio ? <p className={styles.bio}>{social.bio}</p> : null}
          <ul className={styles.stats} aria-label="Your numbers">
            <li>
              <strong>{goals.length}</strong> {goals.length === 1 ? "goal" : "goals"}
            </li>
            <li>
              <strong>{usd(totalSetAside(state.envelopes))}</strong> in wallet (test mode)
            </li>
            <li>
              <strong>{savedCount}</strong> saved
            </li>
            {since ? <li>since {since}</li> : null}
          </ul>
        </div>
      </section>

      <QuoteCard state={state} profile={profile} social={social} />

      <div className={styles.columns}>
        <section aria-labelledby={`${id}-goals`}>
          <h2 id={`${id}-goals`} className={`kicker ${styles.label}`}>
            02 / Saving for
          </h2>
          <p className={`${ui.meta} ${styles.sectionNote}`}>Livento wallet balances. Stripe test mode: no real money moves.</p>
          {goals.length ? (
            <ul className={styles.list}>
              {goals.map((env) => (
                <li key={env.id} className={styles.goal}>
                  <Link href="/envelopes" className={styles.goalName}>
                    {env.eventName}
                    <span className="sr-only"> (open your wallet)</span>
                  </Link>
                  <p className={ui.meta}>
                    {env.eventDate ? `Event ${formatDate(env.eventDate, "medium")} · ` : ""}
                    Needed by {formatDate(env.deadline, "medium")}
                  </p>
                  <EnvelopeBar balance={envelopeBalance(env)} target={env.target} label={`Saved for ${env.eventName}`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptyText}>
              No goals yet. Open an event in{" "}
              <Link href="/discover" className={ui.inlineLink}>
                Discover
              </Link>{" "}
              and create an envelope from its cost plan.
            </p>
          )}
        </section>

        <section aria-labelledby={`${id}-plans`}>
          <h2 id={`${id}-plans`} className={`kicker ${styles.label}`}>
            03 / Upcoming plans
          </h2>
          <p className={`${ui.meta} ${styles.sectionNote}`}>Events you liked or are saving for, soonest first.</p>
          {plans.length ? (
            <>
              <ul className={styles.list}>
                {plans.slice(0, MAX_PLANS).map((plan) => {
                  const day = localDate(plan.date);
                  return (
                    <li key={plan.id}>
                      <Link href={eventHref(plan.id)} className={styles.plan}>
                        <span className={styles.planDate} aria-hidden="true">
                          <span>{day?.toLocaleDateString("en-US", { month: "short" })}</span>
                          <strong>{day?.getDate()}</strong>
                        </span>
                        <span className={styles.planText}>
                          <span className={styles.planName}>{plan.name}</span>
                          <span className={ui.meta}>
                            {formatDate(plan.date)}
                            {plan.time ? ` · ${formatTime(plan.time)}` : ""}
                            {plan.place ? ` · ${plan.place}` : ""}
                          </span>
                        </span>
                        {plan.saving ? <span className="tag">Saving</span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {plans.length > MAX_PLANS ? (
                <p className={`${ui.meta} ${styles.sectionNote}`}>
                  Showing the next {MAX_PLANS} of {plans.length}.
                </p>
              ) : null}
            </>
          ) : (
            <p className={styles.emptyText}>
              Nothing dated yet. Like events in{" "}
              <Link href="/discover" className={ui.inlineLink}>
                Discover
              </Link>{" "}
              and the upcoming ones show up here.
            </p>
          )}
        </section>
      </div>

      <div className={styles.more}>
        <div className={ui.actions}>
          <Link href="/onboarding" className="pill alt">
            Edit preferences <span aria-hidden="true">●</span>
          </Link>
          {telegram.live ? (
            <button
              type="button"
              className="pill alt"
              aria-disabled={telegram.pending || undefined}
              onClick={() => void telegram.connect()}
            >
              {telegram.pending ? "Connecting…" : "Connect Telegram"}
            </button>
          ) : null}
        </div>
        <p className={ui.meta}>Preferences are your city, interests, budget and travel. Your photo, bio and quote stay as they are.</p>
        <div aria-live="polite">
          {telegram.result ? (
            <p className={telegram.result.tone === "error" ? ui.error : ui.status}>
              {telegram.result.text}{" "}
              {telegram.result.url ? (
                <a href={telegram.result.url} target="_blank" rel="noopener noreferrer" className={ui.inlineLink}>
                  Open Telegram<span className="sr-only"> (opens in a new tab)</span> ↗
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** /profile — photo, cover, name, bio, a quote, goals and upcoming plans. Saved only in this browser. */
export function ProfileView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading your profile…" />;
  if (!state.profile) {
    return (
      <NoProfile text="Set up a quick profile (or use the sample) first. Then add a photo, a cover, a short bio and a quote that keeps you going. It's all saved only in this browser." />
    );
  }
  return <ProfileScreen state={state} profile={state.profile} />;
}
