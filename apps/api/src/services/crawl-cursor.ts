import { UpstreamError } from "../core/errors.js";

/** How far behind the newest item the stored cursor sits, so late-indexed and same-millisecond items are re-read. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;

/**
 * The cursor a complete crawl leaves for the next: the newest update time less a small overlap. A cursor that is not
 * a date would make every later incremental crawl misbehave, so it is refused now. `noun` names what was read, such
 * as "work item" or "issue", in the message.
 */
export function cursorBefore(newest: string, noun: string): string {
  const at = Date.parse(newest);
  if (Number.isNaN(at))
    throw new UpstreamError(
      `The tracker sent a ${noun} update time that is not a date (${JSON.stringify(newest.slice(0, 40))})`,
      502,
    );
  return new Date(at - CURSOR_OVERLAP_MS).toISOString();
}
