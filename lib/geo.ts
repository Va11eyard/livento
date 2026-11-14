/** Great-circle helpers. Pure; safe in the browser. */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_MILES = 3958.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Haversine distance in statute miles. */
export function distanceMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== "object") return false;
  const v = value as { lat?: unknown; lng?: unknown };
  return (
    typeof v.lat === "number" &&
    typeof v.lng === "number" &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180
  );
}
