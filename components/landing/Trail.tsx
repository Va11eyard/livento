"use client";

/* eslint-disable @next/next/no-img-element -- pre-sized local WebP (see public/assets/assets.json) */

import { useEffect, useRef, type ReactNode } from "react";

/*
 * Hero pointer trail in the Loop Dept design-template style, kept secondary to the hero copy.
 * Stamps alternate between photos and animated loops, follow the pointer with a distance + time
 * throttle, keep at most 7 on screen, and fade out with the Web Animations API. Touch adds a stamp
 * per tap. "Play the trail" runs a fixed path inside the stage (the intro-card column beside the
 * copy; under it on narrow screens). Reduced motion: static posters, no pointer trail.
 * Quiet zones: no stamp starts where it would cover the hero copy, or within QUIET_PAD of a link or
 * button, and existing stamps fade out while the pointer is in one.
 * Everything is imperative DOM work inside one effect so React re-renders never touch the stamps.
 */

const BASE = "/assets/trail/";
const PHOTOS = ["concert", "theatre", "festival", "cinema"];
const LOOPS = ["loop-1", "loop-2", "loop-3"];
const TILTS = [-8, 5, 10, -4, 7, -6];
const MAX_STAMPS = 7;
const LIFE_MS = 1330;
const STILL_LIFE_MS = 850;
type Pose = readonly [x: number, y: number];
/** "Play the trail" loop around the intro card, as fractions of the stage box. */
const PATH: readonly Pose[] = [
  [0.2, 0.55],
  [0.3, 0.36],
  [0.5, 0.3],
  [0.7, 0.37],
  [0.8, 0.54],
  [0.65, 0.66],
  [0.45, 0.64],
  [0.3, 0.5],
];
const STILL_PATH: readonly Pose[] = [[0.5, 0.42]];
/** No stamps within this many px of a link or button, so the trail never covers a click target. */
const QUIET_PAD = 44;
/** Extra px kept between the hero copy and a stamp (stamps are centred on the pointer and tilted). */
const COPY_PAD = 16;

type TrailProps = {
  /** Wordmark, motto, intro text and actions: the main message. Stamps never start on it. */
  copy: ReactNode;
  /** Compact rails row along the bottom of the hero. */
  foot: ReactNode;
};

export default function Trail({ copy, foot }: TrailProps) {
  const heroRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const text = copyRef.current;
    const stage = stageRef.current;
    const layer = layerRef.current;
    const replay = playRef.current;
    if (!hero || !text || !stage || !layer || !replay) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timers = new Set<number>();
    let seq = 0;
    let last: [number, number] | null = null;
    let at = -Infinity;
    let auto: number[] = [];
    let rest = 0;
    let preloaded: HTMLImageElement[] = [];
    let quiet = false;
    let playingUntil = 0;
    let size: [width: number, height: number] | null = null;

    // Stamp size comes from CSS (.stamp); measured once with a hidden probe, again after a resize.
    const stampSize = () => {
      if (!size) {
        const probe = document.createElement("div");
        probe.className = "stamp";
        probe.style.visibility = "hidden";
        layer.append(probe);
        size = [probe.offsetWidth, probe.offsetHeight];
        probe.remove();
      }
      return size;
    };
    const onResize = () => {
      size = null;
    };

    const near = (b: DOMRect, x: number, y: number, padX: number, padY: number) =>
      x >= b.left - padX && x <= b.right + padX && y >= b.top - padY && y <= b.bottom + padY;

    // True when a stamp centred on the pointer would overlap the hero copy, or when the pointer is
    // on, or within QUIET_PAD of, any link or button in the hero.
    const nearInteractive = (clientX: number, clientY: number) => {
      const [w, h] = stampSize();
      if (near(text.getBoundingClientRect(), clientX, clientY, w / 2 + COPY_PAD, h / 2 + COPY_PAD)) return true;
      return Array.from(hero.querySelectorAll<HTMLElement>("a, button")).some((el) => {
        const b = el.getBoundingClientRect();
        if (!b.width && !b.height) return false;
        return near(b, clientX, clientY, QUIET_PAD, QUIET_PAD);
      });
    };

    // Fade existing stamps out (CSS .trail-quiet) while the pointer is aiming at the copy or a control.
    const setQuiet = (next: boolean) => {
      if (next === quiet) return;
      quiet = next;
      hero.classList.toggle("trail-quiet", next);
    };

    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };
    const cancel = (id: number) => {
      window.clearTimeout(id);
      timers.delete(id);
    };

    // Preload every photo and loop once, on first pointer contact (not for reduced motion).
    const warm = () => {
      if (preloaded.length || reduced.matches) return;
      preloaded = [...PHOTOS.map((n) => `${n}.webp`), ...LOOPS.map((n) => `${n}.gif`)].map((file) => {
        const img = new Image();
        img.src = BASE + file;
        return img;
      });
    };

    const stamp = (x: number, y: number) => {
      const n = seq++;
      const isLoop = n % 2 === 1;
      const pool = isLoop ? LOOPS : PHOTOS;
      const name = pool[Math.floor(n / 2) % pool.length];
      const still = reduced.matches;
      const angle = TILTS[n % TILTS.length];

      const el = document.createElement("div");
      el.className = "stamp";
      el.setAttribute("aria-hidden", "true");
      const img = new Image();
      img.alt = "";
      img.src = `${BASE}${name}${isLoop && !still ? ".gif" : ".webp"}`;
      el.append(img);

      while (layer.childElementCount >= MAX_STAMPS) layer.firstElementChild?.remove();
      layer.append(el);
      const base = `translate(${Math.round(x - el.offsetWidth / 2)}px, ${Math.round(y - el.offsetHeight / 2)}px) rotate(${angle}deg)`;
      el.style.transform = base;

      hero.classList.add("active-trail");
      cancel(rest);
      const life = still ? STILL_LIFE_MS : LIFE_MS;
      if (!still) {
        el.animate(
          [
            { transform: `${base} scale(.79)`, opacity: 0.2 },
            { transform: `${base} scale(1)`, opacity: 1, offset: 0.16 },
            { transform: `${base} scale(1)`, opacity: 1, offset: 0.73 },
            { transform: `${base} translateY(12px) scale(.95)`, opacity: 0 },
          ],
          { duration: life, easing: "linear", fill: "forwards" },
        );
      }
      later(() => el.remove(), life);
      rest = later(() => hero.classList.remove("active-trail"), life + 120);
    };

    const stopAuto = () => {
      for (const id of auto) cancel(id);
      auto = [];
    };

    const point = (event: PointerEvent, force = false) => {
      const target = event.target instanceof Element ? event.target : null;
      const nearUi =
        Boolean(target?.closest("a, button, nav")) || nearInteractive(event.clientX, event.clientY);
      // While "Play the trail" runs, keep its stamps visible even though the pointer sits on the button.
      if (performance.now() > playingUntil) setQuiet(nearUi);
      if (nearUi || (!force && reduced.matches)) return;
      const r = hero.getBoundingClientRect();
      const x = event.clientX - r.left;
      const y = event.clientY - r.top;
      const t = performance.now();
      const gap = Math.max(54, Math.min(96, r.width * 0.072));
      if (!force && (t - at < 62 || (last && Math.hypot(x - last[0], y - last[1]) < gap))) return;
      stopAuto();
      warm();
      last = [x, y];
      at = t;
      stamp(x, y);
    };

    // The scripted path stays inside the stage, so it never covers the copy either.
    const play = () => {
      stopAuto();
      warm();
      const r = hero.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const poses = reduced.matches ? STILL_PATH : PATH;
      setQuiet(false);
      playingUntil = performance.now() + poses.length * 165 + LIFE_MS;
      poses.forEach(([px, py], i) => {
        const x = s.left - r.left + px * s.width;
        const y = s.top - r.top + py * s.height;
        auto.push(later(() => stamp(x, y), i * 165));
      });
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") point(event);
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") point(event, true);
    };
    const onLeave = () => {
      last = null;
      setQuiet(false);
    };
    // Clear the trail when the tab is hidden so nothing piles up in the background.
    const onVisibility = () => {
      if (!document.hidden) return;
      stopAuto();
      layer.replaceChildren();
      hero.classList.remove("active-trail");
    };

    hero.addEventListener("pointerenter", warm, { once: true });
    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerdown", onDown);
    hero.addEventListener("pointerleave", onLeave);
    replay.addEventListener("click", play);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);

    return () => {
      hero.removeEventListener("pointerenter", warm);
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerdown", onDown);
      hero.removeEventListener("pointerleave", onLeave);
      replay.removeEventListener("click", play);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      layer.replaceChildren();
      hero.classList.remove("active-trail", "trail-quiet");
    };
  }, []);

  return (
    <div ref={heroRef} className="wrap hero-inner">
      <div ref={copyRef} className="hero-copy">
        {copy}
      </div>
      <div ref={stageRef} className="stage">
        <div className="intro-card" aria-hidden="true">
          <img src={`${BASE}concert.webp`} alt="" width={800} height={600} />
          <span>01 / Your next show</span>
        </div>
        <div className="experiment">
          <button ref={playRef} type="button">
            <i aria-hidden="true" />
            <span>Play the trail</span>
          </button>
          <span className="hint">or move your cursor</span>
        </div>
      </div>
      <div ref={layerRef} className="trail" aria-hidden="true" />
      {foot}
    </div>
  );
}
