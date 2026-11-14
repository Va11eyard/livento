"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";

/**
 * "Save a wish": a note the visitor downloads as livento-wish.txt.
 * Nothing is sent or stored; the text only exists in the browser until it is downloaded.
 */
export default function WishDialog() {
  const [open, setOpen] = useState(false);
  // The dialog is portalled into .lv-landing (not <body>) so the scoped landing styles apply.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  function onOpenChange(next: boolean) {
    if (next) setContainer(triggerRef.current?.closest<HTMLElement>(".lv-landing") ?? null);
    setOpen(next);
  }

  function save() {
    const field = fieldRef.current;
    if (!field) return;
    if (!field.value.trim()) {
      field.focus();
      return;
    }
    const url = URL.createObjectURL(new Blob([`Livento wish\n\n${field.value}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "livento-wish.txt";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button ref={triggerRef} type="button" className="pill alt">
          Save a wish <span aria-hidden="true">●</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="wish-overlay" />
        <Dialog.Content
          className="wish"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            fieldRef.current?.focus();
          }}
        >
          <Dialog.Close className="close" aria-label="Close">
            ×
          </Dialog.Close>
          <Dialog.Title>Save a wish</Dialog.Title>
          <Dialog.Description>
            Write it down and keep it. It downloads as a text file, and nothing is sent anywhere.
          </Dialog.Description>
          <label htmlFor="lv-wish">Something you want to go to?</label>
          <textarea id="lv-wish" ref={fieldRef} rows={6} placeholder="A show, a festival, a city, a month…" />
          <button type="button" className="pill" onClick={save}>
            Download wish <span aria-hidden="true">↓</span>
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
