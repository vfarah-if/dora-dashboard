import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration, formatNumber } from "../lib/format";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";
import { SupplyChainLines } from "./SupplyChainCard";

const c = copy.security.updates;

/** How dependency update pull requests from Dependabot and Renovate fare, with the setup that makes them happen. */
export function DependencyUpdatesCard({ report }: { report: SecurityReport }) {
  const u = report.dependencyUpdates;
  const none = u.openedInRange === 0 && u.mergedInRange === 0 && u.openNow === 0;
  return (
    <SecurityBlock id="security-updates" title={c.title} lede={c.lede}>
      <div className="tile-grid tile-grid-flow">
        <StatTile label={c.opened} value={formatNumber(u.openedInRange, 0)} hint={c.openedHint} />
        <StatTile label={c.merged} value={formatNumber(u.mergedInRange, 0)} hint={c.mergedHint} />
        <StatTile label={c.closed} value={formatNumber(u.closedUnmergedInRange, 0)} />
        <StatTile label={c.openNow} value={formatNumber(u.openNow, 0)} />
        <StatTile
          label={c.timeToMerge}
          value={formatDuration(u.timeToMerge.median)}
          hint={c.timeToMergeHint(u.timeToMerge.count)}
        />
        <StatTile
          label={c.oldest}
          value={u.oldestOpenDays === null ? formatDuration(null) : formatDuration(u.oldestOpenDays * 24)}
          hint={u.oldestOpenDays === null ? c.oldestNone : undefined}
        />
      </div>
      <p className="chart-subtitle">{none ? c.noneYet : u.mergedInRange > 0 ? c.good : ""}</p>
      {report.supplyChain.status === "ok" && (
        <section className="card" aria-labelledby="security-updates-setup">
          <h3 id="security-updates-setup" className="chart-title">
            {c.filesTitle}
          </h3>
          <SupplyChainLines report={report} group="updates" />
        </section>
      )}
    </SecurityBlock>
  );
}
