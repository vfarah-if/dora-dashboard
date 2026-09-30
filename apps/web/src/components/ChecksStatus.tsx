import type { ReactNode } from "react";
import type { QueueEntry } from "@dora-dashboard/core";
import { copy } from "../copy";

const ICONS: Record<QueueEntry["checks"], ReactNode> = {
  passing: <path d="m8 12.5 2.5 2.5L16 9.5" />,
  failing: <path d="m9 9 6 6m0-6-6 6" />,
  pending: <path d="M12 8v4l2.5 1.5" />,
  none: null,
};

/** The state of a pull request's checks as an icon and text, so a failing build is never told by colour alone. */
export function ChecksStatus({ checks }: { checks: QueueEntry["checks"] }) {
  return (
    <span className={`checks-status checks-${checks}`}>
      <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        {ICONS[checks]}
      </svg>
      <span>{copy.reviewQueue.card.checks[checks]}</span>
    </span>
  );
}
