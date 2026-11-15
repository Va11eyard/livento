/**
 * Event preview images (server-only): the Open Graph image of an event's own page
 * (`og:image`, else `twitter:image`), the same thing link previews show. Nothing
 * else from the page is used or kept.
 *
 * - https pages and https images only, public host names only (no IPs, no localhost);
 *   redirects are followed by hand (at most 3) and every hop is checked.
 * - One GET with a 3 s timeout for the whole fetch; reads at most the first ~250 KB
 *   of HTML and stops at `</head>`.
 * - Every answer is cached per page URL in lib/kv for 30 days, "none" included, so a
 *   page is fetched once a month at most. Timeouts, 429 and 5xx are kept 6 hours.
 *   A per-instance memory copy saves the KV round trips on warm instances.
 * Never throws: a failure just means "no preview image" (cards use the local photo).
 */
import { createHash } from "node:crypto";
import { kvGet, kvSet } from "./kv";

const TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 250_000;
const MAX_REDIRECTS = 3;
const MAX_IMAGE_URL = 2_000; // EventSchema.image limit
const TTL_SECONDS = 30 * 86_400;
const RETRY_TTL_SECONDS = 6 * 3_600;
const MEMORY_CAP = 2_000;
const USER_AGENT = "Mozilla/5.0 (compatible; LinkPreview/1.0)";
const META_KEYS = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];

interface Stored {
  i: string | null; // image URL, or null = the page has none
}
interface Answer {
  image: string | null;
  ttl: number;
}

const memory = new Map<string, { image: string | null; expiresAt: number }>();
const running = new Map<string, Promise<string | null>>();

const cacheKey = (pageUrl: string) => `ogimg:v1:${createHash("sha256").update(pageUrl).digest("hex").slice(0, 32)}`;

function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || h.startsWith("[") || /^\d+(\.\d+){3}$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

/** An absolute https URL on a public host, or undefined. */
function safeHttpsUrl(raw: string, base?: string): string | undefined {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "https:" || !isPublicHost(u.hostname) || u.username || u.password) return undefined;
    const s = u.toString();
    return s.length <= MAX_IMAGE_URL ? s : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] !== "#") return ENTITIES[k] ?? m;
    const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** The first usable og:image / twitter:image in the HTML, resolved against the page URL. */
function findPreview(html: string, pageUrl: string): string | null {
  const found = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.trim().toLowerCase();
    const content = attr(tag, "content")?.trim();
    if (key && content && META_KEYS.includes(key) && !found.has(key)) found.set(key, content);
  }
  for (const key of META_KEYS) {
    const raw = found.get(key);
    const url = raw ? safeHttpsUrl(decodeEntities(raw), pageUrl) : undefined;
    if (url) return url;
  }
  return null;
}

/** Up to MAX_HTML_BYTES of the body, stopping after `</head>`. */
async function readHead(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const from = Math.max(0, html.length - 8);
      html += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(html.slice(from))) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html.slice(0, MAX_HTML_BYTES);
}

async function fetchPreview(pageUrl: string): Promise<Answer> {
  const none: Answer = { image: null, ttl: TTL_SECONDS };
  const retry: Answer = { image: null, ttl: RETRY_TTL_SECONDS };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = safeHttpsUrl(pageUrl);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url, {
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        res.body?.cancel().catch(() => {});
        url = location ? safeHttpsUrl(location, url) : undefined;
        continue;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return res.status === 408 || res.status === 429 || res.status >= 500 ? retry : none;
      }
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html|xml/i.test(type)) {
        res.body?.cancel().catch(() => {});
        return none;
      }
      return { image: findPreview(await readHead(res), url), ttl: TTL_SECONDS };
    }
    return none;
  } catch {
    return retry; // timeout or network error
  }
}

function remember(pageUrl: string, image: string | null, ttlSeconds: number) {
  if (memory.size >= MEMORY_CAP) memory.clear();
  memory.set(pageUrl, { image, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** The cached answer only: an image URL, null (the page has none), or undefined (not looked up yet). */
export async function cachedPreviewImage(pageUrl: string): Promise<string | null | undefined> {
  const hit = memory.get(pageUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.image;
  try {
    const stored = await kvGet<Stored>(cacheKey(pageUrl));
    if (stored && (stored.i === null || typeof stored.i === "string")) {
      remember(pageUrl, stored.i, RETRY_TTL_SECONDS);
      return stored.i;
    }
  } catch {
    // KV unavailable: treat as not cached.
  }
  return undefined;
}

/** Fetches the page's preview image and caches the answer; joins a fetch already running. */
function fetchAndStore(pageUrl: string): Promise<string | null> {
  let task = running.get(pageUrl);
  if (!task) {
    task = (async () => {
      const answer = await fetchPreview(pageUrl);
      remember(pageUrl, answer.image, answer.ttl);
      await kvSet(cacheKey(pageUrl), { i: answer.image } satisfies Stored, answer.ttl).catch(() => {});
      return answer.image;
    })().finally(() => running.delete(pageUrl));
    running.set(pageUrl, task);
  }
  return task;
}

/** The page's Open Graph image (https), or null. Cached per page URL; never throws. */
export async function previewImage(pageUrl: string): Promise<string | null> {
  if (!safeHttpsUrl(pageUrl)) return null;
  const cached = await cachedPreviewImage(pageUrl);
  return cached !== undefined ? cached : fetchAndStore(pageUrl);
}

export interface PreviewBatch {
  /** Page URL → image URL, for the pages answered within the time box. */
  images: Map<string, string>;
  /** Fetches still running after the time box (each caches its answer), or null. */
  rest: Promise<void> | null;
}

/**
 * Preview images for many pages at once: cached answers for all of them, plus at
 * most `maxFetches` new page fetches in parallel, waiting at most `waitMs`.
 * Pages not answered in time are left for `rest` and show up on a later call.
 */
export async function previewImages(pageUrls: readonly string[], maxFetches = 12, waitMs = 1_200): Promise<PreviewBatch> {
  const images = new Map<string, string>();
  const unique = [...new Set(pageUrls)].filter((u) => safeHttpsUrl(u));
  if (unique.length === 0) return { images, rest: null };
  let fetches = 0;
  const all = Promise.all(
    unique.map(async (pageUrl) => {
      let image = await cachedPreviewImage(pageUrl);
      if (image === undefined && fetches < maxFetches) {
        fetches++;
        image = await fetchAndStore(pageUrl);
      }
      if (image) images.set(pageUrl, image);
    }),
  ).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    all.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(resolve, waitMs, false);
    }),
  ]);
  clearTimeout(timer);
  // A snapshot: answers arriving later are cached but don't change this response.
  return { images: new Map(images), rest: finished ? null : all };
}
