"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { sendTelegramPicks } from "@/components/app/TelegramLinkCatcher";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { ClientApiError, errorMessage, telegramLink } from "@/lib/client-api";
import { clearTelegram } from "@/lib/storage";
import type { Profile, TelegramLink } from "@/lib/types";
import styles from "./profile.module.css";

type Status = { tone: "ok" | "error"; text: string };

/** "Telegram connected as …": send picks, open the chat, or disconnect (the bot unpins the profile). */
export function TelegramConnected({ telegram, profile }: { telegram: TelegramLink; profile: Profile }) {
  const notify = useToast();
  const [busy, setBusy] = useState<null | "picks" | "unlink">(null);
  const [status, setStatus] = useState<Status | null>(null);
  const handle = telegram.username ? `@${telegram.username}` : "";

  async function sendPicks() {
    if (busy) return;
    setBusy("picks");
    setStatus(null);
    setStatus(await sendTelegramPicks(telegram, profile));
    setBusy(null);
  }

  async function disconnect() {
    if (busy) return;
    setBusy("unlink");
    setStatus(null);
    try {
      await telegramLink({ action: "unlink", token: telegram.token });
      clearTelegram();
      notify("Telegram disconnected", "The bot removed your pinned Livento profile. Send /start there to connect again.");
    } catch (err) {
      // A link the server no longer accepts has nothing left to disconnect.
      if (err instanceof ClientApiError && err.status === 401) clearTelegram();
      else setStatus({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.telegram}>
      <p className={styles.telegramStatus}>
        Telegram connected as{" "}
        <strong>
          {telegram.name || handle || "your account"}
          {telegram.name && handle ? ` (${handle})` : ""}
        </strong>{" "}
        <span className={styles.telegramCheck} aria-hidden="true">
          ✓
        </span>
      </p>
      <div className={ui.actions}>
        <button
          type="button"
          className="pill small"
          aria-disabled={busy !== null || undefined}
          onClick={() => void sendPicks()}
        >
          {busy === "picks" ? "Sending…" : "Send my picks to Telegram"}
        </button>
        {telegram.bot ? (
          <a
            className="pill small alt"
            href={`https://t.me/${encodeURIComponent(telegram.bot)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open chat<span className="sr-only"> (opens Telegram in a new tab)</span> <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        <ConfirmDialog
          triggerLabel={busy === "unlink" ? "Disconnecting…" : "Disconnect"}
          triggerClassName="pill small alt"
          triggerAriaLabel="Disconnect Telegram"
          title="Disconnect Telegram?"
          description="The bot unpins your Livento profile and stops sending picks to that chat. Everything on this site stays."
          confirmLabel="Disconnect"
          cancelLabel="Keep it"
          onConfirm={() => void disconnect()}
        />
      </div>
      <div aria-live="polite">
        {status ? <p className={status.tone === "error" ? ui.error : ui.status}>{status.text}</p> : null}
      </div>
    </div>
  );
}
