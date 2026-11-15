"use client";

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useState } from "react";
import { safeExternalUrl } from "@/components/app/format";
import ui from "@/components/app/ui.module.css";
import styles from "./event.module.css";

export interface MapInfo {
  label: string;
  embed: string; // the venue
  hotelsEmbed: string; // hotels around the venue
  open: string;
  hotels: string; // Google Hotels search (prices and booking)
  near: { venue?: string; city?: string; state?: string; lat?: number; lng?: number };
}

interface Hotel {
  name: string;
  address?: string;
  website?: string;
  milesAway: number;
  mapUrl: string;
}

type View = "venue" | "hotels";

/** Event map: the venue, or hotels around it (pins on the map plus a short list from OpenStreetMap). */
export function EventMap({ map, where }: { map: MapInfo; where?: string }) {
  const [view, setView] = useState<View>("venue");
  const [hotels, setHotels] = useState<Hotel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (view !== "hotels" || hotels !== null) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ kind: "hotel" });
    const { venue, city, state, lat, lng } = map.near;
    if (typeof lat === "number" && typeof lng === "number") {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    } else {
      if (venue) params.set("near", venue);
      if (city) params.set("city", city);
      if (state) params.set("state", state);
    }
    fetch(`/api/places?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { places?: Hotel[] }) => setHotels(Array.isArray(data.places) ? data.places : []))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [view, hotels, map.near]);

  return (
    <section className={ui.blockRule} aria-labelledby="map-title">
      <div className={ui.sectionHead}>
        <h2 id="map-title" className={ui.sectionTitle}>
          Map
        </h2>
        {where ? <span className={ui.meta}>{where}</span> : null}
      </div>
      <ToggleGroup.Root
        type="single"
        value={view}
        onValueChange={(v) => {
          if (v === "venue" || v === "hotels") setView(v);
        }}
        aria-label="What to show on the map"
        className={`${ui.chips} ${styles.mapToggle}`}
      >
        <ToggleGroup.Item value="venue" className={ui.chip}>
          Venue
        </ToggleGroup.Item>
        <ToggleGroup.Item value="hotels" className={ui.chip}>
          Hotels nearby
        </ToggleGroup.Item>
      </ToggleGroup.Root>
      <iframe
        key={view}
        className={styles.map}
        src={view === "hotels" ? map.hotelsEmbed : map.embed}
        title={view === "hotels" ? `Hotels near ${map.label}` : `Map of ${map.label}`}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
      {view === "hotels" ? (
        <div className={styles.hotelList} aria-live="polite">
          {hotels === null && !failed ? <p className={ui.meta}>Finding hotels near the venue…</p> : null}
          {failed ? <p className={ui.meta}>Couldn&rsquo;t load nearby hotels right now. The map above still shows them.</p> : null}
          {hotels && hotels.length === 0 ? (
            <p className={ui.meta}>No hotels listed within a few miles. Try Google Hotels for more options.</p>
          ) : null}
          {hotels && hotels.length > 0 ? (
            <ul>
              {hotels.map((h) => {
                const site = safeExternalUrl(h.website);
                return (
                  <li key={`${h.name}-${h.milesAway}`}>
                    <span className={styles.hotelName}>{h.name}</span>
                    <span className={ui.meta}>
                      {h.milesAway} mi{h.address ? ` · ${h.address}` : ""}
                    </span>
                    <span className={styles.hotelLinks}>
                      <a href={h.mapUrl} target="_blank" rel="noopener noreferrer" className={ui.inlineLink}>
                        Map<span className="sr-only"> for {h.name} (opens in a new tab)</span> ↗
                      </a>
                      {site ? (
                        <a href={site} target="_blank" rel="noopener noreferrer" className={ui.inlineLink}>
                          Website<span className="sr-only"> of {h.name} (opens in a new tab)</span> ↗
                        </a>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className={ui.actions}>
        <a className="pill small" href={map.open} target="_blank" rel="noopener noreferrer">
          Open in Google Maps<span className="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span>
        </a>
        <a className="pill small alt" href={map.hotels} target="_blank" rel="noopener noreferrer">
          Hotel prices<span className="sr-only"> on Google Hotels (opens in a new tab)</span> <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}
