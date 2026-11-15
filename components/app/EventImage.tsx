"use client";

import { useState } from "react";
import type { LiventoEvent } from "@/lib/types";
import { categoryLabel } from "./format";
import styles from "./EventImage.module.css";

/** Ink or yellow, picked from the id so neighbouring posters vary but never flicker. */
function posterTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (hash & 1) === 0 ? styles.ink : styles.yellow;
}

/** Typographic poster: the category and the event name in large type. Decorative (the name is in the heading). */
function EventPoster({ event }: { event: LiventoEvent }) {
  return (
    <span className={`${styles.poster} ${posterTone(event.id)}`} aria-hidden="true">
      <span className={styles.kicker}>{categoryLabel(event.category)}</span>
      <span className={styles.name}>{event.name}</span>
    </span>
  );
}

/**
 * Event picture per DESIGN.md (Imagery): the event's own image (its page's preview
 * image, TheSportsDB's thumb, Ticketmaster's). Without one (or a local stock path),
 * or when it fails to load (hotlink-blocked), a typographic poster instead.
 */
export function EventImage({ event, eager = false }: { event: LiventoEvent; eager?: boolean }) {
  const own = event.image && /^https?:\/\//i.test(event.image) ? event.image : undefined;
  const [failed, setFailed] = useState<string | null>(null);

  if (!own || failed === own) return <EventPoster event={event} />;
  return (
    // Remote images from many sites: a plain <img> keeps next.config untouched (no remotePatterns).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={own}
      className={styles.img}
      src={own}
      alt={event.name}
      referrerPolicy="no-referrer"
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(own)}
    />
  );
}
