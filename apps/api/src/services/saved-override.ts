import type { SavedOverride } from "@dora-dashboard/core";

/**
 * The rules a saved override stands for, or null when the defaults apply: when nothing was saved, or when what was saved
 * cannot be read, which the listing still reports as `unreadable` so the person can be told.
 */
export const rulesOf = <R>(saved: SavedOverride<R>): R | null => (saved.kind === "override" ? saved.rules : null);
