"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { categoryTotals, coveredDays, monthlyAverage } from "@/app/insights/plan";
import { askAssistant, assistantStatus, errorMessage } from "@/lib/client-api";
import { todayISO } from "@/lib/dates";
import { getAppState, goalBalance, newId, walletTotal } from "@/lib/storage";
import type { AppState, AssistantAction, AssistantChatMessage, AssistantContext } from "@/lib/types";
import styles from "./Assistant.module.css";
import ui from "./ui.module.css";

// ---------------------------------------------------------------------------
// Conversation store: sessionStorage, shared by the side panel and /assistant
// ---------------------------------------------------------------------------

const SESSION_KEY = "livento:assistant:v1";
const MAX_SENT = 20; // messages per request (API limit)
const MAX_CHARS = 2_000; // per message (API limit)
const MAX_KEPT = 40;
const OFF_TEXT = "The AI helper isn't connected on this deployment yet.";
const FOOTNOTE = "AI helper · not financial advice";

interface ChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions?: AssistantAction[];
}

interface ChatState {
  items: ChatItem[];
  pending: boolean;
  error: string | null;
  status: "unknown" | "checking" | "on" | "off";
  offMessage: string;
}

const SERVER_STATE: ChatState = { items: [], pending: false, error: null, status: "unknown", offMessage: "" };
let chat: ChatState | null = null;
const listeners = new Set<() => void>();

/** In-app paths ("/…") or https links only, as the server builds them. */
function isSafeAction(value: unknown): value is AssistantAction {
  if (!value || typeof value !== "object") return false;
  const { label, href, external } = value as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim() || typeof href !== "string" || typeof external !== "boolean") return false;
  return external ? href.startsWith("https://") : /^\/(?!\/)/.test(href);
}

function readItems(): ChatItem[] {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((value): ChatItem[] => {
        if (!value || typeof value !== "object") return [];
        const { id, role, text, actions } = value as Record<string, unknown>;
        if (typeof id !== "string" || (role !== "user" && role !== "assistant") || typeof text !== "string" || !text) {
          return [];
        }
        return [{ id, role, text: text.slice(0, MAX_CHARS), actions: Array.isArray(actions) ? actions.filter(isSafeAction) : undefined }];
      })
      .slice(-MAX_KEPT);
  } catch {
    return []; // blocked storage or a damaged entry: start a new chat
  }
}

function getChat(): ChatState {
  if (chat === null) chat = { ...SERVER_STATE, items: typeof window === "undefined" ? [] : readItems() };
  return chat;
}

function setChat(patch: Partial<ChatState>) {
  chat = { ...getChat(), ...patch };
  if (patch.items) {
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(patch.items.slice(-MAX_KEPT)));
    } catch {
      // Storage blocked or full: the chat still works for this page view.
    }
  }
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Server render and hydration see an empty chat; the browser's copy comes right after. */
function useChat(): ChatState {
  return useSyncExternalStore(subscribe, getChat, () => SERVER_STATE);
}

function checkStatus() {
  if (getChat().status !== "unknown") return;
  setChat({ status: "checking" });
  assistantStatus()
    .then((res) => setChat(res.off ? { status: "off", offMessage: res.message } : { status: "on" }))
    .catch(() => setChat({ status: "on" })); // can't tell: let the user ask; a failed answer explains itself
}

function eventIdFromPath(pathname: string): string | undefined {
  const match = /^\/(?:event|roadmap)\/([^/?#]+)/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]).slice(0, 200);
  } catch {
    return undefined;
  }
}

const cap = (n: number | undefined, max: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : undefined;

/** What the helper's calculators need from this browser's AppState (bounded like the API schema). */
function buildContext(state: AppState, pathname: string): AssistantContext {
  const p = state.profile;
  const months = state.insights?.months ?? [];
  return {
    today: todayISO(),
    profile: p
      ? {
          city: p.city.slice(0, 100),
          stateCode: p.stateCode?.slice(0, 10),
          lat: p.lat,
          lng: p.lng,
          radiusMiles: cap(p.radiusMiles, 5_000),
          interests: p.interests,
          favourites: p.favourites.slice(0, 20).map((f) => f.slice(0, 80)),
          monthlyFunBudget: cap(p.monthlyFunBudget, 1_000_000),
          hotelPerNight: cap(p.hotelPerNight, 100_000),
          travelPerTrip: cap(p.travelPerTrip, 100_000),
          vacationDaysLeft: cap(p.vacationDaysLeft, 366),
          preferredMonths: p.preferredMonths,
          isSample: p.isSample,
        }
      : undefined,
    envelopes: state.envelopes.slice(0, 30).map((e) => ({
      id: e.id,
      eventId: e.eventId,
      eventName: e.eventName.slice(0, 300),
      eventDate: e.eventDate,
      target: cap(e.target, 1_000_000) ?? 0,
      balance: cap(goalBalance(state, e), 1_000_000) ?? 0,
      deadline: e.deadline,
    })),
    walletTotal: cap(walletTotal(state), 10_000_000),
    spending:
      state.insights && months.length
        ? {
            source: state.insights.source,
            days: Math.min(1_200, coveredDays(months)),
            monthlyAverage: cap(monthlyAverage(months), 10_000_000),
            categories: categoryTotals(months)
              .slice(0, 30)
              .map((c) => ({ name: c.name.slice(0, 60), perMonth: cap(c.perMonth, 10_000_000) ?? 0 })),
          }
        : undefined,
    currentEventId: eventIdFromPath(pathname),
  };
}

/** The last ≤ 20 messages, starting with the user's. */
function requestMessages(items: ChatItem[]): AssistantChatMessage[] {
  const recent = items.slice(-MAX_SENT).map((i) => ({ role: i.role, content: i.text.slice(0, MAX_CHARS) }));
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent;
}

async function sendQuestion(text: string) {
  const current = getChat();
  const question = text.trim().slice(0, MAX_CHARS);
  if (!question || current.pending || current.status === "off") return;
  const items: ChatItem[] = [...current.items, { id: newId(), role: "user", text: question }];
  setChat({ items, pending: true, error: null });
  try {
    const res = await askAssistant({
      messages: requestMessages(items),
      context: buildContext(getAppState(), window.location.pathname),
    });
    if (res.off) {
      setChat({ items: current.items, pending: false, status: "off", offMessage: res.message });
      return;
    }
    setChat({
      pending: false,
      items: [...getChat().items, { id: newId(), role: "assistant", text: res.text, actions: res.actions.filter(isSafeAction) }],
    });
  } catch (err) {
    setChat({ pending: false, error: errorMessage(err, "Ask Livento couldn't answer just now. Please try again.") });
  }
}

function retryLast() {
  const { items, pending } = getChat();
  const last = items[items.length - 1];
  if (pending || !last || last.role !== "user") return;
  setChat({ items: items.slice(0, -1), error: null });
  void sendQuestion(last.text);
}

function clearChat() {
  if (!getChat().pending) setChat({ items: [], error: null });
}

const CHIPS = ["Afford a goal", "Something cheap this month", "Where can I cut?"] as const;

function chipQuestion(chip: (typeof CHIPS)[number]): string {
  if (chip === "Afford a goal") {
    if (eventIdFromPath(window.location.pathname)) return "How can I afford this event?";
    return getAppState().envelopes.length ? "How can I afford my goal on time?" : "How could I afford a goal?";
  }
  if (chip === "Something cheap this month") return "What's something cheap I could do this month?";
  return "Where could I cut back to save faster?";
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type Block = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

/** Plain text → paragraphs and "- " bullet lists (no HTML, no markdown links). */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    if (list.length) blocks.push({ kind: "ul", items: list });
    para = [];
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-•*]\s+(.+)$/.exec(line);
    if (!line) {
      flush();
    } else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return blocks;
}

function AnswerText({ text }: { text: string }) {
  return (
    <div className={styles.prose}>
      {toBlocks(text).map((block, i) =>
        block.kind === "p" ? (
          <p key={i}>{block.text}</p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function ActionLinks({ actions, onNavigate }: { actions: AssistantAction[]; onNavigate?: () => void }) {
  if (!actions.length) return null;
  return (
    <ul className={styles.actions} aria-label="Next steps">
      {actions.map((action) => (
        <li key={action.href}>
          {action.external ? (
            <a className="pill small alt" href={action.href} target="_blank" rel="noopener noreferrer">
              {action.label}
              <span className="sr-only"> (opens in a new tab)</span>{" "}
              <span className={styles.glyph} aria-hidden="true">
                ↗
              </span>
            </a>
          ) : (
            <Link className="pill small alt" href={action.href} onClick={onNavigate}>
              {action.label}{" "}
              <span className={styles.glyph} aria-hidden="true">
                →
              </span>
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

interface ChatProps {
  variant: "panel" | "page";
  /** Called when an in-app link is followed (the panel closes itself). */
  onNavigate?: () => void;
}

/** The conversation, suggestion chips, input and footnote. Used by the side panel and /assistant. */
export function AssistantChat({ variant, onNavigate }: ChatProps) {
  const state = useChat();
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { items, pending, error, status } = state;
  const ready = status === "on";

  useEffect(() => {
    checkStatus();
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [items.length, pending, error]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [draft, ready]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || pending) return;
    void sendQuestion(draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const last = items[items.length - 1];
  const canRetry = Boolean(error) && last?.role === "user" && !pending;

  return (
    <div className={`${styles.chat} ${variant === "panel" ? styles.panelChat : styles.pageChat}`}>
      {variant === "panel" || items.length ? (
        <div className={styles.toolbar}>
          {variant === "panel" ? (
            <Link href="/assistant" className={styles.toolLink} onClick={onNavigate}>
              Open full page
            </Link>
          ) : (
            <span />
          )}
          {items.length ? (
            <button type="button" className={styles.toolLink} onClick={clearChat} disabled={pending}>
              New chat
            </button>
          ) : null}
        </div>
      ) : null}

      <div ref={logRef} className={styles.log} role="log" aria-label="Conversation with Ask Livento" tabIndex={0}>
        {items.length === 0 ? (
          <div className={styles.intro}>
            <p className={styles.introTitle}>Ask about your goals, prices and spending.</p>
            <p className={styles.introText}>
              Answers use the Livento data saved in this browser. Every number comes from Livento&rsquo;s calculators.
            </p>
          </div>
        ) : null}
        {items.map((item) =>
          item.role === "user" ? (
            <div key={item.id} className={`${styles.msg} ${styles.user}`}>
              <span className="sr-only">You: </span>
              {item.text}
            </div>
          ) : (
            <div key={item.id} className={`${styles.msg} ${styles.assistant}`}>
              <span className="sr-only">Ask Livento: </span>
              <AnswerText text={item.text} />
              <ActionLinks actions={item.actions ?? []} onNavigate={onNavigate} />
            </div>
          ),
        )}
        {pending ? <div className={`${styles.msg} ${styles.assistant} ${styles.thinking}`}>Thinking…</div> : null}
      </div>

      {error ? (
        <div className={`${ui.notice} ${ui.noticeError}`} role="alert">
          <span className={ui.noticeLabel}>No answer</span>
          <p>{error}</p>
          {canRetry ? (
            <button type="button" className={ui.textButton} onClick={retryLast}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {status === "off" ? (
        <div className={ui.notice} role="status">
          <span className={ui.noticeLabel}>Not connected</span>
          <p>{state.offMessage || OFF_TEXT}</p>
        </div>
      ) : null}
      {status === "unknown" || status === "checking" ? (
        <p className={styles.status} role="status">
          Connecting…
        </p>
      ) : null}

      {ready ? (
        <>
          {items.length === 0 ? (
            <div className={styles.chips} role="group" aria-label="Suggested questions">
              {CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={ui.chip}
                  disabled={pending}
                  onClick={() => void sendQuestion(chipQuestion(chip))}
                >
                  {chip}
                </button>
              ))}
            </div>
          ) : null}
          <form className={styles.composer} onSubmit={submit}>
            <label className="sr-only" htmlFor={inputId}>
              Your question for Ask Livento
            </label>
            <textarea
              ref={inputRef}
              id={inputId}
              className={styles.input}
              rows={1}
              maxLength={MAX_CHARS}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about a goal, an event or your spending"
              enterKeyHint="send"
              autoComplete="off"
            />
            <button type="submit" className={`pill small ${styles.send}`} disabled={pending || !draft.trim()}>
              Send <span aria-hidden="true">↗</span>
            </button>
          </form>
        </>
      ) : null}

      <p className={styles.footnote}>{FOOTNOTE}</p>
    </div>
  );
}

/** Floating "Ask Livento" button and its Radix Dialog side panel. Mounted once in AppShell; hidden on /assistant. */
export function AssistantLauncher() {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  // Known before the first open, so the panel can show the input (or the "not connected" note) at once.
  useEffect(() => {
    checkStatus();
  }, []);
  if (pathname === "/assistant") return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={styles.launcher}>
        <span className={styles.launcherDot} aria-hidden="true" />
        Ask Livento
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.panel}
          onOpenAutoFocus={(event) => {
            const input = (event.currentTarget as HTMLElement | null)?.querySelector("textarea");
            if (input) {
              event.preventDefault();
              input.focus();
            }
          }}
        >
          <div className={styles.panelHead}>
            <div>
              <p className={styles.panelKicker}>AI helper</p>
              <Dialog.Title className={styles.panelTitle}>Ask Livento</Dialog.Title>
            </div>
            <Dialog.Close className={styles.close} aria-label="Close Ask Livento">
              <span aria-hidden="true">×</span>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Ask how to afford a goal, find something cheap or see where you could cut back. Numbers come from
            Livento&rsquo;s calculators.
          </Dialog.Description>
          <AssistantChat variant="panel" onNavigate={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
