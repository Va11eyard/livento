"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import Link from "next/link";
import { useState } from "react";
import { EventCard } from "@/components/app/EventCard";
import { categoryLabel, usd0 } from "@/components/app/format";
import {
  ErrorState,
  NoProfile,
  Notice,
  PageSkeleton,
  SampleBanner,
} from "@/components/app/States";
import { useToast } from "@/components/app/Toast";
import { useAsync } from "@/components/app/useAsync";
import ui from "@/components/app/ui.module.css";
import {
  eventsQueryFromProfile,
  getEvents,
  getWebEvents,
  logInteraction,
  readWebEventsCache,
  recommend,
} from "@/lib/client-api";
import { eventDistanceMiles } from "@/lib/cost";
import {
  getAppState,
  likeEvent,
  saveEvent,
  skipEvent,
  unlikeEvent,
  unskipEvent,
  useAppState,
  useHydrated,
} from "@/lib/storage";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type AppState,
  type Category,
  type InteractionAction,
  type LiventoEvent,
  type Profile,
  type RecommendItem,
} from "@/lib/types";
import { AlertsBox } from "./AlertsBox";
import styles from "./discover.module.css";
import { useStickyAsync } from "./useStickyAsync";

const MORE_PAGE = 12;
const MAX_RANKED = 300; // /api/recommend accepts up to 300 events

// Same wording as lib/catalog's empty notice.
const noEventsNotice = (city: string) =>
  `No events found near ${city} yet. Try a bigger travel radius or more interests.`;

const nameDateKey = (e: LiventoEvent) =>
  `${e.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}|${e.date ?? ""}`;

/** Adds web-search events to the list (only real events: samples are never listed). */
function withWebEvents(
  base: LiventoEvent[],
  web: LiventoEvent[] | undefined,
): LiventoEvent[] {
  if (!web?.length) return base;
  const ids = new Set(base.map((e) => e.id));
  const known = new Set(
    base.filter((e) => e.source === "web").map(nameDateKey),
  );
  const added = web.filter((e) => !ids.has(e.id) && !known.has(nameDateKey(e)));
  return [...base, ...added];
}

function byDate(a: LiventoEvent, b: LiventoEvent): number {
  if (a.date && b.date)
    return a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.name.localeCompare(b.name);
}

function log(eventId: string, action: InteractionAction) {
  logInteraction({ anonId: getAppState().anonId, eventId, action });
}

/** Categories of the last 3 envelopes (saved goals), oldest first — the novelty factor in spec §6. */
function recentGoalCategories(state: AppState): Category[] {
  return [...state.envelopes]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-3)
    .map((env) => state.savedEvents[env.eventId]?.category)
    .filter((c): c is Category => Boolean(c));
}

function interestsText(profile: Profile): string {
  const labels = profile.interests.map((c) => CATEGORY_LABELS[c].toLowerCase());
  if (!labels.length) return "your interests";
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function CardGridSkeleton({
  count,
  columns,
}: {
  count: number;
  columns: 2 | 3;
}) {
  return (
    <div className={columns === 2 ? ui.grid2 : ui.grid3} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.cardSkeleton}>
          <div className={ui.skelCard} />
          <div className={ui.skelLine} />
          <div className={ui.skelBar} />
        </div>
      ))}
    </div>
  );
}

function Discover({ profile }: { profile: Profile }) {
  const notify = useToast();
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");
  const [skippedNow, setSkippedNow] = useState<string[]>([]);
  const [moreCount, setMoreCount] = useState(MORE_PAGE);
  const [webAttempt, setWebAttempt] = useState(0);

  // Refetch only when the search itself changes (not on every like/skip).
  const query = eventsQueryFromProfile(profile);
  const eventsKey = `${JSON.stringify(query)}#${attempt}`;
  const events = useAsync(eventsKey, (signal) => getEvents(query, signal));
  const base = events.data;

  // Interests the server hasn't searched the web for yet: this browser's copy from
  // the last 12 hours first, otherwise ask for the search (up to a minute).
  const webPending = base?.webSearch === "pending";
  const savedWeb = webPending ? readWebEventsCache(query) : null;
  const web = useAsync(
    webPending && !savedWeb ? `${eventsKey}|web#${webAttempt}` : null,
    (signal) => getWebEvents(query, signal),
  );
  const webEvents = savedWeb ?? web.data?.events;
  const webSearching = webPending && !webEvents && !web.error;
  const list = base
    ? withWebEvents(base.events, webPending ? webEvents : undefined)
    : undefined;
  const webFound = webPending ? (webEvents?.length ?? 0) : 0;

  // Ranked once with what's there, and again when web results add events.
  const recs = useStickyAsync(
    list
      ? `${eventsKey}|rec|${webFound > 0 ? `web${webFound}` : "base"}`
      : null,
    (signal) => {
      const state = getAppState();
      const latest = state.profile ?? profile;
      const skipped = new Set(latest.skipped);
      const candidates = (list ?? [])
        .filter((e) => !skipped.has(e.id))
        .slice(0, MAX_RANKED);
      return recommend(
        {
          profile: latest,
          events: candidates,
          recentGoalCategories: recentGoalCategories(state),
        },
        signal,
      );
    },
  );

  const likedSet = new Set(profile.liked);
  const skippedSet = new Set(profile.skipped);
  const nowSet = new Set(skippedNow);
  // Skipped in an earlier visit: hidden. Skipped just now: shown with Undo.
  const hidden = (id: string) => skippedSet.has(id) && !nowSet.has(id);
  const matchesFilter = (e: LiventoEvent) =>
    filter === "all" || e.category === filter;

  const byId = new Map((list ?? []).map((e) => [e.id, e] as const));
  // While the list is re-ranked after web results arrive, the previous picks stay up.
  const rankedData = recs.data ?? (recs.loading ? recs.stale : undefined);
  let picks: { event: LiventoEvent; rec?: RecommendItem }[] = [];
  if (rankedData) {
    picks = rankedData.items
      .flatMap((item) => {
        const event = byId.get(item.eventId);
        return event ? [{ event, rec: item }] : [];
      })
      .slice(0, 8);
  } else if (recs.error && list) {
    picks = list
      .filter((e) => !skippedSet.has(e.id))
      .sort(byDate)
      .slice(0, 8)
      .map((event) => ({ event }));
  }
  const showingStale = !recs.data && recs.loading && picks.length > 0;
  const picksLoading = recs.loading && !showingStale;
  // Ranking has finished (with AI/rules picks, or with the by-date fallback after an error).
  const ranked = !!recs.data || showingStale || (!!recs.error && !!list);

  // Once the extra results are in, the note shows only when nothing nearby turned up.
  let notice = base?.notice;
  if (base && list && webPending && webEvents) {
    const hasSports = list.some((e) => e.source === "thesportsdb");
    notice =
      webFound > 0 || hasSports ? undefined : noEventsNotice(profile.city);
  }
  const pickIds = new Set(picks.map((p) => p.event.id));
  const visiblePicks = picks.filter(
    (p) => matchesFilter(p.event) && !hidden(p.event.id),
  );
  const more = (list ?? [])
    .filter((e) => !pickIds.has(e.id) && matchesFilter(e) && !hidden(e.id))
    .sort(byDate);
  const presentCategories = CATEGORIES.filter((c) =>
    (list ?? []).some((e) => e.category === c),
  );

  const onOpen = (e: LiventoEvent) => {
    saveEvent(e);
    log(e.id, "open");
  };
  const onLike = (e: LiventoEvent) => {
    if (likedSet.has(e.id)) {
      unlikeEvent(e.id);
      return;
    }
    likeEvent(e);
    log(e.id, "like");
    notify(
      "Saved to your likes",
      "Likes tune your next picks and show up in the comparator.",
    );
  };
  const onSkip = (e: LiventoEvent) => {
    skipEvent(e.id);
    log(e.id, "skip");
    setSkippedNow((ids) => [...ids, e.id]);
  };
  const onUndoSkip = (e: LiventoEvent) => {
    unskipEvent(e.id);
    setSkippedNow((ids) => ids.filter((id) => id !== e.id));
  };

  const card = (
    event: LiventoEvent,
    rec: RecommendItem | undefined,
    size: "large" | "small",
  ) => (
    <EventCard
      key={event.id}
      event={event}
      rec={rec}
      size={size}
      distanceMiles={eventDistanceMiles(event, profile)}
      liked={likedSet.has(event.id)}
      skipped={nowSet.has(event.id) && skippedSet.has(event.id)}
      onOpen={onOpen}
      onLike={onLike}
      onSkip={onSkip}
      onUndoSkip={onUndoSkip}
    />
  );

  let status = "";
  if (events.loading) status = `Finding events near ${profile.city}…`;
  else if (events.error) status = "Couldn't load events.";
  else if (recs.loading)
    status = `Found ${list?.length ?? 0} events. Picking your top 8…`;
  else if (webSearching)
    status = `Showing your top ${picks.length} picks. Looking for more events near ${profile.city}…`;
  else if (recs.data) status = `Showing your top ${picks.length} picks.`;
  else if (recs.error) status = "Showing upcoming events by date.";

  return (
    <div className={`wrap ${ui.page}`}>
      <header className={ui.head}>
        <p className="kicker">01 / Discover</p>
        <div className={ui.headRow}>
          <h1 className="title">Top picks near {profile.city}</h1>
          <Link href="/onboarding" className="pill small alt">
            Edit profile <span aria-hidden="true">●</span>
          </Link>
        </div>
        <p className="lead muted">
          Matched to {interestsText(profile)} within {profile.radiusMiles}{" "}
          miles. Open any event to see its full cost.
        </p>
      </header>

      {profile.isSample ? (
        <div className={styles.banner}>
          <SampleBanner
            action={
              <Link href="/onboarding" className="pill small alt">
                Make it yours <span aria-hidden="true">↗</span>
              </Link>
            }
          >
            You&rsquo;re exploring with a fictional sample profile:{" "}
            {profile.city}, {usd0(profile.monthlyFunBudget)} a month for fun.
          </SampleBanner>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>

      {events.loading ? (
        <div className={styles.loading}>
          <p className={ui.status} aria-hidden="true">
            Finding events near {profile.city}…
          </p>
          <CardGridSkeleton count={2} columns={2} />
        </div>
      ) : null}

      {events.error ? (
        <ErrorState
          title="We couldn't load events"
          message={events.error}
          onRetry={() => setAttempt((a) => a + 1)}
          backHref="/onboarding"
          backLabel="Edit profile"
        />
      ) : null}

      {events.data && list ? (
        <>
          {notice && (list.length > 0 || webSearching) ? (
            <div className={styles.banner}>
              <Notice label="Note">{notice}</Notice>
            </div>
          ) : null}

          {webSearching ? (
            <p className={styles.webRow} aria-hidden="true">
              <span className={styles.webDot} />
              <span>Looking for more events near {profile.city}…</span>
              <span className={ui.meta}>
                This can take up to a minute. Everything below is ready to
                browse.
              </span>
            </p>
          ) : null}

          {webPending && web.error && !webEvents ? (
            <div className={styles.banner}>
              <Notice label="Heads up">
                We couldn&rsquo;t finish looking for more events just now, so
                some may be missing.{" "}
                <button
                  type="button"
                  className={ui.textButton}
                  onClick={() => setWebAttempt((a) => a + 1)}
                >
                  Try again
                </button>
              </Notice>
            </div>
          ) : null}

          {list.length === 0 ? (
            webSearching ? null : (
              <div className={ui.outline}>
                <h2 className={ui.smallTitle}>
                  No events found near {profile.city} yet
                </h2>
                <p className={styles.emptyText}>
                  Try a bigger travel radius or more interests, then check back.
                  New listings appear often.
                </p>
                <div className={ui.actions}>
                  <Link href="/onboarding" className="pill small">
                    Edit profile
                  </Link>
                  <button
                    type="button"
                    className="pill small alt"
                    onClick={() => setAttempt((a) => a + 1)}
                  >
                    Search again
                  </button>
                </div>
              </div>
            )
          ) : (
            <>
              {presentCategories.length > 1 ? (
                <div className={styles.filters}>
                  <p className={styles.filterLabel} id="discover-filter-label">
                    Show
                  </p>
                  <ToggleGroup.Root
                    type="single"
                    value={filter}
                    onValueChange={(value) => {
                      setFilter(value || "all");
                      setMoreCount(MORE_PAGE);
                    }}
                    aria-labelledby="discover-filter-label"
                    className={ui.chips}
                  >
                    <ToggleGroup.Item value="all" className={ui.chip}>
                      All
                    </ToggleGroup.Item>
                    {presentCategories.map((c) => (
                      <ToggleGroup.Item key={c} value={c} className={ui.chip}>
                        {CATEGORY_LABELS[c]}
                      </ToggleGroup.Item>
                    ))}
                  </ToggleGroup.Root>
                </div>
              ) : null}

              <section
                className={styles.picks}
                aria-labelledby="top-picks-title"
                aria-busy={recs.loading}
              >
                <div className={ui.sectionHead}>
                  <h2 id="top-picks-title" className={ui.sectionTitle}>
                    Top picks for you
                  </h2>
                </div>

                {picksLoading ? (
                  <>
                    <p className={ui.status} aria-hidden="true">
                      Picking your top 8…
                    </p>
                    <CardGridSkeleton count={2} columns={2} />
                  </>
                ) : null}

                {recs.error ? (
                  <div className={styles.banner}>
                    <Notice label="Heads up">
                      We couldn&rsquo;t rank events right now, so here are the
                      next ones by date.{" "}
                      <button
                        type="button"
                        className={ui.textButton}
                        onClick={() => setAttempt((a) => a + 1)}
                      >
                        Try again
                      </button>
                    </Notice>
                  </div>
                ) : null}

                {ranked ? (
                  visiblePicks.length ? (
                    <div className={ui.grid2}>
                      {visiblePicks.map((p) => card(p.event, p.rec, "large"))}
                    </div>
                  ) : (
                    <p className={ui.status}>
                      {filter !== "all"
                        ? `No top picks in ${categoryLabel(filter)}. See more events below.`
                        : picks.length
                          ? "You've skipped all of today's picks. Browse more events below."
                          : "No strong matches right now. Browse everything below, or widen your radius in your profile."}
                    </p>
                  )
                ) : null}
              </section>

              {/* Nothing more to list (and no filter to clear): skip the empty "More events" block. */}
              {more.length || filter !== "all" ? (
                <section
                  className={ui.blockRule}
                  aria-labelledby="more-events-title"
                >
                  <div className={ui.sectionHead}>
                    <h2 id="more-events-title" className={ui.sectionTitle}>
                      {ranked ? "More events" : "Upcoming near you"}
                    </h2>
                    <p className={ui.meta}>
                      {more.length} event{more.length === 1 ? "" : "s"}
                      {filter !== "all" ? ` in ${categoryLabel(filter)}` : ""}
                    </p>
                  </div>
                  {more.length ? (
                    <>
                      <div className={ui.grid3}>
                        {more
                          .slice(0, moreCount)
                          .map((e) => card(e, undefined, "small"))}
                      </div>
                      {more.length > moreCount ? (
                        <div className={styles.moreRow}>
                          <button
                            type="button"
                            className="pill alt"
                            onClick={() => setMoreCount((n) => n + MORE_PAGE)}
                          >
                            Show more events <span aria-hidden="true">●</span>
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className={ui.status}>
                      {filter === "all"
                        ? "That's everything for now."
                        : `Nothing else in ${categoryLabel(filter)} right now.`}{" "}
                      {filter !== "all" ? (
                        <button
                          type="button"
                          className={ui.textButton}
                          onClick={() => setFilter("all")}
                        >
                          Show all
                        </button>
                      ) : null}
                    </p>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      ) : null}

      <div className={ui.blockRule}>
        <AlertsBox profile={profile} />
      </div>
    </div>
  );
}

/** /discover — events near the user, top 8 with "why this", like/skip, alerts. */
export function DiscoverView() {
  const state = useAppState();
  const hydrated = useHydrated();
  if (!hydrated) return <PageSkeleton label="Loading your picks…" />;
  if (!state.profile) return <NoProfile />;
  return <Discover profile={state.profile} />;
}
