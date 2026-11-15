"use client";

import { useEffect } from "react";
import { ClientApiError, errorMessage, telegramLink } from "@/lib/client-api";
import { clearTelegram, getAppState, setTelegram } from "@/lib/storage";
import type { Profile, TelegramLink, TelegramLinkResponse } from "@/lib/types";
import { useToast } from "./Toast";

/**
 * The client side of the Telegram link (server: lib/telegram-link, POST /api/telegram/link).
 * The site learns that a chat is connected in one of three ways:
 * 1. "✓ Show on Livento" in the bot opens /profile?tg_link=<token>;
 * 2. opened as the bot's Mini App, Telegram passes its signed init data in #tgWebAppData;
 * 3. with storage, Connect Telegram returns a link id and this polls it until Start is tapped.
 */

type Notify = ReturnType<typeof useToast>;

const PENDING_KEY = "livento:tg-pending";
const POLL_MS = 3_000;
const POLL_FOR_MS = 3 * 60_000;

let notifyLatest: Notify | null = null;
let polling = false;
// Tokens and init data already sent on this page load (Strict Mode runs effects twice).
const handled = new Set<string>();

function remember(res: TelegramLinkResponse): boolean {
  if (!res.ok || !res.token) return false;
  setTelegram({ token: res.token, name: res.name, username: res.username, bot: res.bot });
  return true;
}

function connectedAs(res: Pick<TelegramLinkResponse, "name" | "username">): string | undefined {
  if (!res.name && !res.username) return undefined;
  const who = res.name ? `${res.name}${res.username ? ` (@${res.username})` : ""}` : `@${res.username}`;
  return `Connected as ${who}.`;
}

async function link(body: { token: string } | { initData: string }) {
  try {
    const res = await telegramLink({ action: "link", ...body });
    if (remember(res)) notifyLatest?.("Telegram connected ✓", connectedAs(res));
    else notifyLatest?.("Couldn't connect Telegram", res.message);
  } catch (err) {
    notifyLatest?.("Couldn't connect Telegram", errorMessage(err));
  }
}

/** The Telegram user id inside Mini App init data (to skip linking the same chat again). */
function miniAppUserId(initData: string): number | null {
  try {
    const user = JSON.parse(new URLSearchParams(initData).get("user") ?? "null") as { id?: unknown } | null;
    return typeof user?.id === "number" ? user.id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending link (storage only): poll every 3 s for up to 3 minutes, across pages and reloads
// ---------------------------------------------------------------------------

function readPending(): { linkId: string; until: number } | null {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? "null") as { linkId?: unknown; until?: unknown } | null;
    return typeof raw?.linkId === "string" && typeof raw.until === "number" ? { linkId: raw.linkId, until: raw.until } : null;
  } catch {
    return null;
  }
}

function clearPending(linkId: string) {
  try {
    if (readPending()?.linkId === linkId) window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollPendingLink() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      await sleep(POLL_MS);
      const pending = readPending();
      if (!pending) return;
      if (Date.now() > pending.until || getAppState().telegram) return clearPending(pending.linkId);
      try {
        const res = await telegramLink({ action: "status", linkId: pending.linkId });
        if (res.status === "linked" && remember(res)) {
          clearPending(pending.linkId);
          notifyLatest?.("Telegram connected ✓", connectedAs(res));
          return;
        }
        if (res.status === "expired") return clearPending(pending.linkId);
      } catch {
        // A network hiccup or a busy minute: try again on the next tick.
      }
    }
  } finally {
    polling = false;
  }
}

/** After Connect Telegram returned a link id: notice the Start by itself (any page, 3 minutes). */
export function watchTelegramLink(linkId: string) {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ linkId, until: Date.now() + POLL_FOR_MS }));
  } catch {
    return; // no session storage: the "✓ Show on Livento" button still finishes the link
  }
  void pollPendingLink();
}

/** "Send my picks": sends the site profile to the linked chat. Forgets a link the server rejects. */
export async function sendTelegramPicks(
  telegram: TelegramLink,
  profile: Profile,
): Promise<{ tone: "ok" | "error"; text: string }> {
  try {
    const res = await telegramLink({
      action: "picks",
      token: telegram.token,
      profile: { city: profile.city, stateCode: profile.stateCode, interests: profile.interests },
    });
    return { tone: res.ok ? "ok" : "error", text: res.message || (res.ok ? "Sent. Check Telegram." : "Couldn't send your picks.") };
  } catch (err) {
    if (err instanceof ClientApiError && err.status === 401) clearTelegram();
    return { tone: "error", text: errorMessage(err) };
  }
}

/** Mounted once in AppShell. Renders nothing. */
export function TelegramLinkCatcher() {
  const notify = useToast();

  useEffect(() => {
    notifyLatest = notify;
    return () => {
      if (notifyLatest === notify) notifyLatest = null;
    };
  }, [notify]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("tg_link");
    if (token) {
      // Out of the address bar (and history) right away; the request below finishes the link.
      // Next a tick later: the router patches history in its own (parent) effect, after this one.
      url.searchParams.delete("tg_link");
      setTimeout(() => window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`), 0);
      if (!handled.has(token)) {
        handled.add(token);
        void link({ token });
      }
    }

    const initData = new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData");
    if (initData && !handled.has(initData)) {
      handled.add(initData);
      const userId = miniAppUserId(initData);
      const linked = getAppState().telegram;
      if (!(userId !== null && linked?.token.startsWith(`${userId}.`))) void link({ initData });
    }

    if (readPending()) void pollPendingLink();
  }, []);

  return null;
}
