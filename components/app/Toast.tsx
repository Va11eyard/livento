"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import styles from "./Toast.module.css";

type Notify = (title: string, description?: string) => void;

interface ToastItem {
  id: number;
  title: string;
  description?: string;
}

const ToastContext = createContext<Notify>(() => {});

let toastSeq = 0;

/** Radix Toast provider. Toasts are announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback<Notify>((title, description) => {
    toastSeq += 1;
    const id = toastSeq;
    setItems((prev) => [...prev.slice(-2), { id, title, description }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      <ToastPrimitive.Provider duration={4500} swipeDirection="right" label="Notification">
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            className={styles.toast}
            onOpenChange={(open) => {
              if (!open) remove(item.id);
            }}
          >
            <div className={styles.text}>
              <ToastPrimitive.Title className={styles.title}>{item.title}</ToastPrimitive.Title>
              {item.description ? (
                <ToastPrimitive.Description className={styles.description}>{item.description}</ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close className={styles.close} aria-label="Dismiss notification">
              <span aria-hidden="true">×</span>
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className={styles.viewport} />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** `const notify = useToast(); notify("Envelope created")`. */
export function useToast(): Notify {
  return useContext(ToastContext);
}
