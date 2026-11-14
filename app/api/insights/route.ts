import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiError, json, readJson, validate } from "@/lib/http";
import {
  MAX_CSV_BYTES,
  classifyTxns,
  parseStatement,
  summarize,
  unmatchedMerchants,
} from "@/lib/impulse";
import { classifyMerchantsWithLLM, isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { InsightsRequestSchema } from "@/lib/schemas";
import type { InsightsResponse } from "@/lib/types";

export const maxDuration = 30;

/**
 * POST /api/insights — CSV text (read in the browser) or the labeled sample.
 * The CSV is parsed in memory and discarded: never stored, never logged.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "insights", RATE_LIMITS.heavy);
  if (limited) return limited;

  // JSON escaping can grow a 1 MB CSV a bit; the CSV itself is checked below.
  const raw = await readJson(request, Math.round(MAX_CSV_BYTES * 1.6));
  if (!raw.ok) {
    return raw.response.status === 413 ? apiError("That file is too large. The limit is 1 MB.", 413) : raw.response;
  }
  const body = validate(InsightsRequestSchema, raw.data);
  if (!body.ok) return body.response;
  const { csv, sample, goals } = body.data;

  let text: string;
  const isSample = sample === true;
  if (isSample) {
    try {
      text = await readFile(path.join(process.cwd(), "data", "sample-statement.csv"), "utf8");
    } catch {
      return apiError("The sample statement is unavailable right now.", 500);
    }
  } else {
    if (!csv || !csv.trim()) return apiError("Upload a CSV file or try the sample statement.", 400);
    if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) {
      return apiError("That file is too large. The limit is 1 MB.", 413);
    }
    text = csv;
  }

  try {
    const parsed = parseStatement(text);
    if (parsed.txns.length === 0) {
      return apiError(
        parsed.warnings[0] ?? "We couldn't read that file. Export a CSV with Date, Description and Amount columns.",
        422,
      );
    }

    let classified = classifyTxns(parsed.txns);
    let classifier: InsightsResponse["classifier"] = "rules";
    const unmatched = unmatchedMerchants(classified);
    if (unmatched.length > 0 && isLlmConfigured()) {
      const llmMap = await classifyMerchantsWithLLM(unmatched);
      if (llmMap) {
        classified = classifyTxns(parsed.txns, llmMap);
        classifier = "rules+llm";
      }
    }

    const summary = summarize(classified, goals);
    const warnings = [...parsed.warnings];
    if (summary.months.length === 0) warnings.push("No spending found — only income or transfers.");

    return json<InsightsResponse>({
      ...summary,
      rowsParsed: parsed.rowsParsed,
      classifier,
      isSample,
      warnings,
    });
  } catch (err) {
    console.error("[insights] failed", err instanceof Error ? err.name : "");
    return apiError("Insights are unavailable right now. Please try again.", 500);
  }
}
