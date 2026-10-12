import { Link } from "react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { SecuritySummary } from "@dora-dashboard/core";
import { useHealth, useSecurityList } from "../api/hooks";
import { copy } from "../copy";
import { BandLabel } from "../components/BandLabel";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { StatTile } from "../components/StatTile";
import { StickyPanel } from "../components/StickyPanel";
import { formatNumber } from "../lib/format";
import {
  actionSentence,
  joinWords,
  neverCrawled,
  lastRead,
  listTotals,
  openSummary,
  sourceCoverage,
  splitGraded,
} from "../lib/security";
import { repoName } from "../lib/series";

const c = copy.security.list;

function Row({ summary }: { summary: SecuritySummary }) {
  const name = repoName(summary.repo);
  const score = summary.scorecard;
  const unread = !summary.read;
  const figure = (text: string) => (unread ? (neverCrawled(summary.sources) ? c.notReadRow : c.notUsedRow) : text);
  return (
    <li className="card repo-row">
      <div className="repo-row-body">
        <h3 className="repo-name">
          <Link to={`/repos/${summary.repo.id}/security`} aria-label={c.open(name)}>
            {name}
          </Link>
        </h3>
        <dl className="repo-facts">
          <div>
            <dt>{c.facts.grade}</dt>
            <dd>{summary.band ? <BandLabel band={summary.band} /> : c.facts.notGraded}</dd>
          </div>
          <div>
            <dt>{c.facts.open}</dt>
            <dd>{figure(openSummary(summary.open))}</dd>
          </div>
          <div>
            <dt>{c.facts.pastFix}</dt>
            <dd>{figure(formatNumber(summary.pastFix, 0))}</dd>
          </div>
          <div>
            <dt>{c.facts.actions}</dt>
            <dd>{figure(formatNumber(summary.actions, 0))}</dd>
          </div>
          <div>
            <dt>{c.facts.read}</dt>
            <dd>{lastRead(summary.readAt)}</dd>
          </div>
          {score !== null && (
            <div>
              <dt>{c.facts.scorecard}</dt>
              <dd>{c.facts.scorecardValue(score)}</dd>
            </div>
          )}
        </dl>
        {summary.band === null && summary.gradeMissing && (
          <p className="chart-subtitle">{c.gradeMissing[summary.gradeMissing]}</p>
        )}
        {summary.topAction && (
          <p>
            <strong>{c.startWith}</strong>{" "}
            {actionSentence(summary.topAction, summary.dependabotVersionUpdates, summary.thresholds)}
          </p>
        )}
        {summary.dependabotVersionUpdates !== null && (
          <p className="chart-subtitle">{copy.security.dependabotAlerts.what(summary.dependabotVersionUpdates)}</p>
        )}
        <p className="chart-subtitle">{sourceCoverage(summary)}</p>
      </div>
    </li>
  );
}

function Group({ id, title, lede, rows }: { id: string; title: string; lede: string; rows: SecuritySummary[] }) {
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id} className="section-title">
        {title}
      </h2>
      <p className="section-lede">{lede}</p>
      {rows.length === 0 ? (
        <p className="chart-empty">{c.noneGraded}</p>
      ) : (
        <ul className="repo-list">
          {rows.map((summary) => (
            <Row key={summary.repo.id} summary={summary} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Body({ summaries }: { summaries: SecuritySummary[] }) {
  const health = useHealth();
  const totals = listTotals(summaries);
  const readFrom = c.tiles.readFrom(totals.read, totals.total);
  const { graded, notGraded } = splitGraded(summaries);
  return (
    <>
      <div className="tile-grid">
        <StatTile
          label={c.tiles.critical}
          value={formatNumber(totals.openCritical, 0)}
          hint={`${c.tiles.criticalHint} ${readFrom}`}
        />
        <StatTile
          label={c.tiles.pastFix}
          value={formatNumber(totals.pastFix, 0)}
          tone={totals.pastFix > 0 ? "danger" : undefined}
          hint={`${c.tiles.pastFixHint(totals.pastFix)} ${readFrom}`}
        />
        <StatTile label={c.tiles.notGraded} value={formatNumber(totals.notGraded, 0)} hint={c.tiles.notGradedHint} />
      </div>
      {totals.failed.length > 0 && (
        <aside className="notice notice-warning">
          <p className="notice-title">{c.failedTitle}</p>
          <p>{c.failedBody(joinWords(totals.failed.map((s) => repoName(s.repo))))}</p>
        </aside>
      )}
      {health.isSuccess && health.data.osv !== true && (
        <aside className="notice notice-info">
          <p>{c.osvOff}</p>
        </aside>
      )}
      <Group id="security-graded" title={c.gradedTitle} lede={c.gradedLede} rows={graded} />
      {notGraded.length > 0 && (
        <Group id="security-not-graded" title={c.notGradedTitle} lede={c.notGradedLede} rows={notGraded} />
      )}
    </>
  );
}

function Outcome({ list }: { list: UseQueryResult<SecuritySummary[]> }) {
  if (list.isPending) return <Skeleton height={160} label={c.loading} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.length === 0) {
    return (
      <EmptyState title={c.emptyTitle}>
        <p>{c.emptyBody}</p>
        <Link to="/repos" className="button button-secondary">
          {c.toRepos}
        </Link>
      </EmptyState>
    );
  }
  return <Body summaries={list.data} />;
}

/** Every repository's security grade, worst first, each linking to its report. Built from the summaries the API projects. */
export function SecurityListPage() {
  const list = useSecurityList();
  return (
    <div className="page">
      <StickyPanel>
        <header className="page-header page-header-row">
          <div className="page-header">
            <h1>{c.title}</h1>
            <p className="lede">{c.lede}</p>
          </div>
          {list.data && list.data.length > 0 && <DownloadReportButton subject={c.reportSubject} label={c.reportLabel} />}
        </header>
      </StickyPanel>
      <Outcome list={list} />
    </div>
  );
}
