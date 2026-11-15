"use client";

import { useState } from "react";
import type { LiventoEvent } from "@/lib/types";
import { categoryImage, categoryLabel } from "./format";
import styles from "./EventImage.module.css";

/**
 * Event photo per DESIGN.md (Imagery): the event's own image (its page's preview
 * image, TheSportsDB's thumb, Ticketmaster's) credited "Image: <source>", then the
 * local category photo (also when a site blocks hotlinking), then a neutral
 * labeled block. Alt text is the event name for its own image; the local photo
 * is generic, so it stays decorative (alt="").
 */
export function EventImage({ event, eager = false }: { event: LiventoEvent; eager?: boolean }) {
  const fallback = categoryImage(event.category);
  const sources = event.image && event.image !== fallback ? [event.image, fallback] : [fallback];
  const [failures, setFailures] = useState(0);
  const src = sources[failures];

  if (!src) {
    return (
      <span className={styles.placeholder} aria-hidden="true">
        {categoryLabel(event.category)}
      </span>
    );
  }
  const own = src === event.image && !src.startsWith("/");
  const credit = own ? event.imageCredit : undefined;
  return (
    <span className={styles.frame}>
      {/* Remote images from many sites: a plain <img> keeps next.config untouched (no remotePatterns). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        className={styles.img}
        src={src}
        alt={own ? event.name : ""}
        referrerPolicy="no-referrer"
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onError={() => setFailures((n) => n + 1)}
      />
      {credit ? <span className={styles.credit}>Image: {credit}</span> : null}
    </span>
  );
}
