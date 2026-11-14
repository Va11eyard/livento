"use client";

import { useState, type InputHTMLAttributes } from "react";

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max">;

interface NumberInputProps extends BaseProps {
  value: number | undefined;
  /** Receives the parsed, clamped number, or undefined when the field is cleared. */
  onValueChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  /** Round to whole numbers. */
  integer?: boolean;
}

/**
 * Number field that lets people type freely: the raw text is kept while the
 * field has focus, the parent gets a clean number on every valid keystroke.
 */
export function NumberInput({ value, onValueChange, min, max, integer = false, onFocus, onBlur, ...rest }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined || !Number.isFinite(value) ? "" : String(value));

  return (
    <input
      {...rest}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      value={shown}
      onFocus={(event) => {
        setDraft(shown);
        onFocus?.(event);
      }}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() === "") {
          onValueChange(undefined);
          return;
        }
        let n = Number(text);
        if (!Number.isFinite(n)) return;
        if (integer) n = Math.round(n);
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        onValueChange(n);
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}
