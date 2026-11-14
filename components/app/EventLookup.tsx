"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { getEventById } from "@/lib/client-api";
import { saveEvent } from "@/lib/storage";
import { PageSkeleton } from "./States";
import ui from "./ui.module.css";
import { useAsync } from "./useAsync";

interface EventLookupProps {
  id: string;
  /** Kicker above the "not found" heading, e.g. "Event" or "Roadmap". */
  kicker: string;
  /** Extra line under the "not found" heading. */
  hint: ReactNode;
}

/**
 * Shown when /event/[id] or /roadmap/[id] is opened in a browser that never
 * saw the event (a shared link, an alert email). Fetches it once by id and
 * saves it locally; the page then re-renders with the event from storage.
 */
export function EventLookup({ id, kicker, hint }: EventLookupProps) {
  const lookup = useAsync(`lookup:${id}`, (signal) =>
    getEventById(id, signal).then((res) => {
      const event = res.events.find((e) => e.id === id);
      if (event) saveEvent(event); // storage update re-renders the page with the event
      return Boolean(event);
    }),
  );

  if (lookup.loading || lookup.data === true) return <PageSkeleton label="Loading event…" />;

  return (
    <div className="wrap">
      <section className={ui.empty} aria-labelledby="missing-event-title">
        <p className="kicker">{kicker}</p>
        <h1 id="missing-event-title" className="title">
          We can&rsquo;t find this event
        </h1>
        <p className="lead muted">
          {lookup.error ? `${lookup.error} ` : "It may have ended or been removed. "}
          {hint}
        </p>
        <div className={ui.actions}>
          <Link href="/discover" className="pill">
            Go to Discover <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
