"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Avatar } from "@/app/profile/Avatar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { socialOf, useAppState, useHydrated, useProfileMedia } from "@/lib/storage";
import styles from "./AppNav.module.css";

const LINKS = [
  { href: "/discover", label: "Discover" },
  { href: "/envelopes", label: "Wallet" },
  { href: "/insights", label: "Insights" },
  { href: "/pricing", label: "Pricing" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  // Event and roadmap pages belong to the Discover flow.
  return href === "/discover" && (pathname.startsWith("/event/") || pathname.startsWith("/roadmap/"));
}

/** Fixed app header, same anatomy as the landing header (brand left, nav right, "Menu" below 992px). */
export function AppNav() {
  const pathname = usePathname() ?? "";
  const state = useAppState();
  const media = useProfileMedia();
  const hydrated = useHydrated();
  // The menu is open only for the path it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);
  const navId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenOn(null);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const premium = hydrated ? state.premium : "none";
  const isSample = hydrated && state.profile?.isSample === true;
  const hasProfile = hydrated && !!state.profile;

  const badges =
    isSample || premium !== "none" ? (
      <>
        {isSample ? (
          <span className="tag sample" title="You're using the fictional sample profile">
            Sample
          </span>
        ) : null}
        {premium !== "none" ? (
          <span className="tag premium" title={premium === "demo" ? "Premium demo unlock, no charge" : "Premium"}>
            {premium === "demo" ? "Premium demo" : "Premium"}
          </span>
        ) : null}
      </>
    ) : null;

  return (
    <header className={styles.header}>
      <div className={`wrap ${styles.bar}`}>
        <Link href="/" className={`brand ${styles.brand}`}>
          Livento
        </Link>
        <div className={styles.end}>
          {badges ? <span className={styles.badges}>{badges}</span> : null}
          <button
            ref={menuButton}
            type="button"
            className={styles.menu}
            aria-expanded={open}
            aria-controls={navId}
            onClick={() => setOpenOn(open ? null : pathname)}
          >
            {open ? "Close" : "Menu"}
          </button>
          <nav id={navId} aria-label="Main" className={`${styles.nav} ${open ? styles.open : ""}`}>
            {badges ? <span className={styles.navBadges}>{badges}</span> : null}
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={styles.link}
                aria-current={isActive(pathname, link.href) ? "page" : undefined}
                onClick={() => setOpenOn(null)}
              >
                {link.label}
              </Link>
            ))}
            <ThemeToggle className={styles.theme} />
            {hasProfile ? (
              <Link
                href="/profile"
                className={`${styles.link} ${styles.profile}`}
                aria-current={isActive(pathname, "/profile") ? "page" : undefined}
                onClick={() => setOpenOn(null)}
              >
                <Avatar src={media.avatar} name={socialOf(state).displayName} className={styles.chip} />
                Profile
              </Link>
            ) : (
              <Link href="/onboarding" className={`pill small ${styles.cta}`} onClick={() => setOpenOn(null)}>
                Start <span aria-hidden="true">↗</span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
