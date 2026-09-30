import type { QueueEntry } from "@dora-dashboard/core";
import { copy } from "../copy";
import { initialsOf, metaParts } from "../lib/reviewQueue";
import { ChecksStatus } from "./ChecksStatus";
import { ReviewFlag } from "./ReviewFlag";

const text = copy.reviewQueue;

export function PrQueueCard({ entry, showNames }: { entry: QueueEntry; showNames: boolean }) {
  const label = entry.isDraft ? text.card.draft : entry.lane === "held" ? text.card.onHold : null;
  const author = showNames ? entry.author : null;

  return (
    <li className="pr-card">
      <div className="pr-card-head">
        <ReviewFlag entry={entry} />
        {label && <span className="pr-card-label">{label}</span>}
        <a className="pr-card-title" href={entry.url} target="_blank" rel="noreferrer">
          {entry.title}
          <span className="visually-hidden"> {text.card.opensInNewTab}</span>
        </a>
      </div>
      <div className="pr-card-ref">
        <span className="pr-card-meta">
          {entry.repo}#{entry.number}
        </span>
        {author && (
          <span className="pr-avatar" title={text.card.authorAvatar(author)}>
            <span aria-hidden="true">{initialsOf(author)}</span>
            <span className="visually-hidden">{text.card.by(author)}</span>
          </span>
        )}
      </div>
      <p className="pr-card-meta">{metaParts(entry, showNames).join(" · ")}</p>
      <ChecksStatus checks={entry.checks} />
    </li>
  );
}
