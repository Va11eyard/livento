/**
 * Tiny key-value store over the Upstash Redis REST API, with an in-memory
 * fallback when no Redis REST credentials are set. Accepts the Upstash names
 * (UPSTASH_REDIS_REST_URL / _TOKEN) and the names Vercel's Upstash integration
 * injects (KV_REST_API_URL / KV_REST_API_TOKEN).
 *
 * Server-only. The in-memory fallback lives per server instance (on serverless
 * each instance has its own copy) — fine for a demo, not for real persistence.
 * Upstash failures throw; callers decide whether to fail open or report.
 */

interface Expiring {
  expiresAt?: number; // epoch ms
}
interface MemString extends Expiring {
  value: string;
}
interface MemSet extends Expiring {
  members: Set<string>;
}
interface MemList extends Expiring {
  items: string[];
}
interface MemStore {
  strings: Map<string, MemString>;
  sets: Map<string, MemSet>;
  lists: Map<string, MemList>;
}

const MEM_LIST_CAP = 5_000;
const MEM_SWEEP_AT = 10_000;

const globalStore = globalThis as unknown as { __liventoKv?: MemStore };
const mem: MemStore = (globalStore.__liventoKv ??= {
  strings: new Map(),
  sets: new Map(),
  lists: new Map(),
});

const kvUrl = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim();
const kvToken = () => (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();

export function isKvConfigured(): boolean {
  return Boolean(kvUrl() && kvToken());
}

async function upstash<T>(command: (string | number)[]): Promise<T> {
  const base = kvUrl().replace(/\/+$/, "");
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kvToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command.map(String)),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  const data = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!res.ok || !data || typeof data.error === "string") {
    throw new Error(`KV ${String(command[0])} failed (HTTP ${res.status})`);
  }
  return data.result as T;
}

// ---------------------------------------------------------------------------
// In-memory helpers
// ---------------------------------------------------------------------------

function alive<T extends Expiring>(entry: T | undefined): T | undefined {
  if (!entry) return undefined;
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) return undefined;
  return entry;
}

function sweep(): void {
  const now = Date.now();
  for (const map of [mem.strings, mem.sets, mem.lists] as Map<string, Expiring>[]) {
    if (map.size < MEM_SWEEP_AT) continue;
    for (const [k, v] of map) if (v.expiresAt !== undefined && v.expiresAt <= now) map.delete(k);
  }
}

const ttlToExpiry = (ttlSeconds?: number) =>
  ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined;

// ---------------------------------------------------------------------------
// Public API (JSON values)
// ---------------------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | null> {
  let raw: string | null | undefined;
  if (isKvConfigured()) {
    raw = await upstash<string | null>(["GET", key]);
  } else {
    raw = alive(mem.strings.get(key))?.value;
  }
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const raw = JSON.stringify(value);
  if (isKvConfigured()) {
    const cmd: (string | number)[] = ["SET", key, raw];
    if (ttlSeconds && ttlSeconds > 0) cmd.push("EX", Math.round(ttlSeconds));
    await upstash(cmd);
    return;
  }
  sweep();
  mem.strings.set(key, { value: raw, expiresAt: ttlToExpiry(ttlSeconds) });
}

export async function kvDel(key: string): Promise<void> {
  if (isKvConfigured()) {
    await upstash(["DEL", key]);
    return;
  }
  mem.strings.delete(key);
  mem.sets.delete(key);
  mem.lists.delete(key);
}

/** INCR; sets the TTL when the counter is created (fixed window). */
export async function kvIncr(key: string, ttlSeconds?: number): Promise<number> {
  if (isKvConfigured()) {
    const n = Number(await upstash<number>(["INCR", key]));
    if (n === 1 && ttlSeconds) await upstash(["EXPIRE", key, Math.round(ttlSeconds)]);
    return n;
  }
  sweep();
  const current = alive(mem.strings.get(key));
  const n = (current ? Number(current.value) || 0 : 0) + 1;
  mem.strings.set(key, {
    value: String(n),
    expiresAt: current?.expiresAt ?? ttlToExpiry(ttlSeconds),
  });
  return n;
}

export async function kvExpire(key: string, ttlSeconds: number): Promise<void> {
  if (isKvConfigured()) {
    await upstash(["EXPIRE", key, Math.round(ttlSeconds)]);
    return;
  }
  const expiresAt = ttlToExpiry(ttlSeconds);
  const s = mem.strings.get(key);
  if (s) s.expiresAt = expiresAt;
  const set = mem.sets.get(key);
  if (set) set.expiresAt = expiresAt;
  const list = mem.lists.get(key);
  if (list) list.expiresAt = expiresAt;
}

export async function kvSadd(key: string, member: string): Promise<void> {
  if (isKvConfigured()) {
    await upstash(["SADD", key, member]);
    return;
  }
  const set = alive(mem.sets.get(key)) ?? { members: new Set<string>() };
  set.members.add(member);
  mem.sets.set(key, set);
}

export async function kvSrem(key: string, member: string): Promise<void> {
  if (isKvConfigured()) {
    await upstash(["SREM", key, member]);
    return;
  }
  alive(mem.sets.get(key))?.members.delete(member);
}

export async function kvSmembers(key: string): Promise<string[]> {
  if (isKvConfigured()) {
    const result = await upstash<string[] | null>(["SMEMBERS", key]);
    return Array.isArray(result) ? result.map(String) : [];
  }
  return [...(alive(mem.sets.get(key))?.members ?? [])];
}

/** LPUSH a JSON value; optional TTL (re)applied to the whole list. */
export async function kvLpush(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const raw = JSON.stringify(value);
  if (isKvConfigured()) {
    await upstash(["LPUSH", key, raw]);
    if (ttlSeconds) await upstash(["EXPIRE", key, Math.round(ttlSeconds)]);
    return;
  }
  sweep();
  const list = alive(mem.lists.get(key)) ?? { items: [] };
  list.items.unshift(raw);
  if (list.items.length > MEM_LIST_CAP) list.items.length = MEM_LIST_CAP;
  if (ttlSeconds) list.expiresAt = ttlToExpiry(ttlSeconds);
  mem.lists.set(key, list);
}
