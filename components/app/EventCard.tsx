"use client";

import Link from "next/link";
import { useId } from "react";
import type { LiventoEvent, RecommendItem } from "@/lib/types";
import { EventImage } from "./EventImage";
import { categoryLabel, eventPlace, eventWhen, priceInfo } from "./format";
import styles from "./EventCard.module.css";

export function eventHref(id: string): string {
  return `/event/${encodeURIComponent(id)}`;
}

export function distanceText(miles: number | undefined): string | null {
  if (typeof miles !== "number" || !Number.isFinite(miles)) return null;
  return miles < 1 ? "Under 1 mi away" : `${Math.round(miles)} mi away`;
}

export interface EventCardProps {
  event: LiventoEvent;
  distanceMiles?: number;
  rec?: RecommendItem;
  liked?: boolean;
  skipped?: boolean;
  /** Called before navigating to the detail page (save the event there). */
  onOpen?: (event: LiventoEvent) => void;
  onLike?: (event: LiventoEvent) => void;
  onSkip?: (event: LiventoEvent) => void;
  onUndoSkip?: (event: LiventoEvent) => void;
  size?: "large" | "small";
  headingLevel?: 2 | 3;
}

/** Event card per DESIGN.md: 1.5:1 cover image, TASA title, meta line, labeled price, actions. */
export function EventCard({
  event,
  distanceMiles,
  rec,
  liked = false,
  skipped = false,
  onOpen,
  onLike,
  onSkip,
  onUndoSkip,
  size = "large",
  headingLevel = 3,
}: EventCardProps) {
  const titleId = useId();
  const href = eventHref(event.id);
  const price = priceInfo(event);
  const distance = distanceText(distanceMiles);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const meta = [eventWhen(event), event.venue, eventPlace(event)].filter(Boolean).join(" · ");
  const open = () => onOpen?.(event);

  if (skipped) {
    return (
      <div className={styles.skipped}>
        <p>
          Skipped <strong>{event.name}</strong>. We&rsquo;ll show fewer like it.
        </p>
        {onUndoSkip ? (
          <button type="button" className="pill small alt" onClick={() => onUndoSkip(event)}>
            Undo<span className="sr-only"> skip for {event.name}</span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <article className={`${styles.card} ${size === "small" ? styles.small : ""}`} aria-labelledby={titleId}>
      <Link href={href} className={styles.media} tabIndex={-1} aria-hidden="true" onClick={open}>
        <EventImage event={event} />
      </Link>

      <div className={styles.body}>
        <div className={styles.topline}>
          <span>{categoryLabel(event.category)}</span>
          {event.source === "sample" ? <span className="tag sample">Sample data</span> : null}
          {event.source === "curated" ? <span className="tag">Curated</span> : null}
          {event.source === "thesportsdb" ? (
            <span className="tag" title="Event data: TheSportsDB">
              TheSportsDB
            </span>
          ) : null}
          {liked ? <span className={styles.likedMark}>Liked</span> : null}
        </div>

        <Heading id={titleId} className={styles.title}>
          <Link href={href} onClick={open}>
            {event.name}
          </Link>
        </Heading>

        {meta ? <p className={styles.meta}>{meta}</p> : null}

        <p className={styles.facts}>
          {distance ? <span>{distance}</span> : null}
          <span className={styles.price}>{price.text}</span>
          {price.estimate ? <span className="tag estimate">Estimate</span> : null}
          {event.source === "ticketmaster" && price.known ? <span>face value, fees extra</span> : null}
        </p>

        {rec?.why ? (
          <p className={styles.why}>
            <span className={styles.whyLabel}>Why this</span> {rec.why}
          </p>
        ) : null}
        {rec?.reasons?.length ? (
          <ul className={styles.reasons} aria-label="Reasons">
            {rec.reasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        {event.source === "ticketmaster" ? (
          <p className={styles.attribution}>{event.attribution || "Event data: Ticketmaster"}</p>
        ) : null}

        <div className={styles.actions}>
          {onLike ? (
            <button
              type="button"
              className={`pill small ${liked ? "" : "alt"}`}
              aria-pressed={liked}
              onClick={() => onLike(event)}
            >
              {liked ? "Liked ✓" : "Like"}
              <span className="sr-only"> {event.name}</span>
            </button>
          ) : null}
          {onSkip ? (
            <button type="button" className="pill small alt" onClick={() => onSkip(event)}>
              Skip<span className="sr-only"> {event.name}</span>
            </button>
          ) : null}
          <Link href={href} className="pill small" onClick={open}>
            See full cost<span className="sr-only"> of {event.name}</span> <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
    </article>
  );
}
