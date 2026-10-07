import { Fragment, type ReactNode } from "react";
import type { ItemRef } from "@dora-dashboard/core";
import { assigneeLabel, groupByAssignee, limitGroups } from "../lib/space";
import { ExternalLink } from "./ExternalLink";
import { ShowAllList } from "./ShowAllList";

/** A link in monospace followed by a summary; the shape every hygiene line shares. */
export function HygieneLine({ href, label, summary }: { href: string; label: string; summary: string }) {
  return (
    <li className="hygiene-item">
      <ExternalLink href={href} className="mono">
        {label}
      </ExternalLink>{" "}
      <span className="hygiene-summary">{summary}</span>
    </li>
  );
}

/** Items, in one list or grouped under each assignee's name when people are shown. */
export function GroupedItemList<T extends Pick<ItemRef, "assigned" | "assignee">>({
  items,
  people,
  itemKey,
  renderItem,
}: {
  items: readonly T[];
  people: boolean;
  itemKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <ShowAllList total={items.length}>
      {(limit) => {
        const all = { id: "all", name: null, assigned: false, items: [...items] };
        const groups = limitGroups(people ? groupByAssignee(items) : [all], limit);
        return groups.map((group) => (
          <div key={group.id} className="hygiene-group">
            {people && <h4 className="hygiene-person">{assigneeLabel(group)}</h4>}
            <ul className="hygiene-list">
              {group.items.map((item) => (
                <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>
              ))}
            </ul>
          </div>
        ));
      }}
    </ShowAllList>
  );
}

interface PullRequestEntry {
  repo: string;
  number: number;
  title: string;
  url: string;
}

/** Pull requests with no linked item, each as a qualified reference and its title. */
export function PullRequestList({ pullRequests }: { pullRequests: readonly PullRequestEntry[] }) {
  return (
    <ShowAllList total={pullRequests.length}>
      {(limit) => (
        <ul className="hygiene-list">
          {pullRequests.slice(0, limit).map((pr) => (
            <HygieneLine key={`${pr.repo}#${pr.number}`} href={pr.url} label={`${pr.repo}#${pr.number}`} summary={pr.title} />
          ))}
        </ul>
      )}
    </ShowAllList>
  );
}
