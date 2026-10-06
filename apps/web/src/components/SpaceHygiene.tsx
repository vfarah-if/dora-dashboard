import type {
  ItemRef,
  SpaceHygieneBulkMoveFinding,
  SpaceHygieneFinding,
  SpaceHygienePullRequestFinding,
} from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatPercent, formatTime } from "../lib/format";
import { assigneeLabel, groupByAssignee, HYGIENE_ORDER, limitGroups, shareOf, browseUrl } from "../lib/space";
import { ExternalLink } from "./ExternalLink";
import { ShowAllList } from "./ShowAllList";

interface FindingProps {
  finding: SpaceHygieneFinding;
  siteUrl: string;
  people: boolean;
}

function IssueLine({ item, siteUrl }: { item: ItemRef; siteUrl: string }) {
  return (
    <li className="hygiene-item">
      <ExternalLink href={browseUrl(siteUrl, item.key)} className="mono">
        {item.key}
      </ExternalLink>{" "}
      <span className="hygiene-summary">{item.summary}</span>
    </li>
  );
}

/** Issue keys, in one list or grouped under each assignee's name when people are shown. */
function IssueList({ items, siteUrl, people }: { items: readonly ItemRef[]; siteUrl: string; people: boolean }) {
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
                <IssueLine key={item.key} item={item} siteUrl={siteUrl} />
              ))}
            </ul>
          </div>
        ));
      }}
    </ShowAllList>
  );
}

function PullRequestList({ pullRequests }: { pullRequests: SpaceHygienePullRequestFinding["pullRequests"] }) {
  return (
    <ShowAllList total={pullRequests.length}>
      {(limit) => (
        <ul className="hygiene-list">
          {pullRequests.slice(0, limit).map((pr) => (
            <li key={`${pr.repo}#${pr.number}`} className="hygiene-item">
              <ExternalLink href={pr.url} className="mono">{`${pr.repo}#${pr.number}`}</ExternalLink>{" "}
              <span className="hygiene-summary">{pr.title}</span>
            </li>
          ))}
        </ul>
      )}
    </ShowAllList>
  );
}

function BatchList({ batches, siteUrl }: { batches: SpaceHygieneBulkMoveFinding["batches"]; siteUrl: string }) {
  return (
    <ShowAllList total={batches.length}>
      {(limit) => (
        <ul className="hygiene-list">
          {batches.slice(0, limit).map((batch) => (
            <li key={batch.at} className="hygiene-item">
              <p className="hygiene-summary">{copy.space.hygiene.movedTogether(batch.keys.length, formatTime(batch.at))}</p>
              <ul className="hygiene-keys">
                {batch.keys.map((key) => (
                  <li key={key}>
                    <ExternalLink href={browseUrl(siteUrl, key)} className="mono">
                      {key}
                    </ExternalLink>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </ShowAllList>
  );
}

/** The list a finding carries, chosen by its check: pull requests, batches of moves, or delivery items. */
function FindingList({ finding, siteUrl, people }: FindingProps) {
  switch (finding.check) {
    case "pr_without_key":
      return <PullRequestList pullRequests={finding.pullRequests} />;
    case "bulk_move":
      return <BatchList batches={finding.batches} siteUrl={siteUrl} />;
    default:
      return <IssueList items={finding.items} siteUrl={siteUrl} people={people} />;
  }
}

function Finding({ finding, siteUrl, people }: FindingProps) {
  const text = copy.space.hygiene;
  const { title, explanation } = text.checks[finding.check];
  const share = shareOf(finding.count, finding.of);
  const hasList = finding.count > 0;
  return (
    <section className="card hygiene-card" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      <p className="chart-subtitle">{explanation}</p>
      <p className="hygiene-count">
        {finding.of !== null && share !== null
          ? text.foundOf(finding.count, finding.of, formatPercent(share))
          : text.found(finding.count)}
      </p>
      {!hasList && <p className="text-muted">{text.none}</p>}
      {hasList && (
        <div className="hygiene-body">
          <p className="hygiene-heading">{text.checkThese}</p>
          <FindingList finding={finding} siteUrl={siteUrl} people={people} />
        </div>
      )}
    </section>
  );
}

/** One card per check, always in the same order, whatever order the API returned them in. */
export function SpaceHygiene({
  findings,
  siteUrl,
  people,
}: {
  findings: readonly SpaceHygieneFinding[];
  siteUrl: string;
  people: boolean;
}) {
  const byCheck = new Map(findings.map((f) => [f.check, f]));
  return (
    <div className="hygiene-grid">
      {HYGIENE_ORDER.flatMap((check) => {
        const finding = byCheck.get(check);
        return finding ? [<Finding key={check} finding={finding} siteUrl={siteUrl} people={people} />] : [];
      })}
    </div>
  );
}
