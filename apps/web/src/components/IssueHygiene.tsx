import type { IssueHygieneFinding, IssueRef } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatPercent } from "../lib/format";
import { orderedFindings } from "../lib/issues";
import { shareOf } from "../lib/space";
import { GroupedItemList, HygieneLine, PullRequestList } from "./HygieneLists";

function IssueList({ items, people }: { items: readonly IssueRef[]; people: boolean }) {
  return (
    <GroupedItemList
      items={items}
      people={people}
      itemKey={(item) => item.number}
      renderItem={(item) => <HygieneLine href={item.url} label={`#${item.number}`} summary={item.title} />}
    />
  );
}

/** The explanation of a check. The stale check names the number of days the report was built with. */
function explanationOf(finding: IssueHygieneFinding, staleUrgentDays: number): string {
  const checks = copy.issue.hygiene.checks;
  return finding.check === "stale_urgent" ? checks.stale_urgent.explanation(staleUrgentDays) : checks[finding.check].explanation;
}

function Finding({
  finding,
  people,
  staleUrgentDays,
}: {
  finding: IssueHygieneFinding;
  people: boolean;
  staleUrgentDays: number;
}) {
  const text = copy.issue.hygiene;
  const { title } = text.checks[finding.check];
  const share = shareOf(finding.count, finding.of);
  return (
    <section className="card hygiene-card" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      <p className="chart-subtitle">{explanationOf(finding, staleUrgentDays)}</p>
      <p className="hygiene-count">
        {finding.of !== null && share !== null
          ? text.foundOf(finding.count, finding.of, formatPercent(share))
          : text.found(finding.count)}
      </p>
      {finding.count === 0 && <p className="text-muted">{text.none}</p>}
      {finding.count > 0 && (
        <div className="hygiene-body">
          <p className="hygiene-heading">{text.checkThese}</p>
          {finding.check === "pr_without_issue" ? (
            <PullRequestList pullRequests={finding.pullRequests} />
          ) : (
            <IssueList items={finding.items} people={people} />
          )}
        </div>
      )}
    </section>
  );
}

/** One card per check, always in the same order, whatever order the API returned them in. */
export function IssueHygiene({
  findings,
  people,
  staleUrgentDays,
}: {
  findings: readonly IssueHygieneFinding[];
  people: boolean;
  staleUrgentDays: number;
}) {
  return (
    <div className="hygiene-grid">
      {orderedFindings(findings).map((finding) => (
        <Finding key={finding.check} finding={finding} people={people} staleUrgentDays={staleUrgentDays} />
      ))}
    </div>
  );
}
