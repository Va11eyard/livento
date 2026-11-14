"use client";

import * as Progress from "@radix-ui/react-progress";
import * as Slider from "@radix-ui/react-slider";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usd0 } from "@/components/app/format";
import { PageSkeleton } from "@/components/app/States";
import ui from "@/components/app/ui.module.css";
import { US_CITIES, findCity } from "@/lib/cities";
import { loadSampleProfile, setProfile, useAppState, useHydrated } from "@/lib/storage";
import { CATEGORIES, CATEGORY_LABELS, WEEKS_PER_MONTH, type Category, type City, type Profile } from "@/lib/types";
import styles from "./onboarding.module.css";

const STEPS = [
  { key: "interests", label: "Interests" },
  { key: "favourites", label: "Favourites" },
  { key: "city", label: "Home city" },
  { key: "radius", label: "Travel radius" },
  { key: "budget", label: "Fun budget" },
  { key: "hotel", label: "Hotel budget" },
  { key: "travel", label: "Travel cost" },
  { key: "vacation", label: "Vacation days" },
  { key: "months", label: "Best months" },
  { key: "review", label: "Review" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const IDEAS: Record<Category, string[]> = {
  music: ["indie rock", "jazz", "hip-hop", "country", "electronic"],
  theatre: ["musicals", "plays"],
  festivals: ["music festivals", "food festivals"],
  comedy: ["stand-up comedy", "improv"],
  sports: ["basketball", "baseball", "football", "soccer"],
  family: ["theme parks", "family shows"],
  cinema: ["film festivals", "classic film screenings"],
  experiences: ["national parks", "food tours"],
};

const MAX_FAVOURITES = 20;

interface CityChoice {
  name: string;
  state?: string;
  lat?: number;
  lng?: number;
}

interface Draft {
  interests: Category[];
  favourites: string[];
  city: CityChoice | null;
  cityQuery: string;
  radiusMiles: number;
  budget: string;
  hotel: string;
  travel: string;
  vacation: string;
  months: number[];
}

function cityLabel(c: CityChoice): string {
  return c.state ? `${c.name}, ${c.state}` : c.name;
}

function draftFrom(profile: Profile | undefined): Draft {
  if (!profile) {
    return {
      interests: [],
      favourites: [],
      city: null,
      cityQuery: "",
      radiusMiles: 30,
      budget: "150",
      hotel: "150",
      travel: "200",
      vacation: "10",
      months: [],
    };
  }
  const city: CityChoice = { name: profile.city, state: profile.stateCode, lat: profile.lat, lng: profile.lng };
  return {
    interests: profile.interests,
    favourites: profile.favourites,
    city,
    cityQuery: cityLabel(city),
    radiusMiles: Math.min(150, Math.max(5, Math.round(profile.radiusMiles / 5) * 5)),
    budget: String(profile.monthlyFunBudget),
    hotel: String(profile.hotelPerNight),
    travel: String(profile.travelPerTrip),
    vacation: String(profile.vacationDaysLeft),
    months: profile.preferredMonths.length === 12 ? [] : profile.preferredMonths,
  };
}

/** Parses a whole-ish dollar/day amount; null when empty or out of range. */
function parseAmount(text: string, max: number): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function filterCities(query: string): City[] {
  const [namePart = "", statePart = ""] = query.split(",");
  const q = normalizeName(namePart);
  const st = statePart.trim().toUpperCase();
  if (!q) return US_CITIES.slice(0, 8);
  const starts: City[] = [];
  const contains: City[] = [];
  for (const c of US_CITIES) {
    if (st && !c.state.toUpperCase().startsWith(st)) continue;
    const n = normalizeName(c.name);
    if (n.startsWith(q)) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  const alias = findCity(query);
  const list = [...starts, ...contains];
  if (alias && !list.some((c) => c.name === alias.name && c.state === alias.state)) list.unshift(alias);
  return list.slice(0, 8);
}

/** Resolves typed text to a known city, or a free-text city without coordinates. */
function resolveCity(query: string): CityChoice | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const known = findCity(trimmed);
  if (known) return { name: known.name, state: known.state, lat: known.lat, lng: known.lng };
  const [name, state] = trimmed.split(",").map((s) => s.trim());
  if (!name) return null;
  return { name, state: state && /^[a-z]{2}$/i.test(state) ? state.toUpperCase() : undefined };
}

// ---------------------------------------------------------------------------
// City combobox (ARIA 1.2 combobox + listbox)
// ---------------------------------------------------------------------------

interface CityComboboxProps {
  inputId: string;
  value: string;
  describedBy: string;
  invalid: boolean;
  onQueryChange: (text: string) => void;
  onSelect: (city: City) => void;
}

function CityCombobox({ inputId, value, describedBy, invalid, onQueryChange, onSelect }: CityComboboxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = filterCities(value);
  const expanded = open && matches.length > 0;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  const choose = (city: City) => {
    onSelect(city);
    setOpen(false);
  };

  return (
    <div className={styles.combo}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Start typing, e.g. Chicago"
        value={value}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive(Math.min(activeIndex + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
          } else if (event.key === "Enter" && expanded && matches[activeIndex]) {
            event.preventDefault();
            choose(matches[activeIndex]);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      {/* Kept in the DOM so aria-controls always points at an element. */}
      <ul id={listId} role="listbox" aria-label="Matching cities" className={styles.listbox} hidden={!expanded}>
        {matches.map((city, index) => (
          <li
            key={`${city.name}-${city.state}`}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            className={styles.option}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(city)}
          >
            {city.name}, {city.state}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

function Wizard() {
  const router = useRouter();
  const { profile: existing } = useAppState();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing));
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [favInput, setFavInput] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const skipFocus = useRef(true);
  const ids = useId();

  // Move focus to the new step's heading so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (skipFocus.current) {
      skipFocus.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const current: StepKey = STEPS[step].key;
  const total = STEPS.length;
  const isLast = step === total - 1;
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const errorId = `${ids}-error`;
  const helpId = `${ids}-help`;
  const fieldId = `${ids}-field`;

  const addFavourite = (raw: string) => {
    const value = raw.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!value) return;
    if (draft.favourites.length >= MAX_FAVOURITES) {
      setError(`You can add up to ${MAX_FAVOURITES} favourites.`);
      return;
    }
    if (!draft.favourites.some((f) => f.toLowerCase() === value.toLowerCase())) {
      update({ favourites: [...draft.favourites, value] });
    }
    setFavInput("");
  };

  /** Returns an error message for the current step, or null when it's valid. */
  const validate = (): string | null => {
    switch (current) {
      case "interests":
        return draft.interests.length ? null : "Pick at least one so we know what to look for.";
      case "city":
        return draft.city || resolveCity(draft.cityQuery) ? null : "Choose your home city from the list or type its name.";
      case "budget":
        return parseAmount(draft.budget, 100_000) === null ? "Enter an amount in dollars (0 is fine)." : null;
      case "hotel":
        return parseAmount(draft.hotel, 10_000) === null ? "Enter an amount in dollars (0 is fine)." : null;
      case "travel":
        return parseAmount(draft.travel, 20_000) === null ? "Enter an amount in dollars (0 is fine)." : null;
      case "vacation":
        return parseAmount(draft.vacation, 365) === null ? "Enter a number of days between 0 and 365." : null;
      default:
        return null;
    }
  };

  const save = () => {
    const city = draft.city ?? resolveCity(draft.cityQuery);
    if (!city) {
      setStep(STEPS.findIndex((s) => s.key === "city"));
      setError("Choose your home city first.");
      return;
    }
    const profile: Profile = {
      version: 1,
      interests: draft.interests,
      favourites: draft.favourites,
      city: city.name,
      stateCode: city.state,
      lat: city.lat,
      lng: city.lng,
      radiusMiles: draft.radiusMiles,
      monthlyFunBudget: parseAmount(draft.budget, 100_000) ?? 150,
      hotelPerNight: parseAmount(draft.hotel, 10_000) ?? 150,
      travelPerTrip: parseAmount(draft.travel, 20_000) ?? 200,
      vacationDaysLeft: Math.round(parseAmount(draft.vacation, 365) ?? 10),
      preferredMonths: draft.months.length ? [...draft.months].sort((a, b) => a - b) : MONTHS.map((_, i) => i + 1),
      liked: existing?.liked ?? [],
      skipped: existing?.skipped ?? [],
      likedTags: existing?.likedTags ?? [],
      isSample: false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    setProfile(profile);
    router.push("/discover");
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (current === "city" && !draft.city) {
      const resolved = resolveCity(draft.cityQuery);
      if (resolved) update({ city: resolved, cityQuery: cityLabel(resolved) });
    }
    if (isLast) {
      save();
      return;
    }
    setError(null);
    setStep((s) => Math.min(total - 1, s + 1));
  };

  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  const goTo = (key: StepKey) => {
    setError(null);
    setStep(STEPS.findIndex((s) => s.key === key));
  };

  const weeklyFromBudget = parseAmount(draft.budget, 100_000);
  const ideas = Array.from(new Set((draft.interests.length ? draft.interests : CATEGORIES.slice(0, 3)).flatMap((c) => IDEAS[c])))
    .filter((idea) => !draft.favourites.some((f) => f.toLowerCase() === idea.toLowerCase()))
    .slice(0, 8);
  const resolvedCity = draft.city ?? resolveCity(draft.cityQuery);
  const pct = ((step + 1) / total) * 100;
  const invalid = error !== null;
  const described = [helpId, invalid ? errorId : null].filter(Boolean).join(" ");

  let title = "";
  let lead = "";
  let body: ReactNode = null;

  switch (current) {
    case "interests":
      title = "What do you love going to?";
      lead = "Pick as many as you like. We use these to find events near you.";
      body = (
        <>
          <ToggleGroup.Root
            type="multiple"
            value={draft.interests}
            onValueChange={(value) => update({ interests: value.filter((v): v is Category => (CATEGORIES as readonly string[]).includes(v)) })}
            aria-label="Interests"
            aria-describedby={described}
            className={ui.chips}
          >
            {CATEGORIES.map((c) => (
              <ToggleGroup.Item key={c} value={c} className={ui.chip}>
                {CATEGORY_LABELS[c]}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
          <p id={helpId} className="help">
            Use arrow keys to move between options and Space to select.
          </p>
        </>
      );
      break;

    case "favourites":
      title = "Any favourites we should look for?";
      lead = "Artists, genres, teams or shows. Optional, but it sharpens your picks.";
      body = (
        <>
          <div className={styles.addRow}>
            <div className="field">
              <label htmlFor={fieldId}>Add a favourite</label>
              <input
                id={fieldId}
                value={favInput}
                maxLength={60}
                placeholder="e.g. indie rock, a team, a comedian"
                aria-describedby={described}
                onChange={(event) => setFavInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && favInput.trim()) {
                    event.preventDefault();
                    addFavourite(favInput);
                  }
                }}
              />
            </div>
            <button type="button" className="pill alt" onClick={() => addFavourite(favInput)}>
              Add
            </button>
          </div>
          <p id={helpId} className="help">
            Press Enter to add each one. Skip this step if nothing comes to mind.
          </p>
          {draft.favourites.length ? (
            <ul className={`${ui.chips} ${ui.plainList}`} aria-label="Your favourites">
              {draft.favourites.map((fav) => (
                <li key={fav} className={styles.favChip}>
                  <span>{fav}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${fav}`}
                    onClick={() => update({ favourites: draft.favourites.filter((f) => f !== fav) })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {ideas.length ? (
            <div className={styles.ideas}>
              <p className={styles.ideasLabel}>Ideas</p>
              <div className={ui.chips}>
                {ideas.map((idea) => (
                  <button key={idea} type="button" className={ui.chip} onClick={() => addFavourite(idea)}>
                    + {idea}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      );
      break;

    case "city":
      title = "Where's home?";
      lead = "We measure distances from your city to find events nearby.";
      body = (
        <div className="field">
          <label htmlFor={fieldId}>Home city</label>
          <CityCombobox
            inputId={fieldId}
            value={draft.cityQuery}
            describedBy={described}
            invalid={invalid}
            onQueryChange={(text) => update({ cityQuery: text, city: null })}
            onSelect={(c) => update({ city: { name: c.name, state: c.state, lat: c.lat, lng: c.lng }, cityQuery: `${c.name}, ${c.state}` })}
          />
          <p id={helpId} className="help">
            {resolvedCity && resolvedCity.lat === undefined && draft.cityQuery.trim()
              ? "Not in our list yet. That's okay: we'll use the name, but distances will be rough."
              : "Use the arrow keys to pick from the list, or keep typing."}
          </p>
        </div>
      );
      break;

    case "radius":
      title = "How far will you go for a night out?";
      lead = "Within this distance you'd drive or take transit home. Beyond it, we add travel and a hotel night to the cost.";
      body = (
        <div className={styles.sliderBlock}>
          <p className={styles.sliderValue} aria-hidden="true">
            {draft.radiusMiles} mi
          </p>
          <Slider.Root
            className={styles.slider}
            value={[draft.radiusMiles]}
            min={5}
            max={150}
            step={5}
            onValueChange={(value) => update({ radiusMiles: value[0] ?? 30 })}
          >
            <Slider.Track className={styles.sliderTrack}>
              <Slider.Range className={styles.sliderRange} />
            </Slider.Track>
            <Slider.Thumb
              className={styles.sliderThumb}
              aria-label="Travel radius"
              aria-valuetext={`${draft.radiusMiles} miles`}
              aria-describedby={helpId}
            />
          </Slider.Root>
          <div className={styles.sliderScale} aria-hidden="true">
            <span>5 mi</span>
            <span>150 mi</span>
          </div>
          <p id={helpId} className="help">
            Use the arrow keys to change it in 5-mile steps.
          </p>
        </div>
      );
      break;

    case "budget":
      title = "What's your monthly fun budget?";
      lead = "What you'd like to put toward experiences each month. Your estimate is fine.";
      body = (
        <div className="field">
          <label htmlFor={fieldId}>Monthly fun budget (USD)</label>
          <input
            id={fieldId}
            inputMode="decimal"
            value={draft.budget}
            aria-invalid={invalid || undefined}
            aria-describedby={described}
            onChange={(event) => update({ budget: event.target.value })}
            className={styles.amount}
          />
          <p id={helpId} className="help">
            Your estimate.
            {weeklyFromBudget !== null ? ` That's about ${usd0(weeklyFromBudget / WEEKS_PER_MONTH)} a week.` : ""}
          </p>
        </div>
      );
      break;

    case "hotel":
      title = "What do you usually spend on a hotel night?";
      lead = "Only used when an event is beyond your travel radius.";
      body = (
        <div className="field">
          <label htmlFor={fieldId}>Hotel budget per night (USD)</label>
          <input
            id={fieldId}
            inputMode="decimal"
            value={draft.hotel}
            aria-invalid={invalid || undefined}
            aria-describedby={described}
            onChange={(event) => update({ hotel: event.target.value })}
            className={styles.amount}
          />
          <p id={helpId} className="help">
            Your estimate. You can change it for each event later.
          </p>
        </div>
      );
      break;

    case "travel":
      title = "What does a trip out of town cost you?";
      lead = "A typical round trip beyond your radius: gas, train or a flight.";
      body = (
        <div className="field">
          <label htmlFor={fieldId}>Travel cost per trip (USD)</label>
          <input
            id={fieldId}
            inputMode="decimal"
            value={draft.travel}
            aria-invalid={invalid || undefined}
            aria-describedby={described}
            onChange={(event) => update({ travel: event.target.value })}
            className={styles.amount}
          />
          <p id={helpId} className="help">
            Your estimate. You can change it for each event later.
          </p>
        </div>
      );
      break;

    case "vacation":
      title = "How many vacation days do you have left?";
      lead = "Paid days off you can still use. We flag trips that need time off.";
      body = (
        <div className="field">
          <label htmlFor={fieldId}>Vacation days left</label>
          <input
            id={fieldId}
            inputMode="numeric"
            value={draft.vacation}
            aria-invalid={invalid || undefined}
            aria-describedby={described}
            onChange={(event) => update({ vacation: event.target.value })}
            className={styles.amount}
          />
          <p id={helpId} className="help">
            Your best guess is fine.
          </p>
        </div>
      );
      break;

    case "months":
      title = "When do you like to go out?";
      lead = "Pick your favourite months. Leave it empty if any month works.";
      body = (
        <>
          <ToggleGroup.Root
            type="multiple"
            value={draft.months.map(String)}
            onValueChange={(value) =>
              update({
                months: value
                  .map(Number)
                  .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
                  .sort((a, b) => a - b),
              })
            }
            aria-label="Preferred months"
            aria-describedby={helpId}
            className={`${ui.chips} ${styles.months}`}
          >
            {MONTHS.map((m, i) => (
              <ToggleGroup.Item key={m} value={String(i + 1)} className={ui.chip} aria-label={MONTH_NAMES[i]}>
                {m}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
          <p id={helpId} className="help">
            {draft.months.length ? `${draft.months.length} selected. ` : "Any month. "}
            <button type="button" className={ui.textButton} onClick={() => update({ months: [] })} disabled={!draft.months.length}>
              Clear
            </button>
          </p>
        </>
      );
      break;

    case "review": {
      title = "Look good?";
      lead = "Saved only in this browser. You can change it anytime.";
      const rows: { key: StepKey; label: string; value: string }[] = [
        {
          key: "interests",
          label: "Interests",
          value: draft.interests.map((c) => CATEGORY_LABELS[c]).join(", ") || "None yet",
        },
        { key: "favourites", label: "Favourites", value: draft.favourites.join(", ") || "None" },
        {
          key: "city",
          label: "Home city",
          value: resolvedCity
            ? `${cityLabel(resolvedCity)}${resolvedCity.lat === undefined ? " (rough distances)" : ""}`
            : "Not set",
        },
        { key: "radius", label: "Travel radius", value: `${draft.radiusMiles} miles` },
        { key: "budget", label: "Monthly fun budget", value: `${usd0(parseAmount(draft.budget, 100_000) ?? 0)}` },
        { key: "hotel", label: "Hotel per night", value: `${usd0(parseAmount(draft.hotel, 10_000) ?? 0)}` },
        { key: "travel", label: "Travel per trip", value: `${usd0(parseAmount(draft.travel, 20_000) ?? 0)}` },
        { key: "vacation", label: "Vacation days left", value: `${Math.round(parseAmount(draft.vacation, 365) ?? 0)}` },
        {
          key: "months",
          label: "Best months",
          value: draft.months.length ? draft.months.map((m) => MONTHS[m - 1]).join(", ") : "Any month",
        },
      ];
      body = (
        <dl className={styles.review}>
          {rows.map((row) => (
            <div key={row.key} className={styles.reviewRow}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
              <dd className={styles.reviewEdit}>
                <button type="button" className={ui.textButton} onClick={() => goTo(row.key)}>
                  Edit<span className="sr-only"> {row.label.toLowerCase()}</span>
                </button>
              </dd>
            </div>
          ))}
        </dl>
      );
      break;
    }
  }

  return (
    <div className={`wrap ${ui.page}`}>
      <div className={styles.layout}>
        <div className={styles.top}>
          <div className={styles.topRow}>
            <p className={`kicker ${styles.kicker}`}>
              {String(step + 1).padStart(2, "0")} / {STEPS[step].label}
            </p>
            {existing ? (
              <Link href="/discover" className={ui.inlineLink}>
                Back to Discover
              </Link>
            ) : (
              <button
                type="button"
                className={ui.textButton}
                onClick={() => {
                  loadSampleProfile();
                  router.push("/discover");
                }}
              >
                Try a sample profile instead
              </button>
            )}
          </div>
          <p className={styles.stepCount} aria-hidden="true">
            Step {step + 1} of {total}
          </p>
          <Progress.Root
            className={styles.progress}
            value={step + 1}
            max={total}
            aria-label="Onboarding progress"
            getValueLabel={(value, max) => `Step ${value} of ${max}`}
          >
            <Progress.Indicator className={styles.progressFill} style={{ transform: `translateX(-${100 - pct}%)` }} />
          </Progress.Root>
        </div>

        <form className={styles.form} onSubmit={next} noValidate aria-labelledby={`${ids}-title`}>
          <h1 id={`${ids}-title`} ref={headingRef} tabIndex={-1} className={`title ${styles.title}`}>
            <span className="sr-only">
              Step {step + 1} of {total}:{" "}
            </span>
            {title}
          </h1>
          <p className={`lead muted ${styles.lead}`}>{lead}</p>

          <div className={styles.body}>{body}</div>

          {error ? (
            <p id={errorId} className={`${ui.error} ${styles.error}`} role="alert">
              {error}
            </p>
          ) : null}

          <div className={styles.navRow}>
            <button type="button" className="pill alt" onClick={back} disabled={step === 0}>
              <span aria-hidden="true">←</span> Back
            </button>
            <button type="submit" className="pill">
              {isLast ? (existing ? "Save changes" : "Save and see my picks") : current === "favourites" && !draft.favourites.length ? "Skip for now" : "Next"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** /onboarding — the quiz, or `?sample=1` to load the labeled sample profile and jump to Discover. */
export function OnboardingView() {
  const params = useSearchParams();
  const router = useRouter();
  const hydrated = useHydrated();
  const wantsSample = params.get("sample") === "1";

  useEffect(() => {
    if (!wantsSample) return;
    loadSampleProfile();
    router.replace("/discover");
  }, [wantsSample, router]);

  if (wantsSample) return <PageSkeleton label="Loading the sample profile…" />;
  if (!hydrated) return <PageSkeleton label="Loading onboarding…" />;
  return <Wizard />;
}
