import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE = "https://generativelanguage.googleapis.com";

/**
 * GET /api/cron/ai-check — operator diagnostics for the Gemini backup (Bearer CRON_SECRET).
 * Lists the Flash models this key can use and times a tiny request on a few of them.
 * Returns only model names, HTTP status, latency and the API's own error text (never the key).
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return json({ ok: false, message: "GEMINI_API_KEY is not set" });
  const redact = (s: string) => s.split(key).join("[redacted]").slice(0, 300);
  const headers = { "content-type": "application/json", "x-goog-api-key": key };

  let models: string[] = [];
  try {
    const res = await fetch(`${BASE}/v1beta/models?pageSize=200`, { headers, signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    models = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""))
      .filter((n) => /flash|pro/i.test(n));
  } catch {
    // listing is best effort
  }

  const url = new URL(request.url);
  const wanted = (url.searchParams.get("models") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => /^[a-z0-9][a-z0-9.-]{1,80}$/i.test(m));
  const candidates = [...new Set([process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash", ...wanted])].slice(0, 6);

  const checks = await Promise.all(
    candidates.map(async (model) => {
      const started = Date.now();
      try {
        const res = await fetch(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }],
            generationConfig: { maxOutputTokens: 256 },
          }),
          signal: AbortSignal.timeout(25_000),
        });
        const text = await res.text();
        return { model, status: res.status, ms: Date.now() - started, body: res.ok ? text.slice(0, 160) : redact(text) };
      } catch (err) {
        return { model, status: 0, ms: Date.now() - started, body: err instanceof Error ? err.name : "error" };
      }
    }),
  );
  return json({ ok: true, models, checks }, 200, { "Cache-Control": "no-store" });
}
