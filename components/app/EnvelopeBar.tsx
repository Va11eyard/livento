"use client";

import * as Progress from "@radix-ui/react-progress";
import { usd, usd0 } from "./format";
import styles from "./EnvelopeBar.module.css";

interface EnvelopeBarProps {
  balance: number;
  target: number;
  /** Accessible name, e.g. "Set aside for Late-Night Jazz Trio". */
  label: string;
}

/** DESIGN.md progress: 10px surface track with ink outline, yellow fill with an ink edge, "$X of $Y" beside it. */
export function EnvelopeBar({ balance, target, label }: EnvelopeBarProps) {
  const ratio = target > 0 ? balance / target : balance > 0 ? 1 : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const text = `${usd(balance)} of ${usd0(target)}`;
  return (
    <div className={styles.meter}>
      <Progress.Root
        className={styles.track}
        value={Math.round(pct)}
        max={100}
        aria-label={label}
        getValueLabel={() => `${text} (${Math.round(ratio * 100)}%)`}
      >
        <Progress.Indicator className={styles.fill} style={{ transform: `translateX(-${100 - pct}%)` }} />
      </Progress.Root>
      <span className={styles.figure}>{text}</span>
    </div>
  );
}
