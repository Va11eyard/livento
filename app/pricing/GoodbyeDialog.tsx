"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import dialog from "@/components/app/ConfirmDialog.module.css";

interface GoodbyeDialogProps {
  /** Turns Premium off. Resolve `false` to keep the dialog open; pass the reason as `error`. */
  onTurnOff: () => Promise<boolean>;
  error?: string | null;
}

/** "Sad to see you go": confirms turning Premium off and says plainly what happens next. */
export function GoodbyeDialog({ onTurnOff, error }: GoodbyeDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const turnOff = async () => {
    setPending(true);
    const done = await onTurnOff();
    setPending(false);
    if (done) setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <Dialog.Trigger className="pill small alt">Turn off Premium</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialog.overlay} />
        <Dialog.Content className={dialog.content}>
          <Dialog.Title className={dialog.title}>Sad to see you go</Dialog.Title>
          <Dialog.Description className={dialog.description}>
            Premium turns off right away and nothing renews. Auto-save stops, and the money already in your wallet
            stays yours: you can withdraw it anytime.
          </Dialog.Description>
          {error ? (
            <p role="alert" className={dialog.error}>
              {error}
            </p>
          ) : null}
          <div className={dialog.actions}>
            <Dialog.Close className="pill" disabled={pending}>
              Keep Premium
            </Dialog.Close>
            <button type="button" className="pill alt" onClick={() => void turnOff()} disabled={pending}>
              {pending ? "Turning off…" : "Turn off Premium"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
