import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  deleteAlert,
  emailConfigured,
  newAlertId,
  saveAlert,
  sendEmail,
  telegramConfigured,
  telegramStartUrl,
  welcomeEmail,
  type AlertRecord,
} from "@/lib/alerts";
import { apiError, json, parseBody, siteOrigin } from "@/lib/http";
import { isKvConfigured } from "@/lib/kv";
import { RATE_LIMITS, rateLimit } from "@/lib/ratelimit";
import { AlertSubscribeSchema } from "@/lib/schemas";
import type { AlertSubscribeResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const NOT_SAVED = "Nothing was saved.";

/** POST /api/alerts — subscribe by email or Telegram. Never pretends: `ok: false` + message when not configured. */
export async function POST(request: Request) {
  const limited = await rateLimit(request, "alerts", RATE_LIMITS.heavy);
  if (limited) return limited;
  const body = await parseBody(request, AlertSubscribeSchema, 16 * 1024);
  if (!body.ok) return body.response;
  const req = body.data;

  if (!isKvConfigured()) {
    return json<AlertSubscribeResponse>({
      ok: false,
      message: `Alerts aren't set up on this deployment yet (no storage is configured). ${NOT_SAVED}`,
    });
  }

  let address: string | undefined;
  if (req.channel === "email") {
    if (!emailConfigured()) {
      return json<AlertSubscribeResponse>({
        ok: false,
        message: `Email alerts aren't set up on this deployment yet. ${NOT_SAVED}`,
      });
    }
    address = req.address?.trim().toLowerCase();
    if (!address || !z.email().safeParse(address).success) {
      return apiError("Please enter a valid email address.", 400);
    }
  } else if (!telegramConfigured()) {
    return json<AlertSubscribeResponse>({
      ok: false,
      message: `Telegram alerts aren't set up on this deployment yet. ${NOT_SAVED}`,
    });
  }

  const rec: AlertRecord = {
    id: newAlertId(),
    channel: req.channel,
    ...(address ? { address } : {}),
    interests: req.interests,
    favourites: req.favourites,
    city: req.city || "Your city",
    ...(req.stateCode ? { stateCode: req.stateCode.toUpperCase() } : {}),
    createdAt: new Date().toISOString(),
    lastSentAt: null,
    sentIds: [],
  };

  try {
    await saveAlert(rec);
  } catch {
    return apiError("We couldn't save your alert right now. Please try again.", 503);
  }

  if (rec.channel === "email" && address) {
    const mail = welcomeEmail(rec, siteOrigin(request));
    const sent = await sendEmail(address, mail.subject, mail.html, mail.text);
    if (!sent) {
      await deleteAlert(rec.id).catch(() => undefined);
      return json<AlertSubscribeResponse>({
        ok: false,
        message: `We couldn't send email to that address right now. ${NOT_SAVED}`,
      });
    }
    return json<AlertSubscribeResponse>({
      ok: true,
      id: rec.id,
      message: `You're subscribed. We sent a confirmation to ${address}.`,
    });
  }

  return json<AlertSubscribeResponse>({
    ok: true,
    id: rec.id,
    telegramStartUrl: telegramStartUrl(rec.id),
    message: "Open the link in Telegram and tap Start to finish connecting.",
  });
}

/** GET /api/alerts?unsubscribe=<id> — one-click unsubscribe link used in emails. */
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, "alerts-unsub", RATE_LIMITS.general);
  if (limited) return limited;
  const id = request.nextUrl.searchParams.get("unsubscribe")?.trim();
  if (!id) return apiError("Missing unsubscribe id.", 400);
  if (isKvConfigured()) {
    try {
      await deleteAlert(id);
    } catch {
      return apiError("We couldn't process that right now. Please try again.", 503);
    }
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Livento</title></head><body style="font-family:Inter,Arial,sans-serif;color:#141414;max-width:560px;margin:15vh auto;padding:0 20px"><h1 style="font-size:28px">You're unsubscribed.</h1><p>Livento won't send you event alerts anymore.</p><p><a href="/" style="color:#141414">Back to Livento</a></p></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
