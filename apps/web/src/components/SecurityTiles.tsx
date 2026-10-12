import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration, formatNumber } from "../lib/format";
import {
  SEVERITIES,
  dismissedSummary,
  joinWords,
  likelyShare,
  severityExplanation,
  severityTileLabel,
  sourceName,
  ALERT_SOURCES,
  timeToFixRows,
  unreadParts,
} from "../lib/security";
import { DataTable } from "./ChartCard";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";

const c = copy.security;

/** Open alerts by severity, each tile saying in plain words what the severity means and how long it may wait. */
export function OpenAlertTiles({ report }: { report: SecurityReport }) {
  const { open } = report;
  const shown = SEVERITIES.filter((severity) => severity !== "unknown" || open.bySeverity.unknown > 0);
  const sources = joinWords(
    ALERT_SOURCES.filter((source) => open.bySource[source] > 0).map((source) =>
      c.open.fromSource(open.bySource[source], sourceName(source)),
    ),
  );
  return (
    <SecurityBlock id="security-open" title={c.open.title} lede={c.open.lede}>
      <div className="tile-grid tile-grid-flow">
        {shown.map((severity) => {
          const past = open.pastFix[severity];
          return (
            <StatTile
              key={severity}
              label={severityTileLabel(severity)}
              value={formatNumber(open.bySeverity[severity], 0)}
              tone={past > 0 ? "danger" : undefined}
              hint={
                <>
                  <span className="hint-line">{severityExplanation(severity, report.fixWithinDays)}</span>
                  <span className="hint-line">{past > 0 ? c.open.pastFix(past) : c.open.withinFix}</span>
                </>
              }
            />
          );
        })}
        <StatTile
          label={c.open.likelyTitle}
          value={formatNumber(report.likelyExploitedOpen, 0)}
          hint={c.open.likelyHint(likelyShare(report.thresholds))}
        />
      </div>
      <p className="chart-subtitle">{c.likelyExploitedWhy(likelyShare(report.thresholds))}</p>
      {open.total === 0 ? (
        <p className="chart-subtitle">{unreadParts(report).length > 0 ? c.open.noneButUnread : c.open.none}</p>
      ) : (
        <p className="chart-subtitle">{c.open.total(open.total, sources)}</p>
      )}
    </SecurityBlock>
  );
}

/** How long alerts took to fix in the range, and how many were dismissed. */
export function TimeToFix({ report }: { report: SecurityReport }) {
  const text = c.fixTime;
  const { timeToFix, dismissed } = report;
  const rows = timeToFixRows(report);
  return (
    <SecurityBlock id="security-time-to-fix" title={text.title} lede={text.lede}>
      <div className="tile-grid tile-grid-flow">
        <StatTile label={text.fixed} value={formatNumber(report.fixedInRange, 0)} hint={text.fixedHint} />
        <StatTile
          label={text.median}
          value={formatDuration(timeToFix.median)}
          hint={text.medianHint(formatDuration(timeToFix.p75), timeToFix.count)}
        />
        <StatTile label={text.slowest} value={formatDuration(timeToFix.p75)} hint={text.slowestHint} />
        <StatTile
          label={text.dismissed}
          value={formatNumber(dismissed.total, 0)}
          hint={dismissed.total === 0 ? text.dismissedNone : text.dismissedHint(dismissedSummary(dismissed))}
        />
      </div>
      <div className="card">
        <DataTable
          caption={text.bySeverity.title}
          columns={[
            text.bySeverity.severity,
            text.bySeverity.fixed,
            text.bySeverity.median,
            text.bySeverity.slowest,
            text.bySeverity.allowed,
          ]}
          rows={rows.map((row) => [
            row.label,
            row.count,
            formatDuration(row.median),
            formatDuration(row.p75),
            text.bySeverity.days(row.allowedDays),
          ])}
        />
      </div>
      {report.pushProtectionBypassedInRange > 0 && (
        <p className="chart-subtitle">{text.pushProtection(report.pushProtectionBypassedInRange)}</p>
      )}
    </SecurityBlock>
  );
}
