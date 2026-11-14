/**
 * Cost model + savings plan (spec §6, FR-6/FR-7). Pure: no Node APIs, safe in
 * the browser. Every default is labeled; every user edit (CostOverrides) wins.
 */
import { distanceMiles, isLatLng } from "./geo";
import { addDays, daysBetween, isoDatePart, resolveToday } from "./dates";
import {
  DEFAULT_BUFFER_PCT,
  DEFAULT_FEES_PCT,
  type CostLine,
  type CostOverrides,
  type LiventoEvent,
  type PlanResult,
  type Profile,
} from "./types";

/** Days used when an event has neither an on-sale nor an event date (8 weeks). */
export const NO_DEADLINE_DAYS = 56;

/** "$89" or "$89.50". */
export function formatUSD(amount: number): string {
  if (!Number.isFinite(amount)) return "$0";
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded)
    ? `$${rounded.toLocaleString("en-US")}`
    : `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`;
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampFraction(value: unknown, fallback: number): number {
  const v = finiteNonNeg(value);
  return v === undefined ? fallback : Math.min(1, v);
}

function normalizePlace(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/^saint /, "st ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the event is in the user's own city (state must match when both are known). */
export function isSameCity(event: LiventoEvent, profile: Profile): boolean {
  const a = normalizePlace(event.city);
  const b = normalizePlace(profile.city);
  if (!a || !b || a !== b) return false;
  if (event.state && profile.stateCode) {
    return event.state.trim().toUpperCase() === profile.stateCode.trim().toUpperCase();
  }
  return true;
}

/**
 * Miles from the user's city to the event: computed from coordinates when both
 * sides have them, otherwise the event's own distanceMiles, otherwise undefined.
 */
export function eventDistanceMiles(event: LiventoEvent, profile: Profile): number | undefined {
  if (isLatLng(event) && isLatLng(profile)) {
    return distanceMiles({ lat: profile.lat, lng: profile.lng }, { lat: event.lat, lng: event.lng });
  }
  return finiteNonNeg(event.distanceMiles);
}

/**
 * Whether going to the event needs a trip (travel + hotel). Unknown distance in
 * the same city = local; unknown distance in another city = trip.
 */
export function needsTrip(event: LiventoEvent, profile: Profile): boolean {
  const radius = finiteNonNeg(profile.radiusMiles) ?? 0;
  const d = eventDistanceMiles(event, profile);
  if (d !== undefined) return d > radius;
  return !isSameCity(event, profile);
}

/** Deadline rule: future public on-sale → on-sale; else event date; else today + 8 weeks. */
export function planDeadline(
  event: LiventoEvent,
  today?: string,
): { deadline: string; deadlineKind: PlanResult["deadlineKind"] } {
  const t = resolveToday(today);
  const onSale = isoDatePart(event.onSaleStart);
  if (onSale && onSale > t) return { deadline: onSale, deadlineKind: "on-sale" };
  const eventDate = isoDatePart(event.date);
  if (eventDate) return { deadline: eventDate, deadlineKind: "event" };
  return { deadline: addDays(t, NO_DEADLINE_DAYS), deadlineKind: "none" };
}

export function buildPlan(
  event: LiventoEvent,
  profile: Profile,
  envelopeBalance: number,
  overrides?: CostOverrides,
  today?: string,
): PlanResult {
  const o: CostOverrides = overrides ?? {};
  const t = resolveToday(today);
  const radius = finiteNonNeg(profile.radiusMiles) ?? 0;
  const distance = eventDistanceMiles(event, profile);
  const trip = needsTrip(event, profile);

  // --- Tickets -------------------------------------------------------------
  const qtyRaw = finiteNonNeg(o.tickets);
  const qty = qtyRaw === undefined ? 1 : Math.min(50, Math.floor(qtyRaw));
  const userPrice = finiteNonNeg(o.ticketPrice);
  const minPrice = finiteNonNeg(event.priceMin);
  const maxPrice = finiteNonNeg(event.priceMax);
  const sourcePrice = minPrice ?? maxPrice;
  const unitPrice = userPrice ?? sourcePrice;

  let ticket: CostLine;
  if (unitPrice === undefined) {
    ticket = {
      key: "ticket",
      label: "Tickets (price TBA)",
      amount: 0,
      estimate: true,
      note: "Price TBA — enter your estimate",
    };
  } else {
    let note: string;
    let estimate = true;
    if (userPrice !== undefined) {
      note = "Your price";
      estimate = false;
    } else if (event.source === "sample") {
      note = "Sample price — fictional event";
    } else if (event.source === "ticketmaster") {
      if (minPrice !== undefined) {
        note = "Lowest listed face value on Ticketmaster (fees not included)";
        estimate = false;
      } else {
        note = "Only a top price is listed on Ticketmaster";
      }
    } else {
      note = event.priceNote ?? "Listed price on the official site — varies by date";
    }
    ticket = {
      key: "ticket",
      label: `Tickets (${qty} × ${formatUSD(unitPrice)})`,
      amount: Math.round(qty * unitPrice),
      estimate,
      note,
    };
  }

  // --- Fees ----------------------------------------------------------------
  const feesPct = clampFraction(o.feesPct, DEFAULT_FEES_PCT);
  const fees: CostLine = {
    key: "fees",
    label: `Estimated fees (${formatPct(feesPct)})`,
    amount: Math.round(ticket.amount * feesPct),
    estimate: true,
    note:
      o.feesPct !== undefined && finiteNonNeg(o.feesPct) !== undefined
        ? "Your fee rate"
        : "Typical service fees — the real amount shows at checkout",
  };

  // --- Travel --------------------------------------------------------------
  const userTravel = finiteNonNeg(o.travel);
  const away =
    distance !== undefined ? `About ${Math.round(distance)} mi away` : trip ? "Different city" : "Same city";
  let travel: CostLine;
  if (userTravel !== undefined) {
    travel = { key: "travel", label: "Travel", amount: Math.round(userTravel), estimate: false, note: "Your number" };
  } else if (trip) {
    travel = {
      key: "travel",
      label: "Travel (round trip)",
      amount: Math.round(finiteNonNeg(profile.travelPerTrip) ?? 0),
      estimate: true,
      note: `${away} — your travel cost per trip`,
    };
  } else {
    travel = {
      key: "travel",
      label: "Travel (local)",
      amount: 0,
      estimate: true,
      note: `${away} — within your ${radius}-mi radius`,
    };
  }

  // --- Hotel ---------------------------------------------------------------
  const nightsRaw = finiteNonNeg(o.hotelNights);
  const nights = nightsRaw === undefined ? (trip ? 1 : 0) : Math.min(60, Math.floor(nightsRaw));
  const userNightly = finiteNonNeg(o.hotelPerNight);
  const perNight = userNightly ?? finiteNonNeg(profile.hotelPerNight) ?? 0;
  const hotel: CostLine = {
    key: "hotel",
    label:
      nights > 0
        ? `Hotel (${nights} night${nights === 1 ? "" : "s"} × ${formatUSD(perNight)})`
        : "Hotel (none needed)",
    amount: Math.round(nights * perNight),
    estimate: userNightly === undefined,
    note:
      nights > 0
        ? userNightly !== undefined
          ? "Your nightly rate"
          : "Your hotel budget per night"
        : "No overnight stay assumed",
  };

  // --- Buffer --------------------------------------------------------------
  const bufferPct = clampFraction(o.bufferPct, DEFAULT_BUFFER_PCT);
  const subtotal = ticket.amount + fees.amount + travel.amount + hotel.amount;
  const buffer: CostLine = {
    key: "buffer",
    label: `Buffer (${formatPct(bufferPct)})`,
    amount: Math.round(subtotal * bufferPct),
    estimate: true,
    note: "Cushion for food, parking and surprises",
  };

  const lines = [ticket, fees, travel, hotel, buffer];
  const total = lines.reduce((sum, l) => sum + l.amount, 0);

  // --- Savings plan --------------------------------------------------------
  const { deadline, deadlineKind } = planDeadline(event, t);
  const days = daysBetween(t, deadline) ?? NO_DEADLINE_DAYS;
  const weeks = Math.max(1, Math.ceil(days / 7));
  const balance = typeof envelopeBalance === "number" && Number.isFinite(envelopeBalance) ? envelopeBalance : 0;
  const weekly = Math.ceil(Math.max(0, total - balance) / weeks);

  return { lines, total, deadline, deadlineKind, weeks, weekly, envelopeBalance: balance };
}
