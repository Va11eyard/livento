/**
 * Deterministic trip roadmap (FR-10). Every date and amount comes from the
 * event data and the cost plan; the optional LLM pass only rewrites wording.
 * Hotels and travel are outbound search links only (no scraping, no booking).
 */
import { eventDistanceMiles, needsTrip } from "./cost";
import { addDays, isoDatePart, resolveToday } from "./dates";
import type { LiventoEvent, PlanResult, Profile, RoadmapStep } from "./types";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const DEADLINE_LABEL: Record<PlanResult["deadlineKind"], string> = {
  "on-sale": "public on-sale",
  event: "event day",
  none: "8-week goal",
};

function lineAmount(plan: PlanResult, key: string): number {
  return plan.lines.find((l) => l.key === key)?.amount ?? 0;
}

function nightsFromPlan(plan: PlanResult): number {
  const hotel = plan.lines.find((l) => l.key === "hotel");
  const m = hotel?.label.match(/\((\d+) nights?/);
  if (m) return Number(m[1]);
  return hotel && hotel.amount > 0 ? 1 : 0;
}

function ticketsFromPlan(plan: PlanResult): number {
  const m = plan.lines.find((l) => l.key === "ticket")?.label.match(/\((\d+) ×/);
  return m ? Math.max(1, Number(m[1])) : 1;
}

function place(city: string, state?: string) {
  return [city, state].filter(Boolean).join(", ");
}

function dayOfChecklist(event: LiventoEvent): string {
  const base = "Tickets in your phone wallet, photo ID, a charged phone and a plan for getting home.";
  switch (event.category) {
    case "festivals":
      return `${base} Add sunscreen, a refillable water bottle and comfortable shoes.`;
    case "sports":
      return `${base} Check the venue's bag policy before you go.`;
    case "theatre":
    case "comedy":
      return `${base} Arrive early — late seating can be limited.`;
    case "family":
      return `${base} Pack snacks and water, and agree on a meeting spot.`;
    default:
      return base;
  }
}

export function buildRoadmap(event: LiventoEvent, profile: Profile, plan: PlanResult, today?: string): RoadmapStep[] {
  const t = resolveToday(today);
  const eventDate = isoDatePart(event.date);
  const isSample = event.source === "sample";
  const eventLink = !isSample && /^https?:\/\//.test(event.url) ? { label: "Event page", url: event.url } : undefined;
  const nights = nightsFromPlan(plan);
  const qty = ticketsFromPlan(plan);
  const travelCost = lineAmount(plan, "travel");
  const trip = needsTrip(event, profile) || nights > 0 || travelCost > 0;
  const balance = Number.isFinite(plan.envelopeBalance) ? plan.envelopeBalance : 0;
  const remaining = Math.max(0, plan.total - balance);
  const steps: RoadmapStep[] = [];

  // --- Money ---------------------------------------------------------------
  steps.push(
    plan.weekly > 0
      ? {
          date: t,
          kind: "money",
          title: `Set aside ${usd(plan.weekly)} a week`,
          detail:
            balance > 0
              ? `You have ${usd(balance)} set aside. ${plural(plan.weeks, "week")} at ${usd(plan.weekly)} covers the remaining ${usd(remaining)} by ${formatDate(plan.deadline)} (${DEADLINE_LABEL[plan.deadlineKind]}).`
              : `${plural(plan.weeks, "week")} at ${usd(plan.weekly)} covers your ${usd(plan.total)} estimate by ${formatDate(plan.deadline)} (${DEADLINE_LABEL[plan.deadlineKind]}).`,
        }
      : {
          date: t,
          kind: "money",
          title: "Your envelope covers the estimate",
          detail: `You have ${usd(balance)} set aside for the ${usd(plan.total)} estimate. Keep it there until you book.`,
        },
  );
  if (plan.weekly > 0 && plan.weeks >= 4) {
    const half = Math.floor(plan.weeks / 2);
    steps.push({
      date: addDays(t, half * 7),
      kind: "money",
      title: "Halfway check-in",
      detail: `Aim to have about ${usd(Math.min(plan.total, balance + plan.weekly * half))} in your envelope by now.`,
    });
  }

  // --- Tickets -------------------------------------------------------------
  const ticketHint = isSample
    ? "Sample event — there are no real tickets."
    : event.source === "ticketmaster"
      ? "Sign in to Ticketmaster early and have a payment method ready."
      : "Check the official site for the exact time.";
  for (const presale of event.presales ?? []) {
    const start = isoDatePart(presale.start);
    if (!start || start < t) continue;
    steps.push({
      date: start,
      kind: "tickets",
      title: `Presale: ${presale.name}`.slice(0, 90),
      detail: `This presale opens ${formatDate(start)}. ${ticketHint}`,
      ...(eventLink ? { link: eventLink } : {}),
    });
  }
  const onSale = isoDatePart(event.onSaleStart);
  if (onSale && onSale > t) {
    steps.push({
      date: onSale,
      kind: "tickets",
      title: "Public on-sale",
      detail: `Tickets go on sale ${formatDate(onSale)}. Your savings plan is timed for this day. ${ticketHint}`,
      ...(eventLink ? { link: eventLink } : {}),
    });
  } else {
    const ticketsCost = lineAmount(plan, "ticket") + lineAmount(plan, "fees");
    let date = t;
    let detail: string;
    if (ticketsCost <= 0) {
      detail = "Price TBA — check the event page, then enter your estimate in the cost plan.";
    } else if (balance >= ticketsCost) {
      detail = `Your envelope already covers the tickets (about ${usd(ticketsCost)} with estimated fees). Prices and availability can change.`;
    } else {
      if (plan.weekly > 0) date = addDays(t, Math.ceil((ticketsCost - balance) / plan.weekly) * 7);
      if (eventDate) date = minDate(date, addDays(eventDate, -1));
      date = maxDate(date, t);
      detail = `By then your envelope should cover the tickets (about ${usd(ticketsCost)} with estimated fees). Prices and availability can change.`;
    }
    steps.push({
      date,
      kind: "tickets",
      title: isSample ? "Tickets (sample event)" : "Buy tickets",
      detail: isSample ? `${detail} ${ticketHint}` : detail,
      ...(eventLink ? { link: eventLink } : {}),
    });
  }

  // --- Vacation --------------------------------------------------------------
  if (nights > 0) {
    const daysLeft = Math.max(0, Math.floor(profile.vacationDaysLeft ?? 0));
    const warning = daysLeft < nights ? " That's more than the vacation days you have left." : "";
    steps.push({
      date: eventDate ? maxDate(t, addDays(eventDate, -30)) : undefined,
      kind: "vacation",
      title: "Request time off",
      detail: eventDate
        ? `Ask for time off around ${formatDate(eventDate)} for ${plural(nights, "night")} away. You have ${plural(daysLeft, "vacation day")} left.${warning}`
        : `Pick your dates, then ask for time off for ${plural(nights, "night")} away. You have ${plural(daysLeft, "vacation day")} left.${warning}`,
    });
  }

  // --- Travel ----------------------------------------------------------------
  const home = place(profile.city, profile.stateCode);
  const destCity = place(event.city, event.state);
  const destination = !isSample && event.venue ? `${event.venue}, ${destCity}` : destCity;
  const bookBy = eventDate ? maxDate(t, addDays(eventDate, -21)) : undefined;
  if (trip) {
    steps.push({
      date: bookBy,
      kind: "travel",
      title: `Plan your trip to ${event.city}`,
      detail: `Your travel budget is ${usd(travelCost)} round trip (your estimate). Compare driving, train and flights before you book.`,
      ...(home
        ? {
            link: {
              label: "Directions in Google Maps",
              url: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(home)}&destination=${encodeURIComponent(destination)}`,
            },
          }
        : {}),
    });
    const miles = eventDistanceMiles(event, profile);
    if (eventDate && home && miles !== undefined && miles > 300) {
      const back = addDays(eventDate, Math.max(1, nights));
      steps.push({
        date: bookBy,
        kind: "travel",
        title: "Compare flights",
        detail: `It's about ${Math.round(miles)} miles each way. Search flights for ${formatDate(eventDate)} to ${formatDate(back)} and book when a fare fits your plan.`,
        link: {
          label: "Search Google Flights",
          url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${home} to ${destCity} on ${eventDate} through ${back}`)}`,
        },
      });
    }
  }

  // --- Stay ------------------------------------------------------------------
  if (nights > 0) {
    const hotelLine = plan.lines.find((l) => l.key === "hotel");
    const perNight = nights > 0 && hotelLine ? hotelLine.amount / nights : 0;
    const checkout = eventDate ? addDays(eventDate, nights) : undefined;
    const booking = new URLSearchParams({ ss: destCity, group_adults: String(qty), no_rooms: "1", group_children: "0" });
    if (eventDate && checkout) {
      booking.set("checkin", eventDate);
      booking.set("checkout", checkout);
    }
    const dates = eventDate && checkout ? ` from ${eventDate} to ${checkout}` : "";
    steps.push({
      date: bookBy,
      kind: "stay",
      title: "Book a place to stay",
      detail: `Budget: ${plural(nights, "night")} at about ${usd(perNight)} (your estimate). The link opens a Booking.com search${eventDate ? " with your dates" : ""} — compare a few options.`,
      link: { label: "Search Booking.com", url: `https://www.booking.com/searchresults.html?${booking.toString()}` },
    });
    steps.push({
      date: bookBy,
      kind: "stay",
      title: "Compare on Google Hotels",
      detail: `Check the same nights on Google Hotels and pick what fits your ${usd(hotelLine?.amount ?? 0)} hotel budget.`,
      link: {
        label: "Search Google Hotels",
        url: `https://www.google.com/travel/search?q=${encodeURIComponent(`hotels in ${destCity}${dates}`)}`,
      },
    });
  }

  // --- Day of ------------------------------------------------------------------
  steps.push({
    date: eventDate,
    kind: "day-of",
    title: eventDate ? `Event day: ${event.name}`.slice(0, 90) : "On the day",
    detail: `${event.time ? `Starts at ${event.time} local time. ` : ""}${dayOfChecklist(event)}`,
    ...(eventLink ? { link: eventLink } : {}),
  });

  // Dated steps in order, undated after them, event day last.
  const dayOf = steps.pop()!;
  const ordered = steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.date ?? "9999-99-99").localeCompare(b.s.date ?? "9999-99-99") || a.i - b.i)
    .map(({ s }) => s);
  return [...ordered, dayOf];
}
