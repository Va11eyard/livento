/**
 * Light / night theme. Tokens live in app/globals.css: `:root` is light, `:root[data-theme="dark"]`
 * is an explicit night choice, and with no choice the night tokens follow `prefers-color-scheme`.
 * The choice is saved in this browser only (localStorage), never sent anywhere.
 */

export type Theme = "light" | "dark";

export const THEME_KEY = "livento:theme";

/** Browser bar color per theme (the page background). */
export const THEME_COLOR: Record<Theme, string> = { light: "#ffffff", dark: "#111110" };

const META_ID = "lv-theme-color";

/**
 * Inline <head> script (app/layout.tsx): applies a saved choice before the first paint, so there is
 * no flash. Without a saved choice it does nothing and CSS follows the system setting.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t!=="light"&&t!=="dark")return;document.documentElement.setAttribute("data-theme",t);var m=document.createElement("meta");m.id=${JSON.stringify(META_ID)};m.name="theme-color";m.content=t==="dark"?${JSON.stringify(THEME_COLOR.dark)}:${JSON.stringify(THEME_COLOR.light)};document.head.prepend(m)}catch(e){}})()`;

export function savedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/** The theme on screen now: the saved choice, else the system setting. */
export function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Puts a theme on <html> and on the browser bar. The first theme-color meta in the document wins,
 * so this one (no media query) goes first in <head>, ahead of the per-scheme ones from the layout's
 * viewport export. React re-orders <head> on hydration, so it is moved back to the front each time.
 */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  let meta = document.getElementById(META_ID) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.id = META_ID;
    meta.name = "theme-color";
  }
  meta.content = THEME_COLOR[theme];
  if (document.head.firstElementChild !== meta) document.head.prepend(meta);
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies until the page is reloaded.
  }
}
