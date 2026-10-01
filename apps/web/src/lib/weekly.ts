/**
 * Drops the weeks before the first one that has anything to show, so a series that started late
 * (a deploy workflow added a year into the repository's life, say) does not open on a long flat run.
 * When no week is active the weeks come back unchanged and the caller shows its empty state.
 */
export function fromFirstActive<T>(weeks: readonly T[], isActive: (week: T) => boolean): T[] {
  const first = weeks.findIndex(isActive);
  return first === -1 ? [...weeks] : weeks.slice(first);
}

/** How many weeks a weekly chart shows before it gains a zoom slider. */
export const ZOOM_AFTER_WEEKS = 26;

/**
 * The window a weekly chart opens on: the latest `visible` weeks, or null when every week fits
 * and no zoom slider is needed. Indices are inclusive, as the chart's slider expects.
 */
export function initialWindow(length: number, visible = ZOOM_AFTER_WEEKS): { startIndex: number; endIndex: number } | null {
  if (length <= visible) return null;
  return { startIndex: length - visible, endIndex: length - 1 };
}
