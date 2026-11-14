/**
 * Shared helpers for route handlers: JSON responses, safe body parsing and
 * zod validation that never echoes raw input or upstream errors.
 */
import type { z } from "zod";

export function json<T>(data: T, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/** `{ error }` with a short, plain sentence (the client may show it). */
export function apiError(message: string, status: number, headers?: Record<string, string>): Response {
  return json({ error: message }, status, headers);
}

/** Removes `null` values from objects (deep) so optional fields validate as undefined. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads a JSON body with a byte limit (413 above it, 400 when malformed). */
export async function readJson(request: Request, maxBytes: number): Promise<ParseResult<unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    return { ok: false, response: apiError("That request is too large.", 413) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: apiError("Could not read the request.", 400) };
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, response: apiError("That request is too large.", 413) };
  }
  if (!text.trim()) return { ok: false, response: apiError("The request body is empty.", 400) };
  try {
    return { ok: true, data: stripNulls(JSON.parse(text)) };
  } catch {
    return { ok: false, response: apiError("The request body is not valid JSON.", 400) };
  }
}

/** Validates with zod; on failure returns a 400 naming the first bad field only. */
export function validate<S extends z.ZodType>(schema: S, data: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const path = issue?.path?.length ? issue.path.map(String).join(".") : "request";
  const safePath = path.replace(/[^\w.\-]/g, "").slice(0, 80) || "request";
  return { ok: false, response: apiError(`Invalid request: check "${safePath}".`, 400) };
}

/** Read + validate in one step. */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes = 256 * 1024,
): Promise<ParseResult<z.infer<S>>> {
  const body = await readJson(request, maxBytes);
  if (!body.ok) return body;
  return validate(schema, body.data);
}

/** Absolute origin for links: NEXT_PUBLIC_SITE_URL when set, else the request's origin. */
export function siteOrigin(request?: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured && /^https?:\/\//.test(configured)) return configured;
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      // fall through
    }
  }
  return "http://localhost:3000";
}
