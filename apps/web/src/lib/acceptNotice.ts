import { useSyncExternalStore } from "react";

/** The id of the Accepted findings heading, which takes focus once a finding is accepted or an acceptance is removed. */
export const ACCEPTED_HEADING_ID = "security-accepted-title";

/** A message and a count of how many have been set for the repository, so a repeat of the same words is a new message. */
export interface AcceptNotice {
  text: string;
  sequence: number;
}

/*
 * What the Accepted findings section says aloud after an accept or a remove, held for each repository so one
 * repository's message never shows under another's address. The control that was pressed is gone by the time the report
 * has been read again, since the finding leaves its list, so the message cannot live in that control.
 */
const notices = new Map<number, AcceptNotice>();
let sequence = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * Sets or clears one repository's message, and tells every section that shows it. Each message gets its own sequence
 * number, which a reader uses as a key, so the same words said twice are inserted again and announced again.
 */
export function setAcceptNotice(repoId: number, next: string | null): void {
  if (next === null) {
    if (!notices.delete(repoId)) return;
  } else {
    sequence += 1;
    notices.set(repoId, { text: next, sequence });
  }
  listeners.forEach((listener) => listener());
}

/** The message for one repository, or null. The same object is returned until the message changes. */
export const useAcceptNotice = (repoId: number): AcceptNotice | null =>
  useSyncExternalStore(subscribe, () => notices.get(repoId) ?? null);

/** Moves focus to the Accepted findings heading, so a keyboard or screen reader user lands where the result is. */
export function focusAcceptedHeading(): void {
  document.getElementById(ACCEPTED_HEADING_ID)?.focus();
}
