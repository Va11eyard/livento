"use client";

import { useState } from "react";
import type { LiventoEvent } from "@/lib/types";
import { categoryImage, categoryLabel } from "./format";
import styles from "./EventImage.module.css";

/**
 * Event photo with fallbacks: the source image (Ticketmaster), then the local
 * category image, then a neutral labeled block. Decorative (alt=""): the
 * event name is always next to it.
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
  return (
    // Remote Ticketmaster images: a plain <img> keeps next.config untouched (no remotePatterns needed).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.img}
      src={src}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailures((n) => n + 1)}
    />
  );
}
