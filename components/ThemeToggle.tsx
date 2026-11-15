"use client";

import { useLayoutEffect } from "react";
import { applyTheme, currentTheme, savedTheme, saveTheme } from "@/lib/theme";

/**
 * Light / night switch for the app and landing headers. Both labels are rendered and CSS shows the
 * one that applies (`.theme-toggle` in app/globals.css), so the label is right before hydration.
 * The visible word is the theme it switches to: "Night" on the light theme, "Light" at night.
 */
export function ThemeToggle({ className }: { className?: string }) {
  // React's dev-mode remount resets <html> attributes set by the inline <head> script: put the
  // saved theme back before paint. A no-op in production.
  useLayoutEffect(() => {
    const saved = savedTheme();
    if (saved) applyTheme(saved);
  }, []);

  return (
    <button
      type="button"
      className={className ? `theme-toggle ${className}` : "theme-toggle"}
      onClick={() => saveTheme(currentTheme() === "dark" ? "light" : "dark")}
    >
      <span className="theme-to-dark">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.7 6.7 0 0 0 10.8 10.8z" />
        </svg>
        <span className="sr-only">Switch to </span>Night<span className="sr-only"> theme</span>
      </span>
      <span className="theme-to-light">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </svg>
        <span className="sr-only">Switch to </span>Light<span className="sr-only"> theme</span>
      </span>
    </button>
  );
}
