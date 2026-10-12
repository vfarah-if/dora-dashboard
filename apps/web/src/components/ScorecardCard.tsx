import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { scannedOn, scorecardCheckValue } from "../lib/security";
import { DataTable } from "./ChartCard";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";

const c = copy.security.scorecard;

/** The OpenSSF Scorecard of a public repository, for information only. It never changes the grade. */
export function ScorecardCard({ report }: { report: SecurityReport }) {
  const card = report.scorecard;
  return (
    <SecurityBlock id="security-scorecard" title={c.title} lede={c.lede}>
      {report.scorecardStatus === "ok" && card ? (
        <>
          <div className="tile-grid tile-grid-flow">
            <StatTile label={c.score} value={c.scoreValue(card.score)} hint={scannedOn(card.date)} />
          </div>
          <div className="card">
            <DataTable
              caption={c.title}
              columns={[c.check, c.checkScore, c.reason]}
              rows={card.checks.map((check) => [check.name, scorecardCheckValue(check.score), check.reason])}
            />
          </div>
        </>
      ) : (
        <div className="notice notice-info">
          <p>{report.scorecardStatus === "ok" ? c.status.not_scanned : c.status[report.scorecardStatus]}</p>
        </div>
      )}
      <p className="chart-subtitle">{c.only}</p>
    </SecurityBlock>
  );
}
