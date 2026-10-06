import { copy } from "../copy";

const numberFormat = (digits: number) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/**
 * The one duration formatter. Under an hour shows whole minutes, under 48 hours shows hours to one
 * decimal place, and anything longer shows days to one decimal place.
 */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return copy.common.notAvailable;
  const h = Math.max(0, hours);
  const unit = durationUnit(h);
  if (unit === "min") return `${Math.round(h * 60)} min`;
  if (unit === "h") return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export type DurationUnit = "min" | "h" | "days";

/** The unit `formatDuration` writes a number of hours in. */
export function durationUnit(hours: number): DurationUnit {
  const h = Math.max(0, hours);
  if (h < 1) return "min";
  return h < 48 ? "h" : "days";
}

/** A number to one decimal place, without the decimal when it is zero. */
const tenths = (value: number) => {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
};

/**
 * A duration in a chosen unit, for sentences that set one duration against another. It writes each unit as
 * `formatDuration` does, except that a whole number of hours or days drops its ".0", so a threshold reads "24 h".
 * Passing the unit of the value a gap belongs to writes the gap to the same precision, so one can be read off the other.
 */
export function formatDurationIn(hours: number | null | undefined, unit?: DurationUnit): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return copy.common.notAvailable;
  const h = Math.max(0, hours);
  switch (unit ?? durationUnit(h)) {
    case "min":
      return `${Math.round(h * 60)} min`;
    case "h":
      return `${tenths(h)} h`;
    case "days": {
      const days = tenths(h / 24);
      return days === "1" ? "1 day" : `${days} days`;
    }
  }
}

/**
 * The fewest decimal places, from `min` up, that write a number as exactly as `max` places would, so 9.4 needs one
 * and 10.0 needs none. A number that is not zero but would show as zero at `max` places takes more, until it does not.
 */
export function placesNeeded(value: number, min: number, max: number): number {
  const at = (places: number) => Math.round(value * 10 ** places) / 10 ** places;
  for (let places = min; places < max; places++) {
    if (at(places) === at(max) && (at(places) !== 0 || value === 0)) return places;
  }
  let places = Math.max(min, max);
  while (at(places) === 0 && value !== 0) places++;
  return places;
}

/** A share between 0 and 1 as a whole percentage. */
export function formatPercent(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return copy.common.notAvailable;
  return `${Math.round(share * 100)}%`;
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return copy.common.notAvailable;
  return numberFormat(digits).format(value);
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortDateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const parse = (iso: string) => {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A calendar date such as 3 Mar 2026. */
export function formatDate(iso: string | null | undefined): string {
  const date = iso ? parse(iso) : null;
  return date ? dateFormat.format(date) : copy.common.notAvailable;
}

/** A compact week label for chart axes such as 3 Mar. */
export function formatWeek(iso: string): string {
  const date = parse(iso);
  return date ? shortDateFormat.format(date) : iso;
}

export function formatDateTime(iso: string | null | undefined): string {
  const date = iso ? parse(iso) : null;
  return date ? dateTimeFormat.format(date) : copy.common.notAvailable;
}

/** YYYY-MM-DD for the UTC day `days` before `now`. */
export function isoDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return d.toISOString().slice(0, 10);
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A clock time such as 14:05, in the viewer's time zone. */
export function formatTime(iso: string | null | undefined): string {
  const date = iso ? parse(iso) : null;
  return date ? timeFormat.format(date) : copy.common.notAvailable;
}
