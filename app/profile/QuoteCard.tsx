"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { isAbortError, quoteForGoals } from "@/lib/client-api";
import { QUOTES, randomQuote } from "@/lib/quotes";
import { updateSocial } from "@/lib/storage";
import { PROFILE_LIMITS, type AppState, type Profile, type ProfileQuote, type ProfileSocial } from "@/lib/types";
import { defaultQuote } from "./social";
import styles from "./profile.module.css";

const SOURCE_LABELS: Record<ProfileQuote["source"], string> = {
  curated: "Picked by Livento",
  custom: "Written by you",
  ai: "Written by AI from your goals",
};

function curated(text: string, index: number | undefined): ProfileQuote {
  return index !== undefined && index >= 0 ? { text, source: "curated", index } : { text, source: "curated" };
}

/** "Your quote": a random curated line, your own words, or one about your goals (POST /api/quote). Saved in this browser. */
export function QuoteCard({ state, profile, social }: { state: AppState; profile: Profile; social: ProfileSocial }) {
  const notify = useToast();
  const id = useId();
  const quote = social.quote ?? defaultQuote(state.anonId);
  const currentIndex = quote.source === "curated" ? quote.index : undefined;

  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const writeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (writing) {
      textarea.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      writeButton.current?.focus();
    }
  }, [writing]);

  const newQuote = () => {
    if (pending) return;
    const next = randomQuote(currentIndex);
    updateSocial({ quote: curated(next.text, next.index) });
  };

  const aboutGoals = async () => {
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const res = await quoteForGoals(
        {
          goals: state.envelopes.slice(0, 5).map((e) => e.eventName.slice(0, 120)),
          interests: profile.interests,
          city: profile.city,
          name: social.displayName || undefined,
        },
        controller.signal,
      );
      const text = res.text.trim();
      if (res.source === "ai") {
        updateSocial({ quote: { text, source: "ai" } });
      } else {
        updateSocial({ quote: curated(text, QUOTES.indexOf(text)) });
        notify("Here's one of our quotes", "Quotes about your goals aren't available right now.");
      }
    } catch (err) {
      if (isAbortError(err)) return;
      const next = randomQuote(currentIndex);
      updateSocial({ quote: curated(next.text, next.index) });
      notify("Here's one of our quotes", "Quotes about your goals aren't available right now.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };

  const openWriter = () => {
    if (pending) return;
    setDraft(quote.source === "custom" ? quote.text : "");
    setWriting(true);
  };

  const closeWriter = () => {
    returnFocus.current = true;
    setWriting(false);
  };

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    updateSocial({ quote: { text, source: "custom" } });
    closeWriter();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeWriter();
    }
  };

  return (
    <section className={styles.quoteCard} aria-labelledby={`${id}-label`}>
      <h2 id={`${id}-label`} className={`kicker ${styles.label}`}>
        01 / Your quote
      </h2>
      <div aria-live="polite" aria-atomic="true">
        <figure className={styles.quoteFigure}>
          <blockquote className={styles.quoteText}>
            <p>
              <span>&ldquo;{quote.text}&rdquo;</span>
            </p>
          </blockquote>
          <figcaption className={ui.meta}>{pending ? "Writing a quote about your goals…" : SOURCE_LABELS[quote.source]}</figcaption>
        </figure>
      </div>

      {writing ? (
        <form className={styles.quoteForm} onSubmit={save}>
          <div className="field">
            <label htmlFor={`${id}-own`}>Your own quote</label>
            <textarea
              id={`${id}-own`}
              ref={textarea}
              rows={2}
              maxLength={PROFILE_LIMITS.quote}
              value={draft}
              placeholder="A line that keeps you going"
              aria-describedby={`${id}-count`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <p id={`${id}-count`} className="help">
              {draft.length}/{PROFILE_LIMITS.quote} characters. Saved only in this browser.
            </p>
          </div>
          <div className={ui.actions}>
            <button type="submit" className="pill small" disabled={!draft.trim()}>
              Save quote
            </button>
            <button type="button" className="pill small alt" onClick={closeWriter}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        // aria-disabled (not disabled) while a request runs, so the focused button keeps focus.
        <div className={ui.actions}>
          <button type="button" className="pill small" onClick={newQuote} aria-disabled={pending || undefined}>
            New quote
          </button>
          <button
            ref={writeButton}
            type="button"
            className="pill small alt"
            onClick={openWriter}
            aria-disabled={pending || undefined}
          >
            Write my own
          </button>
          <button
            type="button"
            className="pill small alt"
            onClick={() => void aboutGoals()}
            aria-disabled={pending || undefined}
          >
            {pending ? "Writing…" : "About my goals"}
          </button>
        </div>
      )}
    </section>
  );
}
