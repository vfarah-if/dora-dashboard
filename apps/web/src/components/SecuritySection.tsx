import { Link, useLocation } from "react-router";
import type { SecurityReport } from "@dora-dashboard/core";
import { useSecurityReport, type ReportRange } from "../api/hooks";
import { copy } from "../copy";
import { searchForCodePage } from "../lib/codeDetail";
import { formatNumber } from "../lib/format";
import {
  actionSentence,
  dependabotAlertsOn,
  ACTION_EFFORT,
  joinWords,
  notReadYet,
  pastFixTotal,
  reportCoverage,
  topActions,
  unreadParts,
  updateConfigPath,
  verdictSentence,
} from "../lib/security";
import { NotReadNotice } from "./NotReadNotice";
import { BandLabel } from "./BandLabel";
import { EffortTag } from "./SecurityParts";
import { ErrorState, SkeletonGrid } from "./States";
import { StatTile } from "./StatTile";

const c = copy.security.section;

function Summary({ report }: { report: SecurityReport }) {
  const { search } = useLocation();
  const grade = report.grade;
  const top = topActions(report.actions);
  const past = pastFixTotal(report.open.pastFix);
  const missing = unreadParts(report);
  if (notReadYet(report.sources)) return <NotReadNotice repoId={report.repo.id} />;
  return (
    <>
      {grade ? (
        <>
          <p className="band-line">
            <span>{copy.security.page.gradeLine}</span> <BandLabel band={grade.overall.band} />
          </p>
          <p>{verdictSentence(report)}</p>
        </>
      ) : (
        <p>{copy.security.start.missing[report.gradeMissing ?? "nothing_measured"]}</p>
      )}
      <div className="tile-grid tile-grid-flow">
        <StatTile label={c.tiles.critical} value={formatNumber(report.open.bySeverity.critical, 0)} />
        <StatTile label={c.tiles.high} value={formatNumber(report.open.bySeverity.high, 0)} />
        <StatTile
          label={c.tiles.pastFix}
          value={formatNumber(past, 0)}
          tone={past > 0 ? "danger" : undefined}
          hint={past > 0 ? copy.security.list.tiles.pastFixHint(past) : undefined}
        />
        <StatTile label={c.tiles.actions} value={formatNumber(report.actions.length, 0)} />
      </div>
      {missing.length > 0 && (
        <p className="chart-subtitle">
          {report.open.total === 0 ? copy.security.open.noneButUnread : c.partial(joinWords(missing))}
        </p>
      )}
      {top.shown.length === 0 ? (
        grade && <p>{c.none}</p>
      ) : (
        <div className="card">
          <h3 className="chart-title">{c.topTitle}</h3>
          <ol className="start-actions">
            {top.shown.map((action) => (
              <li key={`${action.kind}-${action.target ?? ""}-${action.manifestPath ?? ""}`}>
                <span>
                  {actionSentence(
                    action,
                    report.dependabotVersionUpdates,
                    report.thresholds,
                    updateConfigPath(report),
                    dependabotAlertsOn(report),
                  )}
                </span>{" "}
                <EffortTag effort={ACTION_EFFORT[action.kind]} />
              </li>
            ))}
          </ol>
          {top.more > 0 && <p className="chart-subtitle">{c.more(top.more)}</p>}
        </div>
      )}
      <p className="chart-subtitle">{reportCoverage(report)}</p>
      <p className="screen-only">
        <Link
          to={{ pathname: `/repos/${report.repo.id}/security`, search: searchForCodePage(search) }}
          className="button button-secondary"
        >
          {c.detail}
        </Link>
      </p>
    </>
  );
}

/** A compact security summary for the repository page, which prints with the delivery report. */
export function SecuritySection({ repoId, range }: { repoId: number; range: ReportRange }) {
  const report = useSecurityReport(repoId, { from: range.from, to: range.to });
  return (
    <section aria-labelledby="security-section-title" className="section">
      <h2 id="security-section-title" className="section-title">
        {c.title}
      </h2>
      <p className="section-lede">{c.lede}</p>
      {report.isPending && <SkeletonGrid count={4} height={120} label={c.loading} />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {report.data && <Summary report={report.data} />}
    </section>
  );
}
