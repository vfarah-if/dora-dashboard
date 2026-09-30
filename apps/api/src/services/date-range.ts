import { ValidationError } from "../core/errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects a malformed or inverted `from` and `to`, with the same wording as the report routes. */
export function validateDateRange(range: { from?: string; to?: string }): void {
  for (const key of ["from", "to"] as const) {
    const value = range[key];
    if (value !== undefined && !DATE.test(value)) throw new ValidationError(`${key} must be a date as YYYY-MM-DD`);
  }
  if (range.from && range.to && range.from > range.to) throw new ValidationError("from must not be after to");
}
