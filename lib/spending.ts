/**
 * Spending summary (spec §6, FR-11). Parses a bank CSV in memory (never
 * stored), puts each purchase in a spending category with merchant rules and
 * aggregates by calendar month. Nothing is judged here: on the Insights screen
 * the user picks what they'd spend less on. The LLM step (merchants the rules
 * don't know) is orchestrated by the route; this module stays deterministic.
 */
import Papa from "papaparse";
import type { InsightsMonth } from "./types";

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_ROWS = 5_000;
/** Latest months kept in one response (the browser keeps the same number). */
export const MAX_MONTHS = 36;
const TOP_MERCHANTS_PER_MONTH = 10;

export const SPEND_CATEGORIES = [
  "Food delivery",
  "Coffee",
  "Online shopping",
  "App stores & in-app",
  "Subscriptions & streaming",
  "Convenience stores",
  "Rideshare",
  "Groceries",
  "Bills & rent",
  "Gas & transit",
  "Restaurants",
  "Shopping",
  "Other",
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export interface Txn {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // USD, positive = money spent
  kind: "spend" | "income" | "transfer";
}

export interface ClassifiedTxn extends Txn {
  merchant: string; // cleaned display name
  category: SpendCategory;
  ruleMatched: boolean;
}

// ---------------------------------------------------------------------------
// Merchant rules (order matters: specific before generic)
// ---------------------------------------------------------------------------

interface Rule {
  test: RegExp;
  name?: string;
  category: SpendCategory;
}

const TRANSFER =
  /\b(transfer|xfer|zelle|venmo|cash ?app|payment thank you|online payment|credit card payment|card payment|autopay|auto pay|atm|cash withdrawal|wire|paypal transfer|to savings|from savings)\b/i;
const INCOME = /\b(payroll|direct dep|salary|paycheck|interest paid|tax refund)\b/i;

const RULES: Rule[] = [
  // Food delivery
  { test: /uber\s*\*?\s*eats|ubereats/i, name: "Uber Eats", category: "Food delivery" },
  { test: /doordash|\bdd \*/i, name: "DoorDash", category: "Food delivery" },
  { test: /grubhub/i, name: "Grubhub", category: "Food delivery" },
  { test: /postmates/i, name: "Postmates", category: "Food delivery" },
  { test: /seamless/i, name: "Seamless", category: "Food delivery" },
  { test: /caviar/i, name: "Caviar", category: "Food delivery" },
  { test: /gopuff/i, name: "Gopuff", category: "Food delivery" },
  // Subscriptions (before generic Amazon / Apple / Google)
  { test: /amazon prime|prime video|primevideo|amzn prime/i, name: "Amazon Prime", category: "Subscriptions & streaming" },
  { test: /netflix/i, name: "Netflix", category: "Subscriptions & streaming" },
  { test: /spotify/i, name: "Spotify", category: "Subscriptions & streaming" },
  { test: /\bhulu\b/i, name: "Hulu", category: "Subscriptions & streaming" },
  { test: /disney ?plus|disney\+/i, name: "Disney+", category: "Subscriptions & streaming" },
  { test: /\bhbo\b|max\.com/i, name: "Max", category: "Subscriptions & streaming" },
  { test: /youtube ?premium|youtube ?tv|google \*youtube/i, name: "YouTube", category: "Subscriptions & streaming" },
  { test: /paramount/i, name: "Paramount+", category: "Subscriptions & streaming" },
  { test: /peacock/i, name: "Peacock", category: "Subscriptions & streaming" },
  { test: /audible/i, name: "Audible", category: "Subscriptions & streaming" },
  { test: /patreon/i, name: "Patreon", category: "Subscriptions & streaming" },
  { test: /siriusxm|sirius xm/i, name: "SiriusXM", category: "Subscriptions & streaming" },
  { test: /planet fitness|\bgym\b|fitness|equinox|orangetheory/i, category: "Subscriptions & streaming" },
  // App stores & in-app
  { test: /apple\.com\/bill|itunes|app store|apple services/i, name: "Apple.com/bill", category: "App stores & in-app" },
  { test: /google \*?play|google play/i, name: "Google Play", category: "App stores & in-app" },
  { test: /steampowered|steam games|steam purchase|\bsteam\b/i, name: "Steam", category: "App stores & in-app" },
  { test: /playstation|sony interactive/i, name: "PlayStation", category: "App stores & in-app" },
  { test: /xbox|microsoft \*store/i, name: "Xbox / Microsoft Store", category: "App stores & in-app" },
  { test: /nintendo/i, name: "Nintendo", category: "App stores & in-app" },
  { test: /roblox/i, name: "Roblox", category: "App stores & in-app" },
  // Online shopping
  { test: /walmart\.com/i, name: "Walmart.com", category: "Online shopping" },
  { test: /target\.com/i, name: "Target.com", category: "Online shopping" },
  { test: /amzn mktp|amazon mktpl|amazon marketplace/i, name: "Amazon Marketplace", category: "Online shopping" },
  { test: /amazon|amzn/i, name: "Amazon", category: "Online shopping" },
  { test: /\betsy\b/i, name: "Etsy", category: "Online shopping" },
  { test: /\bebay\b/i, name: "eBay", category: "Online shopping" },
  { test: /\bshein\b/i, name: "Shein", category: "Online shopping" },
  { test: /\btemu\b/i, name: "Temu", category: "Online shopping" },
  { test: /aliexpress/i, name: "AliExpress", category: "Online shopping" },
  { test: /wish\.com/i, name: "Wish", category: "Online shopping" },
  // Coffee
  { test: /starbucks/i, name: "Starbucks", category: "Coffee" },
  { test: /dunkin/i, name: "Dunkin'", category: "Coffee" },
  { test: /peet'?s/i, name: "Peet's Coffee", category: "Coffee" },
  { test: /dutch bros/i, name: "Dutch Bros", category: "Coffee" },
  { test: /tim hortons/i, name: "Tim Hortons", category: "Coffee" },
  { test: /blue bottle/i, name: "Blue Bottle", category: "Coffee" },
  { test: /caribou coffee/i, name: "Caribou Coffee", category: "Coffee" },
  { test: /\bcoffee\b|\bespresso\b|\bcafe\b/i, category: "Coffee" },
  // Convenience stores
  { test: /7-eleven|7 eleven|7eleven/i, name: "7-Eleven", category: "Convenience stores" },
  { test: /\bwawa\b/i, name: "Wawa", category: "Convenience stores" },
  { test: /sheetz/i, name: "Sheetz", category: "Convenience stores" },
  { test: /circle k/i, name: "Circle K", category: "Convenience stores" },
  { test: /walgreens/i, name: "Walgreens", category: "Convenience stores" },
  { test: /\bcvs\b/i, name: "CVS", category: "Convenience stores" },
  { test: /duane reade/i, name: "Duane Reade", category: "Convenience stores" },
  { test: /quiktrip|kwik trip|racetrac|royal farms|casey'?s/i, category: "Convenience stores" },
  // Rideshare
  { test: /\blyft\b/i, name: "Lyft", category: "Rideshare" },
  { test: /\buber\b/i, name: "Uber", category: "Rideshare" },
  // Groceries
  { test: /trader joe/i, name: "Trader Joe's", category: "Groceries" },
  { test: /whole foods|wholefds/i, name: "Whole Foods", category: "Groceries" },
  { test: /jewel/i, name: "Jewel-Osco", category: "Groceries" },
  { test: /instacart/i, name: "Instacart", category: "Groceries" },
  {
    test: /kroger|safeway|publix|\baldi\b|costco|h-e-b|\bheb\b|wegmans|food lion|stop & shop|giant eagle|giant food|sprouts|mariano|ralphs|\bvons\b|albertsons|meijer|harris teeter|winco|hy-vee|shoprite|fresh market|grocery|supermarket/i,
    category: "Groceries",
  },
  // Bills & rent
  {
    test: /\brent\b|landlord|property mg|apartments?\b|\bapts\b|mortgage|comed|con ?ed|pg&e|duke energy|electric|utility|utilities|\bwater\b|sewer|peoples gas|nicor|xfinity|comcast|spectrum|cox comm|verizon|at&t|\batt\b|t-mobile|tmobile|internet|wireless|insurance|geico|state farm|progressive|allstate|lemonade|navient|nelnet|sallie mae|student loan/i,
    category: "Bills & rent",
  },
  // Gas & transit
  {
    test: /\bshell\b|chevron|exxon|mobil\b|\bbp\b|marathon|sunoco|valero|citgo|\barco\b|speedway|phillips 66|conoco|ventra|\bcta\b|\bmta\b|metrocard|\bbart\b|clipper|wmata|septa|amtrak|parking|parkwhiz|spothero|\btoll|e-?zpass|ipass|fastrak/i,
    category: "Gas & transit",
  },
  // Restaurants
  {
    test: /chipotle|sweetgreen|mcdonald|taco bell|chick-fil-a|panera|subway|wendy|burger king|pizza|pizzeria|restaurant|grill|kitchen|portillo|shake shack|five guys|domino|papa john|sushi|taqueria|bbq|diner|bistro|tavern|\bpub\b|brewery|steakhouse|noodle|ramen|wingstop|popeyes|\bkfc\b|in-n-out|culver|jimmy john|jersey mike|qdoba|\bcava\b|olive garden|applebee|chili'?s|ihop|denny/i,
    category: "Restaurants",
  },
  // In-store retail
  {
    test: /target|walmart|best buy|home depot|lowe'?s|ikea|tj ?maxx|marshalls|ross stores|old navy|\bgap\b|h&m|zara|\bnike\b|macy'?s|nordstrom|sephora|ulta|kohl'?s|dollar general|dollar tree|family dollar|staples|office depot|petco|petsmart|michaels|hobby lobby|uniqlo/i,
    category: "Shopping",
  },
];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const lower = (s: unknown) => norm(s).toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parses common US bank date formats; returns ISO date and (optional) hour. */
export function parseDate(raw: unknown): { iso: string; hour?: number } | null {
  const s = norm(raw);
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const iso = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { iso, hour: m[4] !== undefined ? Number(m[4]) : undefined } : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?/.exec(s);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (a > 12 && b <= 12) [a, b] = [b, a]; // DD/MM fallback
    const iso = validYmd(Number(m[3]), a, b);
    if (!iso) return null;
    let hour = m[4] !== undefined ? Number(m[4]) : undefined;
    if (hour !== undefined && m[6]) {
      const pm = m[6].toLowerCase() === "pm";
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return { iso, hour };
  }
  if (/[a-z]/i.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      const iso = validYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
      return iso ? { iso } : null;
    }
  }
  return null;
}

/** "$1,234.56", "(12.00)", "-12", "12.00-", "12.00 CR" → signed number, or null. */
export function parseMoney(raw: unknown): number | null {
  let s = norm(raw);
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\s*cr$/i.test(s)) s = s.replace(/\s*cr$/i, "");
  else if (/\s*dr$/i.test(s)) {
    sign = -sign;
    s = s.replace(/\s*dr$/i, "");
  }
  if (s.includes("-")) {
    sign = -sign;
    s = s.replace(/-/g, "");
  }
  s = s.replace(/^usd/i, "").replace(/[$\s,+]/g, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? sign * n : null;
}

interface ColumnMap {
  date: number;
  desc: number;
  amount: number;
  debit: number;
  credit: number;
  type: number;
}

function findHeader(rows: string[][]): { index: number; map: ColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(lower);
    const pick = (re: RegExp, exclude: number[] = []) => cells.findIndex((c, j) => !exclude.includes(j) && re.test(c));
    let date = pick(/^(transaction|trans\.?) date$/);
    if (date < 0) date = pick(/\bdate\b/);
    if (date < 0) continue;
    let desc = pick(/description/, [date]);
    if (desc < 0) desc = pick(/merchant|payee|\bname\b/, [date]);
    if (desc < 0) desc = pick(/memo|details|narrative|^transaction$/, [date]);
    const amount = pick(/amount/, [date]);
    const debit = pick(/debit|withdrawal|money out|paid out|outflow/, [date, amount]);
    const credit = pick(/credit|deposit|money in|paid in|inflow/, [date, amount, debit]);
    const type = pick(/^(transaction )?type$|^debit\/credit$|^credit\/debit$/, [date, desc, amount]);
    if (amount >= 0 || debit >= 0 || credit >= 0) {
      return { index: i, map: { date, desc, amount, debit: amount >= 0 ? -1 : debit, credit: amount >= 0 ? -1 : credit, type } };
    }
  }
  return null;
}

/** Headerless exports (e.g. date,amount,*,,description): infer columns from the data. */
function inferColumns(rows: string[][]): ColumnMap | null {
  const sample = rows.slice(0, 25);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const share = (col: number, fn: (v: string) => boolean) =>
    sample.filter((r) => r[col] !== undefined && fn(r[col])).length / Math.max(1, sample.length);
  let date = -1;
  let amount = -1;
  for (let c = 0; c < width; c++) {
    if (date < 0 && share(c, (v) => parseDate(v) !== null) >= 0.8) {
      date = c;
      continue;
    }
    if (amount < 0 && share(c, (v) => parseMoney(v) !== null) >= 0.8) amount = c;
  }
  if (date < 0 || amount < 0) return null;
  let desc = -1;
  let bestLen = 0;
  for (let c = 0; c < width; c++) {
    if (c === date || c === amount) continue;
    const len = sample.reduce((sum, r) => sum + (parseMoney(r[c]) === null ? norm(r[c]).length : 0), 0);
    if (len > bestLen) {
      bestLen = len;
      desc = c;
    }
  }
  return { date, desc, amount, debit: -1, credit: -1, type: -1 };
}

export interface ParsedStatement {
  txns: Txn[];
  rowsParsed: number;
  warnings: string[];
}

/** CSV text → normalized transactions (spend positive). Never throws on bad rows. */
export function parseStatement(csv: string): ParsedStatement {
  const warnings: string[] = [];
  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  let rows = (parsed.data ?? []).filter((r): r is string[] => Array.isArray(r) && r.some((c) => norm(c)));
  if (rows.length === 0) return { txns: [], rowsParsed: 0, warnings: ["The file has no rows we could read."] };

  const header = findHeader(rows);
  let map: ColumnMap | null;
  if (header) {
    map = header.map;
    rows = rows.slice(header.index + 1);
  } else {
    map = inferColumns(rows);
    if (!map) {
      return {
        txns: [],
        rowsParsed: 0,
        warnings: ["We couldn't find date and amount columns. Export a CSV with Date, Description and Amount columns."],
      };
    }
  }

  if (rows.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS.toLocaleString("en-US")} rows were analyzed.`);
    rows = rows.slice(0, MAX_ROWS);
  }

  interface Raw {
    date: string;
    description: string;
    signed: number; // as exported (single amount column) or spend-negative (debit/credit)
    typeHint?: "debit" | "credit";
  }
  const raws: Raw[] = [];
  let skipped = 0;
  for (const r of rows) {
    const d = parseDate(r[map.date]);
    const description = map.desc >= 0 ? norm(r[map.desc]).slice(0, 200) : "";
    let signed: number | null = null;
    let typeHint: Raw["typeHint"];
    if (map.amount >= 0) {
      signed = parseMoney(r[map.amount]);
      if (map.type >= 0) {
        const t = lower(r[map.type]);
        if (t.includes("debit") || t === "dr" || t.includes("withdraw")) typeHint = "debit";
        else if (t.includes("credit") || t === "cr" || t.includes("deposit")) typeHint = "credit";
      }
    } else {
      const debit = parseMoney(r[map.debit]);
      const credit = parseMoney(r[map.credit]);
      if (debit !== null && Math.abs(debit) > 0) signed = -Math.abs(debit);
      else if (credit !== null && Math.abs(credit) > 0) signed = Math.abs(credit);
      else if (debit !== null || credit !== null) signed = 0;
    }
    if (!d || signed === null) {
      skipped++;
      continue;
    }
    if (signed === 0) continue;
    raws.push({ date: d.iso, description: description || "Unknown", signed, typeHint });
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} row${skipped === 1 ? "" : "s"} without a readable date or amount.`);
  }

  // Sign convention: most exports show spend as negative. If most amounts are
  // positive and there is no debit/credit information, positives are spend
  // (typical of credit-card exports).
  const unhinted = map.amount >= 0 ? raws.filter((r) => !r.typeHint) : [];
  const positives = unhinted.filter((r) => r.signed > 0).length;
  const positiveIsSpend = unhinted.length > 0 && positives / unhinted.length > 0.6;
  if (positiveIsSpend) warnings.push("Positive amounts were treated as spending (credit-card style export).");

  const txns: Txn[] = raws.map((r) => {
    let isSpend: boolean;
    if (r.typeHint) isSpend = r.typeHint === "debit";
    else isSpend = positiveIsSpend ? r.signed > 0 : r.signed < 0;
    const amount = round2(Math.abs(r.signed));
    let kind: Txn["kind"] = isSpend ? "spend" : "income";
    if (TRANSFER.test(r.description)) kind = "transfer";
    else if (isSpend && INCOME.test(r.description)) kind = "income";
    return { date: r.date, description: r.description, amount, kind };
  });

  return { txns, rowsParsed: raws.length, warnings };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/&])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\b(Llc|Inc|Co)\b/g, (w) => w.toUpperCase());
}

/** Readable merchant name without store numbers, card digits or processor prefixes. */
export function cleanMerchant(description: string): string {
  let s = norm(description);
  s = s.replace(/^(pos|debit card|debit|checkcard|check card|purchase|recurring|visa|card)\b\s*(purchase\s*)?(authorized on \d{1,2}\/\d{1,2}\s*)?/i, "");
  s = s.replace(/^(sq|tst|sp|pp|py|ls)\s*\*\s*/i, "");
  s = s.replace(/^paypal\s*\*\s*/i, "");
  s = s.replace(/\*.*$/, "");
  s = s.replace(/#\s*\d+.*$/, "");
  s = s.replace(/\b\d{3,}.*$/, "");
  s = s.replace(/[^A-Za-z0-9&'.\- ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = norm(description).replace(/\d{3,}/g, "").trim() || "Unknown";
  return titleCase(s).slice(0, 40);
}

/** Category per cleaned merchant name, for merchants the rules don't know. */
export type LlmCategoryMap = ReadonlyMap<string, SpendCategory>;

/** Applies merchant rules; an optional LLM map (by cleaned merchant name) fills merchants the rules don't know. */
export function classifyTxns(txns: Txn[], llm?: LlmCategoryMap | null): ClassifiedTxn[] {
  return txns.map((t) => {
    const rule = RULES.find((r) => r.test.test(t.description));
    const merchant = rule?.name ?? cleanMerchant(t.description);
    const category: SpendCategory = rule?.category ?? llm?.get(merchant) ?? "Other";
    return { ...t, merchant, category, ruleMatched: Boolean(rule) };
  });
}

/** Unmatched spend merchants (by total spent), for one LLM batch call. */
export function unmatchedMerchants(classified: ClassifiedTxn[], limit = 60): string[] {
  const totals = new Map<string, number>();
  for (const t of classified) {
    if (t.kind !== "spend" || t.ruleMatched) continue;
    totals.set(t.merchant, (totals.get(t.merchant) ?? 0) + t.amount);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from one "YYYY-MM-DD" to another, both included. */
function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export interface MonthsSummary {
  months: InsightsMonth[];
  coveredDays: number; // days the kept months cover
  truncated: boolean; // true when older months were dropped (MAX_MONTHS)
}

/**
 * Spending per calendar month; income and transfers are left out. A month is
 * listed when the file has any row in it. `days` is how much of that month
 * the file covers (from its first to its last row), so partial months can be
 * labeled and monthly averages stay honest.
 */
export function summarizeMonths(classified: ClassifiedTxn[]): MonthsSummary {
  if (classified.length === 0) return { months: [], coveredDays: 0, truncated: false };
  const dates = classified.map((t) => t.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];

  const byMonth = new Map<string, ClassifiedTxn[]>();
  for (const t of classified) {
    const key = t.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    if (t.kind === "spend") list.push(t);
    byMonth.set(key, list);
  }

  const keys = [...byMonth.keys()].sort();
  const kept = keys.slice(-MAX_MONTHS);
  const months: InsightsMonth[] = kept.map((month) => {
    const spend = byMonth.get(month) ?? [];
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${pad2(daysInMonth(month))}`;
    const days = daysInclusive(first > monthStart ? first : monthStart, last < monthEnd ? last : monthEnd);
    const byCategory: Record<string, number> = {};
    const merchants = new Map<string, { amount: number; count: number }>();
    let spendTotal = 0;
    for (const t of spend) {
      spendTotal += t.amount;
      byCategory[t.category] = (byCategory[t.category] ?? 0) + t.amount;
      if (t.category === "Bills & rent") continue; // the merchant list leaves out bills and rent (said in the UI)
      const m = merchants.get(t.merchant) ?? { amount: 0, count: 0 };
      m.amount += t.amount;
      m.count += 1;
      merchants.set(t.merchant, m);
    }
    for (const k of Object.keys(byCategory)) byCategory[k] = round2(byCategory[k]);
    const topMerchants = [...merchants.entries()]
      .map(([name, v]) => ({ name, amount: round2(v.amount), count: v.count }))
      .sort((x, y) => y.amount - x.amount)
      .slice(0, TOP_MERCHANTS_PER_MONTH);
    return { month, days, spendTotal: round2(spendTotal), count: spend.length, byCategory, topMerchants };
  });

  const coveredDays = months.reduce((sum, m) => sum + m.days, 0);
  return { months, coveredDays, truncated: kept.length < keys.length };
}
