"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

/** Fixed landing header. Below 992px the links collapse behind a "Menu" toggle. */
export default function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);

  // Escape closes the open menu and returns focus to the toggle.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="site-header">
      <div className="wrap nav">
        <Link className="brand" href="/" aria-label="Livento home">
          Livento
        </Link>
        <button
          ref={menuRef}
          className="menu"
          type="button"
          aria-expanded={open}
          aria-controls="lv-links"
          onClick={() => setOpen((value) => !value)}
        >
          Menu
        </button>
        <nav id="lv-links" aria-label="Main navigation" className={open ? "open" : undefined}>
          <a href="#how" onClick={close}>
            How it works
          </a>
          <a href="#experiences" onClick={close}>
            Experiences
          </a>
          <a href="#pricing" onClick={close}>
            Pricing
          </a>
          <ThemeToggle />
          <Link href="/onboarding" onClick={close}>
            Start
          </Link>
        </nav>
      </div>
    </header>
  );
}
