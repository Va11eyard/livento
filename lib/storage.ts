/**
 * Livento client state (FR-2, FR-4, FR-8, FR-12, FR-13, FR-14).
 *
 * Everything the user creates lives in this browser under STORAGE_KEY:
 * profile, envelopes, saved events, premium flag, an anonymous id and the
 * link (token) to the user's Livento wallet. Wallet money itself is held
 * through Stripe test mode; envelope deposits mirror that ledger. Profile
 * photos are kept apart under PROFILE_MEDIA_KEY (see useProfileMedia).
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
  COVER_PRESETS,
  GENERAL_ENVELOPE_ID,
  PROFILE_LIMITS,
  PROFILE_MEDIA_KEY,
  STORAGE_KEY,
  WEEKS_PER_MONTH,
  type AppState,
  type Category,
  type CoverChoice,
  type Deposit,
  type Envelope,
  type InsightsMonth,
  type InsightsSummary,
  type LiventoEvent,
  type PremiumState,
  type Profile,
  type ProfileMedia,
  type ProfileQuote,
  type ProfileSocial,
  type TelegramLink,
  type WalletLink,
  type WalletSummary,
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
        if (!isString(r.date) || amount === undefined) return [];
        const deposit: Deposit = { date: r.date, amount };
        if (r.kind === "deposit" || r.kind === "autosave" || r.kind === "withdrawal") deposit.kind = r.kind;
        if (isString(r.ref) && /^(pi|re)_[A-Za-z0-9_]{1,250}$/.test(r.ref)) deposit.ref = r.ref;
        return [deposit];
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

// Insights summary (spending per month; never the raw file) -------------------

const MAX_INSIGHT_MONTHS = 36;
const MAX_INSIGHT_CATEGORIES = 24;
const MAX_INSIGHT_MERCHANTS = 10;

function sanitizeInsightsMonth(raw: unknown): InsightsMonth | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (!isString(m.month) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m.month)) return null;
  const [year, month] = m.month.split("-").map(Number);
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byCategory: Record<string, number> = {};
  if (m.byCategory && typeof m.byCategory === "object" && !Array.isArray(m.byCategory)) {
    for (const [key, value] of Object.entries(m.byCategory as Record<string, unknown>).slice(0, MAX_INSIGHT_CATEGORIES)) {
      const name = key.trim().slice(0, 40);
      const amount = finite(value);
      if (name && name !== "__proto__" && amount !== undefined && amount > 0) byCategory[name] = round2(amount);
    }
  }
  const topMerchants = Array.isArray(m.topMerchants)
    ? m.topMerchants
        .flatMap((t): InsightsMonth["topMerchants"] => {
          if (!t || typeof t !== "object") return [];
          const r = t as Record<string, unknown>;
          const name = isString(r.name) ? r.name.trim().slice(0, 60) : "";
          const amount = finite(r.amount);
          if (!name || amount === undefined || amount <= 0) return [];
          return [{ name, amount: round2(amount), count: Math.round(clampNum(r.count, 1, 1, 100_000)) }];
        })
        .slice(0, MAX_INSIGHT_MERCHANTS)
    : [];
  const categorySum = Object.values(byCategory).reduce((sum, v) => sum + v, 0);
  return {
    month: m.month,
    days: Math.round(clampNum(m.days, monthDays, 1, monthDays)),
    spendTotal: round2(clampNum(m.spendTotal, categorySum, 0, 100_000_000)),
    count: Math.round(clampNum(m.count, 0, 0, 1_000_000)),
    byCategory,
    topMerchants,
  };
}

/** Returns a valid insights summary, or undefined when nothing usable is stored. A later copy of a month wins. */
export function sanitizeInsights(raw: unknown): InsightsSummary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || (r.source !== "sample" && r.source !== "upload")) return undefined;
  const byMonth = new Map<string, InsightsMonth>();
  if (Array.isArray(r.months)) {
    for (const item of r.months) {
      const month = sanitizeInsightsMonth(item);
      if (month) byMonth.set(month.month, month);
    }
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-MAX_INSIGHT_MONTHS);
  if (months.length === 0) return undefined;
  return {
    version: 1,
    source: r.source,
    analyzedAt: isString(r.analyzedAt) && !Number.isNaN(Date.parse(r.analyzedAt)) ? r.analyzedAt : new Date().toISOString(),
    classifier: r.classifier === "rules+llm" ? "rules+llm" : "rules",
    months,
  };
}

/** The general wallet balance (USD, money with no goal): a positive amount, else nothing. */
function sanitizeGeneral(raw: unknown): number | undefined {
  const n = finite(raw);
  return n !== undefined && n > 0 ? round2(Math.min(n, 10_000_000)) : undefined;
}

/** "<cus id>.<mac>" from POST /api/wallet; anything else is dropped. */
function sanitizeWallet(raw: unknown): WalletLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  if (!isString(w.token) || !/^cus_[A-Za-z0-9]{6,64}\.[A-Za-z0-9_-]{16,64}$/.test(w.token)) return undefined;
  return { token: w.token, createdAt: isString(w.createdAt) ? w.createdAt : new Date().toISOString() };
}

/** "<chat id>.<mac>" from the bot's "✓ Show on Livento" link (lib/telegram-link); anything else is dropped. */
function sanitizeTelegram(raw: unknown): TelegramLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (!isString(t.token) || !/^[1-9]\d{0,19}\.[A-Za-z0-9_-]{32}$/.test(t.token)) return undefined;
  const handle = (v: unknown) => (isString(v) && /^[A-Za-z0-9_]{1,32}$/.test(v) ? v : undefined);
  const name = cleanLine(t.name, 64);
  return {
    token: t.token,
    ...(name ? { name } : {}),
    ...(handle(t.username) ? { username: handle(t.username) } : {}),
    ...(handle(t.bot) ? { bot: handle(t.bot) } : {}),
    linkedAt: isString(t.linkedAt) ? t.linkedAt : new Date().toISOString(),
  };
}

/** Longest AI or curated quote kept (custom quotes are capped at PROFILE_LIMITS.quote). */
const MAX_QUOTE_CHARS = 240;
const COVER_CHOICES: readonly string[] = ["auto", ...COVER_PRESETS, "photo"];

/** One line of user text: control characters and whitespace runs become a space; trimmed and capped. */
function cleanLine(v: unknown, max: number): string {
  if (!isString(v)) return "";
  return v
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, "") // never end on half of an emoji
    .trim();
}

function sanitizeQuote(raw: unknown): ProfileQuote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  const source = q.source === "curated" || q.source === "custom" || q.source === "ai" ? q.source : undefined;
  if (!source) return undefined;
  const text = cleanLine(q.text, source === "custom" ? PROFILE_LIMITS.quote : MAX_QUOTE_CHARS);
  if (!text) return undefined;
  const index = finite(q.index);
  return source === "curated" && index !== undefined && Number.isInteger(index) && index >= 0
    ? { text, source, index }
    : { text, source };
}

/** Name, bio, quote and cover choice shown on /profile. */
function sanitizeSocial(raw: unknown): ProfileSocial | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  return {
    displayName: cleanLine(s.displayName, PROFILE_LIMITS.name),
    bio: cleanLine(s.bio, PROFILE_LIMITS.bio),
    quote: sanitizeQuote(s.quote),
    cover: isString(s.cover) && COVER_CHOICES.includes(s.cover) ? (s.cover as CoverChoice) : "auto",
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
    premiumSession:
      r.premium === "paid" && isString(r.premiumSession) && /^cs_test_[A-Za-z0-9]{8,240}$/.test(r.premiumSession)
        ? r.premiumSession
        : undefined,
    anonId: isString(r.anonId) && r.anonId ? r.anonId : newId(),
    insights: sanitizeInsights(r.insights),
    wallet: sanitizeWallet(r.wallet),
    walletGeneral: sanitizeGeneral(r.walletGeneral),
    social: sanitizeSocial(r.social),
    telegram: sanitizeTelegram(r.telegram),
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

/** Links this browser to its Livento wallet (token from POST /api/wallet). */
export function setWallet(token: string) {
  const wallet = sanitizeWallet({ token, createdAt: new Date().toISOString() });
  if (!wallet) return;
  update((s) => (s.wallet?.token === wallet.token ? s : { ...s, wallet }));
}

/** Links this browser to the user's Telegram chat (from POST /api/telegram/link). */
export function setTelegram(link: Omit<TelegramLink, "linkedAt">) {
  const telegram = sanitizeTelegram({ ...link, linkedAt: new Date().toISOString() });
  if (telegram) update((s) => ({ ...s, telegram }));
}

/** Forgets the Telegram link (Disconnect, or a token the server no longer accepts). */
export function clearTelegram() {
  update((s) => (s.telegram ? { ...s, telegram: undefined } : s));
}

/** Forgets a wallet link the server no longer accepts (key changed, customer gone). */
export function clearWallet() {
  update((s) => (s.wallet ? { ...s, wallet: undefined } : s));
}

/**
 * Replaces every envelope's deposits with the Stripe ledger entries from the wallet
 * summary, so Comparator, CostTable and the roadmap read real balances through
 * envelopeBalance(). Envelopes without wallet money end up with no deposits. The
 * general balance (money with no goal) is kept apart in `walletGeneral`; envelope
 * ids are UUIDs, so it never lands on a goal.
 */
export function syncEnvelopeLedger(summary: WalletSummary) {
  update((s) => {
    const walletGeneral = sanitizeGeneral(summary.envelopes[GENERAL_ENVELOPE_ID]?.balance);
    let changed = walletGeneral !== s.walletGeneral;
    const envelopes = s.envelopes.map((e) => {
      const ledger = summary.envelopes[e.id.toLowerCase()] ?? summary.envelopes[e.id];
      const deposits: Deposit[] = (ledger?.entries ?? []).map((entry) => ({
        date: todayISO(new Date(entry.date)), // the viewer's calendar date
        amount: round2(entry.amount),
        kind: entry.kind,
        ref: entry.id,
      }));
      if (JSON.stringify(deposits) === JSON.stringify(e.deposits)) return e;
      changed = true;
      return { ...e, deposits };
    });
    return changed ? { ...s, envelopes, walletGeneral } : s;
  });
}

export function removeEnvelope(id: string) {
  update((s) => ({ ...s, envelopes: s.envelopes.filter((e) => e.id !== id) }));
}

/**
 * `premiumSession` is the Stripe Checkout Session id of a test-mode Premium purchase,
 * kept so "Turn off Premium" can cancel that subscription. Cleared for any other state.
 */
export function setPremium(premium: PremiumState, premiumSession?: string) {
  const session = premium === "paid" ? premiumSession : undefined;
  update((s) =>
    s.premium === premium && s.premiumSession === session ? s : { ...s, premium, premiumSession: session },
  );
}

export interface InsightsAnalysis {
  source: InsightsSummary["source"];
  classifier: InsightsSummary["classifier"];
  months: InsightsMonth[];
}

/**
 * Keeps an analysis summary in this browser (never the file). An upload merges
 * into earlier uploads by month, the newer copy of a month replacing the older;
 * the sample, or the first upload after the sample, replaces what was there.
 * Returns the stored summary (undefined when nothing usable came in).
 */
/**
 * Upload merge, one entry per month: a newer copy of a month replaces the saved one unless it
 * covers fewer days (a partial month in a later file must not erase a full one).
 */
function mergeMonths(saved: InsightsMonth[], incoming: InsightsMonth[]): InsightsMonth[] {
  const byMonth = new Map(saved.map((m) => [m.month, m] as const));
  for (const m of incoming) {
    const existing = byMonth.get(m.month);
    if (!existing || m.days >= existing.days) byMonth.set(m.month, m);
  }
  return [...byMonth.values()];
}

export function setInsights(analysis: InsightsAnalysis): InsightsSummary | undefined {
  let saved: InsightsSummary | undefined;
  update((s) => {
    const prev = s.insights;
    const merge = analysis.source === "upload" && prev?.source === "upload";
    const next = sanitizeInsights({
      version: 1,
      source: analysis.source,
      analyzedAt: new Date().toISOString(),
      classifier: merge && prev?.classifier === "rules+llm" ? "rules+llm" : analysis.classifier,
      months: merge ? mergeMonths(prev?.months ?? [], analysis.months) : analysis.months,
    });
    saved = next;
    return next ? { ...s, insights: next } : s;
  });
  return saved;
}

/** Deletes the saved spending summary from this browser. */
export function clearInsights() {
  update((s) => (s.insights ? { ...s, insights: undefined } : s));
}

// ---------------------------------------------------------------------------
// Social profile (/profile): name, bio, quote and cover in AppState; the photos
// under their own key (PROFILE_MEDIA_KEY) so the main state stays small.
// ---------------------------------------------------------------------------

const EMPTY_SOCIAL: ProfileSocial = Object.freeze({ displayName: "", bio: "", cover: "auto" }) as ProfileSocial;

/** The /profile fields, with defaults when nothing was set yet. */
export function socialOf(state: AppState): ProfileSocial {
  return state.social ?? EMPTY_SOCIAL;
}

/** Changes name, bio, quote or cover (sanitized like the rest of the state). */
export function updateSocial(patch: Partial<ProfileSocial>) {
  update((s) => {
    const next = sanitizeSocial({ ...EMPTY_SOCIAL, ...s.social, ...patch });
    return next ? { ...s, social: next } : s;
  });
}

/** JPEG/PNG/WebP data URLs only, at most ~1.5 MB of text each. */
const MAX_MEDIA_CHARS = 1_500_000;
const MEDIA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const EMPTY_MEDIA: ProfileMedia = Object.freeze({}) as ProfileMedia;

function sanitizeMediaUrl(v: unknown): string | undefined {
  return isString(v) && v.length <= MAX_MEDIA_CHARS && MEDIA_URL_RE.test(v) ? v : undefined;
}

function sanitizeMedia(raw: unknown): ProfileMedia {
  if (!raw || typeof raw !== "object") return EMPTY_MEDIA;
  const r = raw as Record<string, unknown>;
  const avatar = sanitizeMediaUrl(r.avatar);
  const cover = sanitizeMediaUrl(r.cover);
  if (!avatar && !cover) return EMPTY_MEDIA;
  return { ...(avatar ? { avatar } : {}), ...(cover ? { cover } : {}) };
}

const mediaListeners = new Set<Listener>();
let mediaCache: ProfileMedia | null = null;
let listeningToMedia = false;

function readMedia(): ProfileMedia {
  if (!canUseDOM()) return EMPTY_MEDIA;
  try {
    const raw = window.localStorage.getItem(PROFILE_MEDIA_KEY);
    return raw ? sanitizeMedia(JSON.parse(raw)) : EMPTY_MEDIA;
  } catch {
    return EMPTY_MEDIA; // storage blocked or corrupted JSON
  }
}

function getMediaSnapshot(): ProfileMedia {
  if (mediaCache === null) mediaCache = readMedia();
  return mediaCache;
}

function getMediaServerSnapshot(): ProfileMedia {
  return EMPTY_MEDIA;
}

function emitMedia() {
  for (const listener of Array.from(mediaListeners)) listener();
}

function onMediaStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== PROFILE_MEDIA_KEY) return;
  mediaCache = readMedia(); // another tab changed it
  emitMedia();
}

function subscribeMedia(listener: Listener): () => void {
  mediaListeners.add(listener);
  if (!listeningToMedia && canUseDOM()) {
    window.addEventListener("storage", onMediaStorage);
    listeningToMedia = true;
  }
  return () => {
    mediaListeners.delete(listener);
    if (mediaListeners.size === 0 && listeningToMedia) {
      window.removeEventListener("storage", onMediaStorage);
      listeningToMedia = false;
    }
  };
}

/** Profile photos (avatar, uploaded cover). Server render and hydration see none. */
export function useProfileMedia(): ProfileMedia {
  return useSyncExternalStore(subscribeMedia, getMediaSnapshot, getMediaServerSnapshot);
}

/**
 * Replaces the stored photos (leave a field out to remove that photo). Returns false when
 * the browser refused to store them (storage full or blocked): they still show for this visit.
 */
export function setProfileMedia(next: ProfileMedia): boolean {
  const clean = sanitizeMedia(next);
  let stored = true;
  if (canUseDOM()) {
    try {
      if (clean === EMPTY_MEDIA) window.localStorage.removeItem(PROFILE_MEDIA_KEY);
      else window.localStorage.setItem(PROFILE_MEDIA_KEY, JSON.stringify(clean));
    } catch {
      stored = false;
    }
  }
  mediaCache = clean;
  emitMedia();
  return stored;
}

/** Clears everything Livento stored in this browser (state and profile photos). */
export function resetAll() {
  if (canUseDOM()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(PROFILE_MEDIA_KEY);
    } catch {
      // ignore
    }
  }
  cache = freshState();
  mediaCache = EMPTY_MEDIA;
  emit();
  emitMedia();
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/**
 * USD held for an envelope in the Livento wallet (never below 0). Only entries synced
 * from the Stripe ledger (they carry a `ref`) count; old hand-logged amounts don't.
 */
export function envelopeBalance(env: Envelope): number {
  const sum = env.deposits.reduce((total, d) => total + (d.ref && Number.isFinite(d.amount) ? d.amount : 0), 0);
  return Math.max(0, round2(sum));
}

/** USD held across all envelopes in the wallet. */
export function totalSetAside(envelopes: Envelope[]): number {
  return round2(envelopes.reduce((total, e) => total + envelopeBalance(e), 0));
}

/** USD in the whole wallet: every envelope plus the general balance (money with no goal). */
export function walletTotal(state: AppState): number {
  return round2(totalSetAside(state.envelopes) + (state.walletGeneral ?? 0));
}

export interface GoalCoverage {
  own: number; // added to this goal itself (by card or auto-save)
  fromWallet: number; // the part of the wallet's general balance counted toward it
  covered: number; // own + fromWallet
}

/**
 * Money added without a goal still counts toward goals: the wallet's general balance covers
 * goals in order of their deadlines (soonest first), up to each goal's target.
 */
export function goalCoverage(state: AppState): Map<string, GoalCoverage> {
  let available = Math.max(0, state.walletGeneral ?? 0);
  const out = new Map<string, GoalCoverage>();
  const byDeadline = [...state.envelopes].sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
  for (const env of byDeadline) {
    const own = envelopeBalance(env);
    const fromWallet = round2(Math.min(Math.max(0, env.target - own), available));
    available = round2(available - fromWallet);
    out.set(env.id, { own, fromWallet, covered: round2(own + fromWallet) });
  }
  return out;
}

/** What a goal has toward its target: its own money plus its share of the general balance. */
export function goalBalance(state: AppState, env: Envelope): number {
  return goalCoverage(state).get(env.id)?.covered ?? envelopeBalance(env);
}

/** General wallet money not counted toward any goal yet. */
export function walletUnassigned(state: AppState): number {
  let used = 0;
  for (const c of goalCoverage(state).values()) used += c.fromWallet;
  return round2(Math.max(0, (state.walletGeneral ?? 0) - used));
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
