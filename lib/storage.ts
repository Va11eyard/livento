/**
 * Livento client state (FR-2, FR-4, FR-8, FR-12, FR-13, FR-14).
 *
 * Everything the user creates lives in this browser under STORAGE_KEY:
 * profile, envelopes, saved events, premium flag and an anonymous id.
 * Client-only: every access to `window` is guarded so the module can be
 * imported by client components that are prerendered on the server.
 *
 * Read it in components with `useAppState()` (a `useSyncExternalStore`
 * subscription: the server snapshot is an empty state, so render a neutral
 * skeleton until `useHydrated()` is true). Change it with the actions below.
 */
import { useSyncExternalStore } from "react";
import sampleProfileJson from "@/data/sample-profile.json";
import { todayISO } from "@/lib/dates";
import {
  CATEGORIES,
  STORAGE_KEY,
  WEEKS_PER_MONTH,
  type AppState,
  type Category,
  type Deposit,
  type Envelope,
  type LiventoEvent,
  type PremiumState,
  type Profile,
} from "@/lib/types";

const PROFILE_VERSION = 1;
const MAX_LIKED_TAGS = 60;
const MAX_SAVED_EVENTS = 150;
const MAX_FAVOURITES = 20;
/** Most recent like/skip ids kept (the API accepts up to 2,000). */
const MAX_HISTORY = 500;

/** Appends ids (deduped) and keeps only the most recent MAX_HISTORY. */
function pushRecent(list: string[], id: string): string[] {
  return [...list.filter((x) => x !== id), id].slice(-MAX_HISTORY);
}

/** Server snapshot and "nothing stored yet" shape. Never mutated. */
const EMPTY_STATE: AppState = Object.freeze({
  profile: undefined,
  envelopes: [],
  savedEvents: {},
  premium: "none",
  anonId: "",
}) as AppState;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function canUseDOM(): boolean {
  return typeof window !== "undefined";
}

/** RFC 4122 v4 id. Uses crypto.randomUUID when available (secure contexts). */
export function newId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function finite(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = finite(v);
  return n === undefined ? fallback : Math.min(max, Math.max(min, n));
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Sanitizers (version guard + defensive parsing of whatever is in storage)
// ---------------------------------------------------------------------------

/** Returns a valid Profile, or undefined when the data is missing or from another version. */
export function sanitizeProfile(raw: unknown): Profile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (p.version !== PROFILE_VERSION) return undefined;
  const city = isString(p.city) ? p.city.trim() : "";
  if (!city) return undefined;
  const months = Array.isArray(p.preferredMonths)
    ? uniq(
        p.preferredMonths
          .map((m) => finite(m))
          .filter((m): m is number => m !== undefined && Number.isInteger(m) && m >= 1 && m <= 12),
      ).sort((a, b) => a - b)
    : [];
  const strings = (v: unknown) => (Array.isArray(v) ? uniq(v.filter(isString)) : []);
  return {
    version: 1,
    interests: Array.isArray(p.interests) ? uniq(p.interests.filter(isCategory)) : [],
    favourites: strings(p.favourites)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_FAVOURITES),
    city,
    stateCode: isString(p.stateCode) && p.stateCode.trim() ? p.stateCode.trim().toUpperCase() : undefined,
    lat: finite(p.lat),
    lng: finite(p.lng),
    radiusMiles: clampNum(p.radiusMiles, 30, 0, 500),
    monthlyFunBudget: clampNum(p.monthlyFunBudget, 150, 0, 100_000),
    hotelPerNight: clampNum(p.hotelPerNight, 150, 0, 10_000),
    travelPerTrip: clampNum(p.travelPerTrip, 200, 0, 20_000),
    vacationDaysLeft: clampNum(p.vacationDaysLeft, 10, 0, 365),
    preferredMonths: months,
    liked: strings(p.liked).slice(-MAX_HISTORY),
    skipped: strings(p.skipped).slice(-MAX_HISTORY),
    likedTags: strings(p.likedTags).slice(0, MAX_LIKED_TAGS),
    isSample: p.isSample === true,
    createdAt: isString(p.createdAt) ? p.createdAt : new Date().toISOString(),
  };
}

function isEventLike(v: unknown): v is LiventoEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return isString(e.id) && isString(e.name) && isString(e.city) && isString(e.category) && isString(e.url);
}

function normalizeEvent(e: LiventoEvent): LiventoEvent {
  return { ...e, tags: Array.isArray(e.tags) ? e.tags.filter(isString) : [] };
}

function sanitizeSavedEvents(raw: unknown): Record<string, LiventoEvent> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, LiventoEvent> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isEventLike(value) && value.id === id) out[id] = normalizeEvent(value);
  }
  return out;
}

function sanitizeEnvelope(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (!isString(e.id) || !isString(e.eventId)) return null;
  const deposits: Deposit[] = Array.isArray(e.deposits)
    ? e.deposits.flatMap((d): Deposit[] => {
        if (!d || typeof d !== "object") return [];
        const r = d as Record<string, unknown>;
        const amount = finite(r.amount);
        return isString(r.date) && amount !== undefined ? [{ date: r.date, amount }] : [];
      })
    : [];
  return {
    id: e.id,
    eventId: e.eventId,
    eventName: isString(e.eventName) && e.eventName.trim() ? e.eventName : "Untitled goal",
    eventDate: isString(e.eventDate) ? e.eventDate : undefined,
    target: Math.max(0, finite(e.target) ?? 0),
    deadline: isString(e.deadline) ? e.deadline : todayISO(),
    deposits,
    createdAt: isString(e.createdAt) ? e.createdAt : new Date().toISOString(),
  };
}

function freshState(): AppState {
  return { profile: undefined, envelopes: [], savedEvents: {}, premium: "none", anonId: newId() };
}

function normalizeState(raw: unknown): AppState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return freshState();
  const r = raw as Record<string, unknown>;
  return {
    profile: sanitizeProfile(r.profile),
    envelopes: Array.isArray(r.envelopes)
      ? r.envelopes.map(sanitizeEnvelope).filter((e): e is Envelope => e !== null)
      : [],
    savedEvents: sanitizeSavedEvents(r.savedEvents),
    premium: r.premium === "demo" || r.premium === "paid" ? r.premium : "none",
    anonId: isString(r.anonId) && r.anonId ? r.anonId : newId(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: AppState | null = null;
let listeningToStorage = false;

function readFromStorage(): AppState {
  if (!canUseDOM()) return EMPTY_STATE;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null; // storage blocked (private mode, policy): run in memory
  }
  if (!raw) return freshState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return freshState(); // corrupted JSON: start clean rather than crash
  }
}

function getSnapshot(): AppState {
  if (cache === null) cache = readFromStorage();
  return cache;
}

function getServerSnapshot(): AppState {
  return EMPTY_STATE;
}

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  cache = readFromStorage(); // another tab changed it
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!listeningToStorage && canUseDOM()) {
    window.addEventListener("storage", onStorage);
    listeningToStorage = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listeningToStorage) {
      window.removeEventListener("storage", onStorage);
      listeningToStorage = false;
    }
  };
}

function commit(next: AppState) {
  cache = next;
  if (canUseDOM()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or storage blocked: keep the in-memory copy for this visit.
    }
  }
  emit();
}

function update(fn: (state: AppState) => AppState) {
  const current = getSnapshot();
  const next = fn(current);
  if (next !== current) commit(next);
}

/** Current state, outside React (event handlers, effects). */
export function getAppState(): AppState {
  return getSnapshot();
}

/** Live app state. Server render and hydration see an empty state. */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const noopSubscribe = () => () => {};

/** false during the server render and hydration, true afterwards (no effect needed). */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function keepIds(state: AppState): Set<string> {
  return new Set([...state.envelopes.map((e) => e.eventId), ...(state.profile?.liked ?? [])]);
}

function withSaved(state: AppState, event: LiventoEvent): Record<string, LiventoEvent> {
  const next = { ...state.savedEvents };
  delete next[event.id]; // re-insert so the newest is last
  next[event.id] = normalizeEvent(event);
  const ids = Object.keys(next);
  if (ids.length > MAX_SAVED_EVENTS) {
    const keep = keepIds(state);
    let count = ids.length;
    for (const id of ids) {
      if (count <= MAX_SAVED_EVENTS) break;
      if (id !== event.id && !keep.has(id)) {
        delete next[id];
        count--;
      }
    }
  }
  return next;
}

function tagsOf(event: LiventoEvent): string[] {
  return (event.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
}

export function setProfile(profile: Profile) {
  const clean = sanitizeProfile(profile);
  if (!clean) return;
  update((s) => ({ ...s, profile: clean }));
}

export function updateProfile(patch: Partial<Profile>) {
  update((s) => {
    if (!s.profile) return s;
    const clean = sanitizeProfile({ ...s.profile, ...patch });
    return clean ? { ...s, profile: clean } : s;
  });
}

const FALLBACK_SAMPLE: Profile = {
  version: 1,
  interests: ["music", "festivals", "comedy", "theatre"],
  favourites: ["indie rock", "jazz", "stand-up comedy"],
  city: "Chicago",
  stateCode: "IL",
  lat: 41.8781,
  lng: -87.6298,
  radiusMiles: 30,
  monthlyFunBudget: 150,
  hotelPerNight: 140,
  travelPerTrip: 180,
  vacationDaysLeft: 8,
  preferredMonths: [3, 4, 5, 6, 7, 8, 9, 10],
  liked: [],
  skipped: [],
  likedTags: [],
  isSample: true,
  createdAt: "2026-11-14T00:00:00.000Z",
};

/** FR-13: one click loads the labeled, fictional sample profile. */
export function loadSampleProfile(): Profile {
  const profile =
    sanitizeProfile({
      ...(sampleProfileJson as unknown as Record<string, unknown>),
      liked: [],
      skipped: [],
      likedTags: [],
      isSample: true,
      createdAt: new Date().toISOString(),
    }) ?? { ...FALLBACK_SAMPLE, createdAt: new Date().toISOString() };
  update((s) => ({ ...s, profile }));
  return profile;
}

/** Like: remembers the event, its tags (used by the scorer) and saves it for offline detail pages. */
export function likeEvent(event: LiventoEvent) {
  update((s) => {
    const savedEvents = withSaved(s, event);
    if (!s.profile) return { ...s, savedEvents };
    const p = s.profile;
    return {
      ...s,
      savedEvents,
      profile: {
        ...p,
        liked: pushRecent(p.liked, event.id),
        skipped: p.skipped.filter((id) => id !== event.id),
        likedTags: uniq([...tagsOf(event), ...p.likedTags]).slice(0, MAX_LIKED_TAGS),
      },
    };
  });
}

/** Undo a like; liked tags are rebuilt from the remaining liked events. */
export function unlikeEvent(id: string) {
  update((s) => {
    if (!s.profile) return s;
    const liked = s.profile.liked.filter((x) => x !== id);
    const likedTags = uniq(
      liked.flatMap((likedId) => {
        const e = s.savedEvents[likedId];
        return e ? tagsOf(e) : [];
      }),
    ).slice(0, MAX_LIKED_TAGS);
    return { ...s, profile: { ...s.profile, liked, likedTags } };
  });
}

export function skipEvent(id: string) {
  update((s) => {
    if (!s.profile) return s;
    return {
      ...s,
      profile: {
        ...s.profile,
        skipped: pushRecent(s.profile.skipped, id),
        liked: s.profile.liked.filter((x) => x !== id),
      },
    };
  });
}

export function unskipEvent(id: string) {
  update((s) =>
    s.profile ? { ...s, profile: { ...s.profile, skipped: s.profile.skipped.filter((x) => x !== id) } } : s,
  );
}

/** Keeps a copy of the event so /event/[id] and /roadmap/[id] work without refetching. */
export function saveEvent(event: LiventoEvent) {
  update((s) => ({ ...s, savedEvents: withSaved(s, event) }));
}

export interface NewEnvelope {
  eventId: string;
  eventName: string;
  eventDate?: string;
  target: number;
  deadline: string;
}

/** Creates an envelope, or updates the target/deadline of the one that already exists for this event. Returns its id. */
export function addEnvelope(input: NewEnvelope): string {
  let id = "";
  update((s) => {
    const target = Math.max(0, Math.round(input.target));
    const existing = s.envelopes.find((e) => e.eventId === input.eventId);
    if (existing) {
      id = existing.id;
      return {
        ...s,
        envelopes: s.envelopes.map((e) =>
          e.id === existing.id
            ? { ...e, eventName: input.eventName, eventDate: input.eventDate, target, deadline: input.deadline }
            : e,
        ),
      };
    }
    id = newId();
    const envelope: Envelope = {
      id,
      eventId: input.eventId,
      eventName: input.eventName,
      eventDate: input.eventDate,
      target,
      deadline: input.deadline,
      deposits: [],
      createdAt: new Date().toISOString(),
    };
    return { ...s, envelopes: [...s.envelopes, envelope] };
  });
  return id;
}

/** "I set aside $X" (positive) or a withdrawal (negative). Money never moves; this only records it. */
export function addDeposit(envelopeId: string, amount: number) {
  if (!Number.isFinite(amount) || amount === 0) return;
  update((s) => ({
    ...s,
    envelopes: s.envelopes.map((e) =>
      e.id === envelopeId ? { ...e, deposits: [...e.deposits, { date: todayISO(), amount: round2(amount) }] } : e,
    ),
  }));
}

export function removeEnvelope(id: string) {
  update((s) => ({ ...s, envelopes: s.envelopes.filter((e) => e.id !== id) }));
}

export function setPremium(premium: PremiumState) {
  update((s) => (s.premium === premium ? s : { ...s, premium }));
}

/** Clears everything Livento stored in this browser. */
export function resetAll() {
  if (canUseDOM()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  cache = freshState();
  emit();
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** USD recorded in an envelope (never below 0). */
export function envelopeBalance(env: Envelope): number {
  const sum = env.deposits.reduce((total, d) => total + (Number.isFinite(d.amount) ? d.amount : 0), 0);
  return Math.max(0, round2(sum));
}

/** USD recorded across all envelopes. */
export function totalSetAside(envelopes: Envelope[]): number {
  return round2(envelopes.reduce((total, e) => total + envelopeBalance(e), 0));
}

/** USD per week the user can put toward experiences (monthly fun budget ÷ 4.33). */
export function weeklyContribution(profile: Profile): number {
  return profile.monthlyFunBudget / WEEKS_PER_MONTH;
}

export function envelopeForEvent(state: AppState, eventId: string): Envelope | undefined {
  return state.envelopes.find((e) => e.eventId === eventId);
}

export function hasPremium(state: AppState): boolean {
  return state.premium === "demo" || state.premium === "paid";
}
