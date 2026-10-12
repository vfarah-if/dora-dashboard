import type { ScorecardResult, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDateTime } from "../lib/format";
import { scannedOn, scorecardCheckValue } from "../lib/security";
import { DataTable } from "./ChartCard";
import { SecurityBlock } from "./SecurityParts";
import { StatTile } from "./StatTile";

const c = copy.security.scorecard;

function Result({ result }: { result: ScorecardResult }) {
  return (
    <>
      <div className="tile-grid tile-grid-flow">
        <StatTile label={c.score} value={c.scoreValue(result.score)} hint={scannedOn(result.date)} />
      </div>
      <div className="card">
        <DataTable
          caption={c.title}
          columns={[c.check, c.checkScore, c.reason]}
          rows={result.checks.map((check) => [check.name, scorecardCheckValue(check.score), check.reason])}
        />
      </div>
    </>
  );
}

/** The OpenSSF Scorecard of a public repository, for information only. It never changes the grade. */
export function ScorecardCard({ report }: { report: SecurityReport }) {
  const card = report.scorecard;
  return (
    <SecurityBlock id="security-scorecard" title={c.title} lede={c.lede}>
      {card.status === "ok" ? (
        <Result result={card.result} />
      ) : card.status === "error" ? (
        <>
          <div className="notice notice-warning">
            <p>{c.status.error}</p>
            <p>{c.failedWith(card.message, formatDateTime(card.attemptedAt))}</p>
            <p>{card.lastGood ? c.earlierScore : c.noEarlierScore}</p>
          </div>
          {card.lastGood && <Result result={card.lastGood} />}
        </>
      ) : (
        <div className="notice notice-info">
          <p>{c.status[card.status]}</p>
        </div>
      )}
      <p className="chart-subtitle">{c.only}</p>
    </SecurityBlock>
  );
}
