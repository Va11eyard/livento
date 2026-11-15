"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Comparator } from "@/components/app/Comparator";
import { CostTable, deadlineText } from "@/components/app/CostTable";
import { EnvelopeBar } from "@/components/app/EnvelopeBar";
import { distanceText } from "@/components/app/EventCard";
import { EventImage } from "@/components/app/EventImage";
import { EventLookup } from "@/components/app/EventLookup";
import {
  categoryLabel,
  eventPlace,
  eventWhen,
  formatDateTime,
  isFuture,
  priceInfo,
  roadmapHref,
  safeDecode,
  safeExternalUrl,
  usd0,
  weeksLabel,
} from "@/components/app/format";
import { PremiumGate } from "@/components/app/PremiumGate";
import { NoProfile, PageSkeleton, SampleBanner } from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { logInteraction } from "@/lib/client-api";
import { compareSpendVsSave } from "@/lib/compare";
import { buildPlan, eventDistanceMiles } from "@/lib/cost";
import {
  addEnvelope,
  envelopeBalance,
  envelopeForEvent,
  getAppState,
  hasPremium,
  likeEvent,
  saveEvent,
  totalSetAside,
  unlikeEvent,
  useAppState,
  useHydrated,
  weeklyContribution,
} from "@/lib/storage";
import type { AppState, ComparatorEvent, CostOverrides, Envelope, LiventoEvent, PlanResult, Profile } from "@/lib/types";
import styles from "./event.module.css";

function byDate(a: LiventoEvent, b: LiventoEvent): number {
  if (a.date && b.date) return a.date.localeCompare(b.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.name.localeCompare(b.name);
}

function comparatorSide(name: string, plan: PlanResult): ComparatorEvent {
  return { name, cost: plan.total, deadline: plan.deadlineKind === "none" ? undefined : plan.deadline };
}

// ---------------------------------------------------------------------------
// Premium: savings plan + envelope (FR-7, FR-8)
// ---------------------------------------------------------------------------

function SavingsPlan({
  event,
  plan,
  envelope,
  balance,
}: {
  event: LiventoEvent;
  plan: PlanResult;
  envelope?: Envelope;
  balance: number;
}) {
  const notify = useToast();
  const save = () => {
    addEnvelope({
      eventId: event.id,
      eventName: event.name,
      eventDate: event.date,
      target: plan.total,
      deadline: plan.deadline,
    });
    saveEvent(event);
    logInteraction({ anonId: getAppState().anonId, eventId: event.id, action: "save" });
    notify(
      envelope ? "Envelope updated" : "Envelope created",
      envelope ? `New target: ${usd0(plan.total)}.` : "Add money to it by card in your wallet.",
    );
  };

  return (
    <div className={`${ui.panel} ${styles.planCard}`}>
      <p className={styles.panelKicker}>Weekly savings plan</p>
      {plan.weekly > 0 ? (
        <p className={ui.figure}>
          {usd0(plan.weekly)}
          <span className={styles.per}>/week</span>
        </p>
      ) : (
        <p className={ui.figure}>Covered</p>
      )}
      <p>
        {plan.weekly > 0 ? (
          <>
            for {weeksLabel(plan.weeks)} to have {usd0(plan.total)} by {deadlineText(plan)}.
          </>
        ) : (
          <>What you&rsquo;ve set aside covers the {usd0(plan.total)} estimate.</>
        )}{" "}
        <span className="tag estimate">Estimate</span>
      </p>
      {envelope ? (
        <>
          <EnvelopeBar balance={balance} target={envelope.target} label={`In your wallet for ${event.name}`} />
          <div className={ui.actions}>
            <Link href="/envelopes" className="pill small">
              Add money in your wallet <span aria-hidden="true">↗</span>
            </Link>
            {Math.round(envelope.target) !== Math.round(plan.total) ? (
              <button type="button" className="pill small alt" onClick={save}>
                Update target to {usd0(plan.total)}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className={ui.actions}>
          <button type="button" className="pill" onClick={save}>
            Create envelope for {usd0(plan.total)} <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}
      <p className="help">The money goes into your Livento wallet. Stripe test mode: no real money moves.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premium: spend-vs-save comparator (FR-9)
// ---------------------------------------------------------------------------

function CompareSection({
  event,
  plan,
  profile,
  state,
}: {
  event: LiventoEvent;
  plan: PlanResult;
  profile: Profile;
  state: AppState;
}) {
  const id = useId();
  const [otherId, setOtherId] = useState("");
  const liked = new Set(profile.liked);
  const options = Object.values(state.savedEvents)
    .filter((e) => e.id !== event.id)
    .sort((a, b) => Number(liked.has(b.id)) - Number(liked.has(a.id)) || byDate(a, b));
  const other = options.find((o) => o.id === otherId) ?? options[0];

  if (!other) {
    return (
      <div className={ui.outline}>
        <h3 className={ui.smallTitle}>Spend now or save for something bigger?</h3>
        <p className={styles.compareEmpty}>
          Like or open another event in Discover, then come back to compare the two side by side.
        </p>
        <Link href="/discover" className="pill small alt">
          Find another event <span aria-hidden="true">↗</span>
        </Link>
      </div>
    );
  }

  const otherEnvelope = envelopeForEvent(state, other.id);
  const otherPlan = buildPlan(other, profile, otherEnvelope ? envelopeBalance(otherEnvelope) : 0);
  const mine = comparatorSide(event.name, plan);
  const theirs = comparatorSide(other.name, otherPlan);
  // A = the cheaper (or, on a tie, sooner) one you could go to now; B = the bigger one.
  const mineFirst =
    mine.cost < theirs.cost || (mine.cost === theirs.cost && (mine.deadline ?? "9999") <= (theirs.deadline ?? "9999"));
  const [a, b] = mineFirst ? [mine, theirs] : [theirs, mine];
  const balance = totalSetAside(state.envelopes);
  const weekly = weeklyContribution(profile);
  const result = compareSpendVsSave({ balance, weeklyContribution: weekly, eventA: a, eventB: b });

  return (
    <div className={styles.compare}>
      <div className={styles.compareHead}>
        <h3 className={ui.smallTitle}>Spend now or save for the bigger one?</h3>
        <div className={`field ${styles.compareSelect}`}>
          <label htmlFor={`${id}-other`}>Compare with</label>
          <select id={`${id}-other`} value={other.id} onChange={(e) => setOtherId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {liked.has(o.id) ? " (liked)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div aria-live="polite">
        <Comparator a={a} b={b} result={result} balance={balance} weekly={weekly} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function EventDetail({ event, profile, state }: { event: LiventoEvent; profile: Profile; state: AppState }) {
  const notify = useToast();
  const [overrides, setOverrides] = useState<CostOverrides>({});
  const envelope = envelopeForEvent(state, event.id);
  const balance = envelope ? envelopeBalance(envelope) : 0;
  const plan = buildPlan(event, profile, balance, overrides);
  const premium = hasPremium(state);
  const liked = profile.liked.includes(event.id);
  const distance = distanceText(eventDistanceMiles(event, profile));
  const price = priceInfo(event);
  const ticketUrl = event.source === "sample" ? undefined : safeExternalUrl(event.url);
  const webHost = event.source === "web" && ticketUrl ? new URL(ticketUrl).hostname.replace(/^www\./, "") : undefined;
  const where = [event.venue, eventPlace(event)].filter(Boolean).join(", ");

  const toggleLike = () => {
    if (liked) {
      unlikeEvent(event.id);
      return;
    }
    likeEvent(event);
    logInteraction({ anonId: getAppState().anonId, eventId: event.id, action: "like" });
    notify("Saved to your likes");
  };

  return (
    <div className={`wrap ${ui.page}`}>
      <p className={styles.crumbs}>
        <Link href="/discover" className={ui.inlineLink}>
          <span aria-hidden="true">←</span> Discover
        </Link>
      </p>

      <header className={styles.hero}>
        <div className={styles.media}>
          <EventImage event={event} eager />
        </div>
        <div className={styles.intro}>
          <p className={`kicker ${styles.kicker}`}>
            {categoryLabel(event.category)}
            {event.genre &&
            event.genre.toLowerCase() !== "undefined" &&
            event.genre.toLowerCase() !== categoryLabel(event.category).toLowerCase()
              ? ` · ${event.genre}`
              : ""}
          </p>
          <h1 className="title">{event.name}</h1>
          <dl className={styles.facts}>
            <div>
              <dt>When</dt>
              <dd>{eventWhen(event)}</dd>
            </div>
            {where ? (
              <div>
                <dt>Where</dt>
                <dd>{where}</dd>
              </div>
            ) : null}
            {distance ? (
              <div>
                <dt>Distance</dt>
                <dd>
                  {distance} from {profile.city}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tickets</dt>
              <dd className={styles.priceRow}>
                {event.source === "web" && !price.known ? "Price not listed" : price.text}
                {price.estimate ? <span className="tag estimate">Estimate</span> : null}
                {event.source === "ticketmaster" && price.known ? (
                  <span className={ui.meta}>face value, fees not included</span>
                ) : null}
              </dd>
            </div>
          </dl>
          <div className={styles.tagRow}>
            {event.source === "sample" ? <span className="tag sample">Sample data</span> : null}
            {event.source === "curated" ? <span className="tag">Curated</span> : null}
            {event.source === "thesportsdb" ? <span className="tag">TheSportsDB</span> : null}
            {event.source === "web" ? <span className="tag">Web</span> : null}
            {event.priceNote ? <span className={ui.meta}>{event.priceNote}</span> : null}
          </div>
          <div className={ui.actions}>
            {ticketUrl ? (
              <a className="pill" href={ticketUrl} target="_blank" rel="noopener noreferrer">
                {event.source === "ticketmaster"
                  ? "Tickets on Ticketmaster"
                  : event.source === "web"
                    ? "Official page"
                    : "Official site"}
                <span className="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <p className={styles.noTickets}>
                {event.source === "sample" ? "Sample event: no tickets to buy." : "No ticket link available."}
              </p>
            )}
            <button type="button" className={`pill ${liked ? "" : "alt"}`} aria-pressed={liked} onClick={toggleLike}>
              {liked ? "Liked ✓" : "Like"}
            </button>
          </div>
          {event.source === "ticketmaster" ? (
            <p className={styles.attribution}>{event.attribution || "Event data: Ticketmaster"}</p>
          ) : null}
          {event.source === "thesportsdb" ? (
            <p className={styles.attribution}>
              Event data:{" "}
              <a href="https://www.thesportsdb.com" target="_blank" rel="noopener noreferrer">
                TheSportsDB<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          ) : null}
          {webHost ? (
            <p className={styles.attribution}>
              Found by AI web search ·{" "}
              <a href={`https://${webHost}`} target="_blank" rel="noopener noreferrer">
                {webHost}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              . Check dates and prices on the official page.
            </p>
          ) : null}
        </div>
      </header>

      {event.source === "sample" ? (
        <div className={styles.banner}>
          <SampleBanner>
            This is a fictional sample event, so its prices and dates are for trying Livento only.
          </SampleBanner>
        </div>
      ) : null}

      <section className={ui.blockRule} aria-labelledby="dates-title">
        <h2 id="dates-title" className={`${ui.sectionTitle} ${styles.sectionTitle}`}>
          Key dates
        </h2>
        <dl className={styles.dates}>
          <div>
            <dt>Event</dt>
            <dd>{event.date ? eventWhen(event) : "Flexible: check the official site for dates"}</dd>
          </div>
          <div>
            <dt>Public on-sale</dt>
            <dd>
              {event.onSaleStart
                ? `${formatDateTime(event.onSaleStart)}${isFuture(event.onSaleStart) ? "" : " (on sale now)"}`
                : "Not announced"}
            </dd>
          </div>
          {(event.presales ?? []).map((p) => (
            <div key={`${p.name}-${p.start}`}>
              <dt>Presale: {p.name}</dt>
              <dd>
                {formatDateTime(p.start)}
                {p.end ? ` to ${formatDateTime(p.end)}` : ""}
              </dd>
            </div>
          ))}
        </dl>
        <p className={ui.meta}>Times are shown in your time zone. Always confirm on the official ticket page.</p>
      </section>

      <section className={ui.blockRule} aria-labelledby="cost-title">
        <div className={ui.sectionHead}>
          <h2 id="cost-title" className={ui.sectionTitle}>
            What it really costs
          </h2>
          <span className={ui.meta}>Free</span>
        </div>
        <p className={`lead muted ${styles.sectionLead}`}>
          Tickets, fees, travel, a hotel if you need one, and a buffer. Change any number to match your plans.
        </p>
        <CostTable
          event={event}
          profile={profile}
          plan={plan}
          overrides={overrides}
          onChange={setOverrides}
          showWeekly={premium}
        />
      </section>

      <section className={ui.blockRule} aria-labelledby="plan-title">
        <div className={ui.sectionHead}>
          <h2 id="plan-title" className={ui.sectionTitle}>
            Plan it
          </h2>
          {premium ? <span className="tag premium">Premium</span> : null}
        </div>
        {premium ? (
          <div className={styles.planStack}>
            <div className={styles.planGrid}>
              <SavingsPlan event={event} plan={plan} envelope={envelope} balance={balance} />
              <div className={`${ui.outline} ${styles.planCard}`}>
                <p className={styles.panelKicker}>Trip roadmap</p>
                <h3 className={ui.smallTitle}>Dated steps from today to the day of</h3>
                <p>
                  When to request time off, presale reminders, travel and hotel links with your dates, and a day-of
                  checklist.
                </p>
                <div className={ui.actions}>
                  <Link href={roadmapHref(event.id)} className="pill">
                    Open roadmap <span aria-hidden="true">↗</span>
                  </Link>
                </div>
              </div>
            </div>
            <CompareSection event={event} plan={plan} profile={profile} state={state} />
          </div>
        ) : (
          <PremiumGate
            title="Turn this cost into a plan"
            description={`See how much to save each week to be ready by ${deadlineText(plan)}, keep it in your Livento wallet with automatic weekly saving, compare it with another event and get a dated roadmap.`}
          />
        )}
      </section>
    </div>
  );
}

/** /event/[id] — details, dates, editable cost (free) and the Premium plan. */
export function EventView({ id }: { id: string }) {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading event…" />;
  if (!state.profile) {
    return <NoProfile text="Set up a quick profile (or use the sample) so we can estimate travel, hotel and the full cost of this event." />;
  }
  const eventId = safeDecode(id);
  const event = state.savedEvents[eventId];
  if (!event) {
    return <EventLookup id={eventId} kicker="Event" hint="Find something similar in Discover." />;
  }
  return <EventDetail key={event.id} event={event} profile={state.profile} state={state} />;
}
