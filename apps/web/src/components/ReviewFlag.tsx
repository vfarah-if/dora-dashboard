import type { QueueEntry } from "@dora-dashboard/core";
import { flagFor } from "../lib/reviewQueue";

/** A pill for a stale or overdue waiting pull request. It carries an icon and text, so status is never colour alone. */
export function ReviewFlag({ entry }: { entry: Pick<QueueEntry, "lane" | "band" | "waitHours"> }) {
  const flag = flagFor(entry);
  if (!flag) return null;
  return (
    <span className={`review-flag review-flag-${flag.band}`}>
      <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span>{flag.label}</span>
    </span>
  );
}
