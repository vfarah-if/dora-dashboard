import type { ItemRef, SpaceHygieneBulkMoveFinding, SpaceHygieneFinding } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatPercent, formatTime } from "../lib/format";
import { HYGIENE_ORDER, shareOf, browseUrl } from "../lib/space";
import { ExternalLink } from "./ExternalLink";
import { GroupedItemList, HygieneLine, PullRequestList } from "./HygieneLists";
import { ShowAllList } from "./ShowAllList";

interface FindingProps {
  finding: SpaceHygieneFinding;
  siteUrl: string;
  people: boolean;
}

function IssueList({ items, siteUrl, people }: { items: readonly ItemRef[]; siteUrl: string; people: boolean }) {
  return (
    <GroupedItemList
      items={items}
      people={people}
      itemKey={(item) => item.key}
      renderItem={(item) => <HygieneLine href={browseUrl(siteUrl, item.key)} label={item.key} summary={item.summary} />}
    />
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
