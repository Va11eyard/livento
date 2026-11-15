"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { errorMessage, isAbortError } from "@/lib/client-api";

export interface StickyAsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** Data loaded for the previous key, to keep showing while the new key loads. */
  stale?: T;
}

/** components/app/useAsync plus `stale`: Discover re-ranks when web results arrive without blanking the picks. */
export function useStickyAsync<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): StickyAsyncState<T> {
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
  return {
    data: current?.data,
    error: current?.error,
    loading: key !== null && current === null,
    stale: current === null ? result?.data : undefined,
  };
}
