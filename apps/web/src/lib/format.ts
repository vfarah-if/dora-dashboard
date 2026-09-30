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
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
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
