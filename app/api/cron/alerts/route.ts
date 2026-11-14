import type { NextRequest } from "next/server";
import {
  ALERTS_INDEX,
  digestEmail,
  digestTelegram,
  emailConfigured,
  getAlert,
  listAlertIds,
  profileFromAlert,
  saveAlert,
  sendEmail,
  sendTelegram,
  telegramConfigured,
} from "@/lib/alerts";
import { findEvents } from "@/lib/catalog";
import { addDays, todayISO } from "@/lib/dates";
import { apiError, json, siteOrigin } from "@/lib/http";
import { isKvConfigured, kvSrem } from "@/lib/kv";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { scoreEvents } from "@/lib/score";
import type { EventsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIME_BUDGET_MS = 50_000;
const MAX_ALERTS = 500;
const PER_ALERT = 3;

/** GET /api/cron/alerts — daily job (Vercel Cron). Requires `Authorization: Bearer CRON_SECRET`. */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "cron-alerts", RATE_LIMITS.cron);
  if (limited) return limited;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return apiError("Unauthorized", 401);
  }
  if (!isKvConfigured()) return json({ sent: 0, checked: 0, note: "Storage is not configured" });

  const started = Date.now();
  const today = todayISO();
  const site = siteOrigin(request);
  const catalogByQuery = new Map<string, Promise<EventsResponse>>();
  let sent = 0;
  let checked = 0;

  let ids: string[];
  try {
    ids = (await listAlertIds()).slice(0, MAX_ALERTS);
  } catch {
    return apiError("Storage is unavailable right now.", 503);
  }

  for (const id of ids) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      const rec = await getAlert(id);
      if (!rec) {
        await kvSrem(ALERTS_INDEX, id);
        continue;
      }
      if (rec.channel === "telegram" && (!rec.chatId || !telegramConfigured())) continue;
      if (rec.channel === "email" && (!rec.address || !emailConfigured())) continue;
      checked++;

      const queryKey = JSON.stringify([rec.city.toLowerCase(), rec.stateCode ?? "", [...rec.interests].sort()]);
      let catalog = catalogByQuery.get(queryKey);
      if (!catalog) {
        catalog = findEvents(
          {
            city: rec.city,
            state: rec.stateCode,
            categories: rec.interests,
            radius: 50,
            from: today,
            to: addDays(today, 90),
          },
          today,
        );
        catalogByQuery.set(queryKey, catalog);
      }
      const { events } = await catalog;
      const already = new Set(rec.sentIds);
      const fresh = scoreEvents(profileFromAlert(rec), events.filter((e) => e.source !== "curated"), today)
        .filter((s) => !already.has(s.event.id))
        .slice(0, PER_ALERT)
        .map((s) => s.event);
      if (fresh.length === 0) continue;

      let ok = false;
      if (rec.channel === "telegram" && rec.chatId !== undefined) {
        ok = await sendTelegram(rec.chatId, digestTelegram(rec, fresh, site));
      } else if (rec.address) {
        const mail = digestEmail(rec, fresh, site);
        ok = await sendEmail(rec.address, mail.subject, mail.html, mail.text);
      }
      if (ok) {
        sent++;
        rec.lastSentAt = new Date().toISOString();
        rec.sentIds = [...fresh.map((e) => e.id), ...rec.sentIds].slice(0, 300);
        await saveAlert(rec);
      }
    } catch {
      console.warn("[cron/alerts] one alert failed");
    }
  }

  return json({ sent, checked });
}
