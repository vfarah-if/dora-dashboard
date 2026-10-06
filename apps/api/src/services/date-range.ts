import { ValidationError } from "../core/errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day (UTC) an instant falls on, as YYYY-MM-DD. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Rejects a malformed or inverted `from` and `to`, with the same wording as the report routes. When `today` is given,
 * a `from` after it is refused too: the range ends no later than today, so such a request would be inverted.
 */
export function validateDateRange(range: { from?: string; to?: string }, today?: string): void {
  for (const key of ["from", "to"] as const) {
    const value = range[key];
    if (value !== undefined && !DATE.test(value)) throw new ValidationError(`${key} must be a date as YYYY-MM-DD`);
  }
  if (range.from && range.to && range.from > range.to) throw new ValidationError("from must not be after to");
  if (range.from && today !== undefined && range.from > today) throw new ValidationError("from must not be after today");
}
