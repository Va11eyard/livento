/**
 * Google Gemini (server-only): the backup AI provider, used when Claude is
 * unavailable (no ANTHROPIC_API_KEY, or it just failed for account reasons; see
 * lib/llm.ts claudeUsable).
 *
 * - REST `POST /v1beta/models/{model}:generateContent` through fetch (no SDK).
 *   The key travels only in the `x-goog-api-key` header: never in a URL, a log
 *   line or an error message.
 * - Model `gemini-3.8-flash` (stable, has a free tier; function calling,
 *   Grounding with Google Search and structured outputs). `GEMINI_MODEL`
 *   overrides it.
 * - `GEMINI_API_BASE` is honoured only for loopback hosts (local mock tests);
 *   everything else goes to https://generativelanguage.googleapis.com.
 * - One deadline per call (timeout + optional caller AbortSignal) and typed
 *   errors (GeminiError) whose message is safe to log.
 */
import { z } from "zod";

export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash"; // 3.8-flash timed out (>25 s) on this key on 2026-11-15; 3.6 answered in ~1 s
const DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function geminiModel(): string {
  const raw = process.env.GEMINI_MODEL?.trim().replace(/^models\//, "");
  return raw && /^[a-z0-9][a-z0-9.-]{1,80}$/i.test(raw) ? raw : GEMINI_DEFAULT_MODEL;
}

function baseUrl(): string {
  const raw = process.env.GEMINI_API_BASE?.trim();
  if (!raw) return DEFAULT_BASE;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if ((u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(host)) return u.origin;
  } catch {
    // not a URL: use the real API
  }
  return DEFAULT_BASE;
}

// ---------------------------------------------------------------------------
// Request and response shapes (the subset Livento uses)
// ---------------------------------------------------------------------------

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

export interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[]; webSearchQueries?: string[] };
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: Record<string, unknown>[];
  toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE" } };
  generationConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GeminiErrorKind =
  | "off" // no key
  | "timeout"
  | "network"
  | "auth" // bad key or no access (400 API key invalid, 401, 403)
  | "not_found" // unknown model
  | "rate_limit" // 429, including a free tier without a quota for the feature
  | "server" // 5xx
  | "bad_request" // other 4xx
  | "bad_response";

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status?: number;
  constructor(kind: GeminiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    this.status = status;
  }
}

function kindFor(status: number, apiStatus: string, apiMessage: string): GeminiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 && (/API key/i.test(apiMessage) || apiStatus === "UNAUTHENTICATED")) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

/** For logs: kind, status and the API's own message (which never contains the key). */
export function describeGeminiError(err: unknown): string {
  if (err instanceof GeminiError) return `${err.name} ${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.name;
  return "unknown error";
}

// ---------------------------------------------------------------------------
// generateContent
// ---------------------------------------------------------------------------

/** One generateContent call. Throws GeminiError; never logs or returns the key. */
export async function generateContent(
  body: GeminiRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GeminiResponse> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new GeminiError("off", "GEMINI_API_KEY is not set");
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const redact = (s: string) => s.split(key).join("[redacted]").slice(0, 400);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl()}/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    text = await res.text();
  } catch {
    if (signal.aborted) throw new GeminiError("timeout", "The Gemini request timed out or was cancelled");
    throw new GeminiError("network", "Could not reach the Gemini API");
  }

  if (!res.ok) {
    let apiStatus = "";
    let apiMessage = "";
    try {
      const error = (JSON.parse(text) as { error?: { status?: unknown; message?: unknown } }).error;
      apiStatus = typeof error?.status === "string" ? error.status : "";
      apiMessage = typeof error?.message === "string" ? error.message : "";
    } catch {
      // not JSON
    }
    throw new GeminiError(
      kindFor(res.status, apiStatus, apiMessage),
      redact(`${res.status} ${apiStatus} ${apiMessage}`.trim()),
      res.status,
    );
  }
  try {
    return JSON.parse(text) as GeminiResponse;
  } catch {
    throw new GeminiError("bad_response", "Gemini returned a response that isn't JSON");
  }
}

/** The answer text of the first candidate (thought summaries skipped). */
export function geminiText(res: GeminiResponse): string {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .map((p) => (typeof p.text === "string" && !p.thought ? p.text : ""))
    .join("");
}

const BLOCKED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/** True when Gemini blocked the prompt or stopped its answer for safety reasons (treated as a refusal). */
export function geminiBlocked(res: GeminiResponse): boolean {
  return Boolean(res.promptFeedback?.blockReason) || BLOCKED_FINISH.has(res.candidates?.[0]?.finishReason ?? "");
}

/** thinkingConfig for Gemini 3+ models (low / medium / high: `minimal` isn't accepted by every model). */
export function thinking(level: "low" | "medium" | "high"): { thinkingConfig?: { thinkingLevel: string } } {
  return /^gemini-[3-9]/.test(geminiModel()) ? { thinkingConfig: { thinkingLevel: level } } : {};
}

// ---------------------------------------------------------------------------
// Schemas: zod → the JSON-schema subset Gemini accepts
// ---------------------------------------------------------------------------

// Accepted both in functionDeclarations[].parameters (OpenAPI subset) and responseJsonSchema.
// Dropped: $schema, additionalProperties, minLength/maxLength, pattern, default, format…
const KEEP = new Set(["type", "description", "enum", "properties", "required", "items", "minimum", "maximum", "minItems", "maxItems"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEEP.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, strip(schema)]));
    } else {
      out[key] = key === "items" ? strip(value) : value;
    }
  }
  return out;
}

export function geminiSchema(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Structured output (quotes, picks wording, roadmap wording, merchant categories)
// ---------------------------------------------------------------------------

export interface GeminiStructuredCall<S extends z.ZodType> {
  label: string;
  schema: S;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  effort?: "low" | "medium";
}

/** One JSON-schema request; the zod-validated object, or null on any failure (logged without the key). */
export async function geminiStructured<S extends z.ZodType>(call: GeminiStructuredCall<S>): Promise<z.infer<S> | null> {
  try {
    const res = await generateContent(
      {
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: "user", parts: [{ text: call.user }] }],
        generationConfig: {
          // Thinking tokens count toward the limit, so leave room for them.
          maxOutputTokens: Math.max(call.maxTokens, 4_096),
          responseMimeType: "application/json",
          responseJsonSchema: geminiSchema(call.schema),
          ...thinking(call.effort ?? "low"),
        },
      },
      { timeoutMs: call.timeoutMs, signal: call.signal },
    );
    if (geminiBlocked(res)) return null;
    const text = geminiText(res).trim();
    if (!text) return null;
    const parsed = call.schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn(`[gemini] ${call.label} failed: ${describeGeminiError(err)}`);
    return null;
  }
}
