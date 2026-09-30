import { Link, useParams } from "react-router";
import type { RepoReport } from "@dora-dashboard/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { useRepos, useReport, type ReportRange } from "../api/hooks";
import { copy } from "../copy";
import { AuthorFilter } from "../components/AuthorFilter";
import { AuthorsTable } from "../components/AuthorsTable";
import { CodeHealthSection } from "../components/CodeHealthSection";
import { DateRangeControls } from "../components/DateRangeControls";
import { DoraTile } from "../components/DoraTile";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { PrTable } from "../components/PrTable";
import { RepoCharts } from "../components/RepoCharts";
import { StatTile } from "../components/StatTile";
import { ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { everyoneLeftOut, excludedInRange } from "../lib/authorFilter";
import { doraFigures } from "../lib/dora";
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent } from "../lib/format";
import { repoName } from "../lib/series";
import { useListParam, useRangeParams } from "../lib/urlState";

function FlowTiles({ report }: { report: RepoReport }) {
  const { totals, summary } = report;
  return (
    <div className="tile-grid tile-grid-flow">
      <StatTile label={copy.flow.merged} value={formatNumber(totals.merged, 0)} hint={copy.flow.mergedHint(totals.opened)} />
      <StatTile label={copy.flow.coding} value={formatDuration(summary.codingHours.median)} hint={copy.flow.codingHint} />
      <StatTile
        label={copy.flow.firstReview}
        value={formatDuration(summary.firstReviewHours.median)}
        hint={copy.flow.firstReviewHint}
      />
      <StatTile
        label={copy.flow.openToMerge}
        value={formatDuration(summary.openToMergeHours.median)}
        hint={copy.flow.openToMergeHint(formatDuration(summary.openToMergeHours.p75))}
      />
      <StatTile label={copy.flow.reviewed} value={formatPercent(totals.reviewedShare)} hint={copy.flow.reviewedHint} />
      <StatTile label={copy.flow.selfMerged} value={formatPercent(totals.selfMergedShare)} hint={copy.flow.selfMergedHint} />
      <StatTile
        label={copy.flow.perAuthorWeek}
        value={formatNumber(totals.mergedPerAuthorWeek, 2)}
        hint={copy.flow.perAuthorWeekHint}
      />
    </div>
  );
}

function RepoHeader({ report, leftOut }: { report: RepoReport | undefined; leftOut: string[] }) {
  return (
    <header className="page-header page-header-row">
      <div className="page-header">
        <h1>{report ? repoName(report.repo) : copy.repo.loadingTitle}</h1>
        {report && (
          <p className="lede">
            {copy.repo.rangeSummary(formatDate(report.range.from), formatDate(report.range.to))}
            {report.repo.lastCrawledAt && ` · ${copy.repo.lastCrawled(formatDateTime(report.repo.lastCrawledAt))}`}
          </p>
        )}
        {leftOut.length > 0 && <p className="lede">{copy.repo.excludingAuthors(leftOut)}</p>}
      </div>
      {report && <DownloadReportButton subject={repoName(report.repo)} />}
    </header>
  );
}

interface ReportBodyProps {
  report: RepoReport;
  repoId: number;
  range: ReportRange;
}

function ReportBody({ report, repoId, range }: ReportBodyProps) {
  return (
    <>
      <section aria-labelledby="dora-title" className="section">
        <h2 id="dora-title" className="section-title">
          {copy.dora.title}
        </h2>
        <p className="section-lede">{copy.dora.lede}</p>
        <div className="tile-grid">
          {doraFigures(report).map((figure) => (
            <DoraTile
              key={figure.id}
              title={figure.title}
              definition={figure.definition}
              value={figure.value}
              band={figure.band}
              detail={figure.detail}
              reason={figure.reason}
            />
          ))}
        </div>
      </section>

      <CodeHealthSection repoId={repoId} range={range} />

      <section aria-labelledby="flow-title" className="section">
        <h2 id="flow-title" className="section-title">
          {copy.flow.title}
        </h2>
        <p className="section-lede">{copy.flow.lede}</p>
        <FlowTiles report={report} />
      </section>

      <section className="section">
        <RepoCharts report={report} />
      </section>

      <section aria-labelledby="authors-title" className="section card">
        <h2 id="authors-title" className="section-title">
          {copy.authors.title}
        </h2>
        <p className="chart-subtitle">{copy.authors.subtitle}</p>
        <AuthorsTable authors={report.authors} caption={copy.authors.title} />
      </section>

      <section aria-labelledby="prs-title" className="section card">
        <h2 id="prs-title" className="section-title">
          {copy.prTable.title}
        </h2>
        <p className="chart-subtitle">{copy.prTable.subtitle}</p>
        <PrTable prs={report.prs} />
      </section>
    </>
  );
}

function InfoNotice({ text }: { text: string }) {
  return (
    <p className="notice notice-info" role="status">
      {text}
    </p>
  );
}

/** True while the crawler is fetching this repository, from the repository list. */
function useIsCrawling(id: number): boolean {
  const repos = useRepos();
  return repos.data?.find((r) => r.id === id)?.crawlStatus === "crawling";
}

interface ReportStateProps {
  query: UseQueryResult<RepoReport>;
  repoId: number;
  range: ReportRange;
}

/** The report's loading skeleton, error and body. The body stays while a refetch fails, as before. */
function ReportState({ query, repoId, range }: ReportStateProps) {
  return (
    <>
      {query.isPending && (
        <>
          <SkeletonGrid count={4} height={150} />
          <Skeleton height={320} />
        </>
      )}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && (
        <div className={query.isPlaceholderData ? "is-refreshing" : undefined} aria-busy={query.isFetching}>
          <ReportBody report={query.data} repoId={repoId} range={range} />
        </div>
      )}
    </>
  );
}

export function RepoPage() {
  const params = useParams();
  const id = Number(params.id);
  const [range, setRange] = useRangeParams();
  const [excluded, setExcluded] = useListParam("exclude");
  const report = useReport(id, range, excluded);
  const crawling = useIsCrawling(id);
  const choices = report.data?.authorChoices ?? [];
  const leftOut = excludedInRange(choices, excluded);

  return (
    <div className="page">
      <Link to="/repos" className="back-link">
        {copy.common.backToRepos}
      </Link>
      <RepoHeader report={report.data} leftOut={leftOut} />

      <div className="controls-bar">
        <DateRangeControls value={range} onChange={setRange} />
        {choices.length > 0 && <AuthorFilter choices={choices} excluded={excluded} onChange={setExcluded} />}
      </div>

      {everyoneLeftOut(choices, leftOut) && <InfoNotice text={copy.authorFilter.noneChosen} />}
      {crawling && <InfoNotice text={copy.repo.crawlInProgress} />}

      <ReportState query={report} repoId={id} range={range} />
    </div>
  );
}
