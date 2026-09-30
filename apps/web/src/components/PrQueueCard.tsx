import type { QueueEntry } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatWait, isIdle } from "../lib/reviewQueue";
import { ReviewFlag } from "./ReviewFlag";

const text = copy.reviewQueue;

export function PrQueueCard({ entry, showNames }: { entry: QueueEntry; showNames: boolean }) {
  const reviewers = entry.requestedReviewers;
  const reviewerCount = entry.requestedReviewerCount;
  const people = [
    showNames && entry.author ? text.card.by(entry.author) : null,
    reviewerCount > 0
      ? showNames && reviewers.length
        ? text.card.waitingOn(reviewers.map((r) => r.name).join(", "))
        : text.card.reviewersRequested(reviewerCount)
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <li className="pr-card">
      <ReviewFlag entry={entry} />
      <a className="pr-card-title" href={entry.url} target="_blank" rel="noreferrer">
        {entry.title}
        <span className="visually-hidden"> {text.card.opensInNewTab}</span>
      </a>
      <p className="pr-card-meta">
        {entry.repo}#{entry.number}
        {entry.isDraft ? `, ${text.card.draft}` : ""}
      </p>
      <p className="pr-card-meta">{text.card.waitingSince(formatWait(entry.waitHours))}</p>
      {people.length > 0 && <p className="pr-card-meta">{people.join(", ")}</p>}
      <p className="pr-card-meta">
        {text.card.lines(entry.additions, entry.deletions, entry.changedFiles)}, {text.card.checks[entry.checks].toLowerCase()}
      </p>
      {isIdle(entry) && <p className="pr-card-meta">{text.card.idle(entry.idleDays)}</p>}
    </li>
  );
}
