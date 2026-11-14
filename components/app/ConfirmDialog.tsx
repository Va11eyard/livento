"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  triggerLabel: string;
  triggerClassName?: string;
  /** Accessible name for the trigger when the visible label is ambiguous (e.g. "Delete"). */
  triggerAriaLabel?: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

/** Radix Dialog confirmation, styled per DESIGN.md (1px ink border, 32px padding, dim backdrop). */
export function ConfirmDialog({
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={triggerClassName} aria-label={triggerAriaLabel}>
        {triggerLabel}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content}>
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <Dialog.Description className={styles.description}>{description}</Dialog.Description>
          <div className={styles.actions}>
            <button
              type="button"
              className="pill"
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              {confirmLabel}
            </button>
            <Dialog.Close className="pill alt">{cancelLabel}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
