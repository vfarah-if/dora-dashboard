import { ValidationError } from "../core/errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A floor on `from` and `to`, so the weekly rows a report can be asked to build stay bounded. */
export const EARLIEST_DATE = "2000-01-01";

/** True for a real calendar day: parsed as UTC, it reads back as the same date (so 2026-02-30 and 2026-13-01 fail). */
const isCalendarDay = (value: string): boolean => {
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
};

/** The calendar day (UTC) an instant falls on, as YYYY-MM-DD. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Rejects a `from` or `to` that is malformed, impossible, before `EARLIEST_DATE`, or inverted, with the same wording as
 * the report routes. When `today` is given, a `from` after it is refused too: the range ends no later than today, so
 * such a request would be inverted.
 */
export function validateDateRange(range: { from?: string; to?: string }, today?: string): void {
  for (const key of ["from", "to"] as const) {
    const value = range[key];
    if (value !== undefined && !DATE.test(value)) throw new ValidationError(`${key} must be a date as YYYY-MM-DD`);
    if (value !== undefined && !isCalendarDay(value)) throw new ValidationError(`${key} must be a real calendar date`);
    if (value !== undefined && value < EARLIEST_DATE) throw new ValidationError(`${key} must not be before ${EARLIEST_DATE}`);
  }
  if (range.from && range.to && range.from > range.to) throw new ValidationError("from must not be after to");
  if (range.from && today !== undefined && range.from > today) throw new ValidationError("from must not be after today");
}
