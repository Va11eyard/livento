import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiError, json, readJson, validate } from "@/lib/http";
import { categorizeMerchantsWithLLM, isLlmConfigured } from "@/lib/llm";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { InsightsRequestSchema } from "@/lib/schemas";
import {
  MAX_CSV_BYTES,
  MAX_MONTHS,
  classifyTxns,
  parseStatement,
  summarizeMonths,
  unmatchedMerchants,
} from "@/lib/spending";
import type { InsightsResponse } from "@/lib/types";

export const maxDuration = 30;

/** Below this many days the monthly averages are flagged as rough. */
const SHORT_STATEMENT_DAYS = 28;

/**
 * POST /api/insights — CSV text (read in the browser) or the labeled sample.
 * The CSV is parsed in memory and discarded: never stored, never logged. The
 * answer is a per-month spending summary; only the browser keeps it.
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
  const { csv, sample } = body.data;

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
      const llmMap = await categorizeMerchantsWithLLM(unmatched);
      if (llmMap) {
        classified = classifyTxns(parsed.txns, llmMap);
        classifier = "rules+llm";
      }
    }

    const { months, coveredDays, truncated } = summarizeMonths(classified);
    if (!months.some((m) => m.spendTotal > 0)) {
      return apiError("We found only income and transfers in that file, so there's no spending to show.", 422);
    }
    const warnings = [...parsed.warnings];
    if (truncated) warnings.push(`Only the latest ${MAX_MONTHS} months were kept.`);
    if (coveredDays < SHORT_STATEMENT_DAYS) {
      warnings.push(
        `This file covers ${coveredDays} day${coveredDays === 1 ? "" : "s"}, so the monthly figures are a rough estimate.`,
      );
    }

    return json<InsightsResponse>({
      months,
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
