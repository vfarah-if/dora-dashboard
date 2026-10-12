import { Link } from "react-router";
import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration, formatNumber } from "../lib/format";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";

const c = copy.security.issues;

/** Issues the team has classed as security problems. Null means the repository has no stored issues. */
export function SecurityIssuesCard({ report }: { report: SecurityReport }) {
  const issues = report.securityIssues;
  return (
    <SecurityBlock id="security-issues" title={c.title} lede={c.lede}>
      {issues === null ? (
        <p className="chart-empty">{c.none}</p>
      ) : (
        <>
          <div className="tile-grid tile-grid-flow">
            <StatTile label={c.open} value={formatNumber(issues.open, 0)} hint={c.openHint} />
            <StatTile
              label={c.oldest}
              value={issues.oldestOpenDays === null ? formatDuration(null) : formatDuration(issues.oldestOpenDays * 24)}
              hint={issues.oldestOpenDays === null ? c.oldestNone : undefined}
            />
            <StatTile label={c.closed} value={formatNumber(issues.closedInRange, 0)} />
            <StatTile
              label={c.timeToClose}
              value={formatDuration(issues.timeToClose.median)}
              hint={c.timeToCloseHint(issues.timeToClose.count)}
            />
          </div>
          <p>
            <Link to={`/issues/${report.repo.id}`} className="button button-secondary">
              {c.link}
            </Link>
          </p>
        </>
      )}
    </SecurityBlock>
  );
}
