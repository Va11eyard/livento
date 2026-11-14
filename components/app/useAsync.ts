"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { errorMessage, isAbortError } from "@/lib/client-api";

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Runs `load` whenever `key` changes (`null` = idle) and cancels the previous
 * request. Loading is derived from the key, so a retry is just a new key.
 */
export function useAsync<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): AsyncState<T> {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  const run = useEffectEvent(load);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      },
      (err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setResult({ key, error: errorMessage(err) });
      },
    );
    return () => controller.abort();
  }, [key]);

  const current = result !== null && result.key === key ? result : null;
  return { data: current?.data, error: current?.error, loading: key !== null && current === null };
}
