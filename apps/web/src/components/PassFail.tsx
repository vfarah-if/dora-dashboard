import type { ReactNode } from "react";
import { copy } from "../copy";

export type PassFailState = "met" | "unmet" | "unseen";

const ICONS: Record<PassFailState, ReactNode> = {
  met: <path d="m8 12.5 2.5 2.5L16 9.5" />,
  unmet: <path d="m9 9 6 6m0-6-6 6" />,
  unseen: null,
};

const CLASSES: Record<PassFailState, string> = { met: "checks-passing", unmet: "checks-failing", unseen: "checks-none" };

/**
 * A result as an icon and a word, so that it never depends on colour. It reuses the check status icons and classes of
 * the review queue. The word can be replaced where "Met" and "Not met" do not fit, such as a source that was not read.
 */
export function PassFail({ state, label }: { state: PassFailState; label?: string }) {
  return (
    <span className={`checks-status ${CLASSES[state]}`}>
      <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        {ICONS[state]}
      </svg>
      <span>{label ?? copy.security.passFail[state]}</span>
    </span>
  );
}
