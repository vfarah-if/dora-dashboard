import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { RepoReport } from "@dora-dashboard/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { isRecordId, useRepos, useReport, type ReportRange } from "../api/hooks";
import { hasIssueStatus } from "../lib/issues";
import { copy } from "../copy";
import { AiCohorts } from "../components/AiCohorts";
import { AuthorFilter } from "../components/AuthorFilter";
import { AuthorsTable } from "../components/AuthorsTable";
import { CodeHealthSection } from "../components/CodeHealthSection";
import { DateRangeControls } from "../components/DateRangeControls";
import { DoraTile } from "../components/DoraTile";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { PrTable } from "../components/PrTable";
import { ProfileLine } from "../components/ProfileLine";
import { PartWeekNote, RepoCharts } from "../components/RepoCharts";
import { StatTile } from "../components/StatTile";
import { ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { everyoneLeftOut, excludedInRange } from "../lib/authorFilter";
import { doraFigures, reworkFigure } from "../lib/dora";
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
  const { hash } = useLocation();
  // The report arrives after the page loads, so a link to a section has nothing to land on until now.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.();
  }, [hash]);
  return (
    <>
      <section aria-labelledby="dora-title" className="section">
        <h2 id="dora-title" className="section-title">
          {copy.dora.title}
        </h2>
        <p className="section-lede">{copy.dora.lede}</p>
        <ProfileLine profile={report.dora.profile} />
        <div className="tile-grid">
          {[...doraFigures(report), reworkFigure(report)].map((figure) => (
            <DoraTile
              key={figure.id}
              title={figure.title}
              definition={figure.definition}
              value={figure.value}
              band={figure.band}
              detail={figure.detail}
              reason={figure.reason}
              noBandNote={figure.noBandNote}
              explanation={figure.explanation}
            />
          ))}
        </div>
      </section>

      <AiCohorts cohorts={report.aiCohorts} />

      <CodeHealthSection repoId={repoId} range={range} />

      <section aria-labelledby="flow-title" className="section">
        <h2 id="flow-title" className="section-title">
          {copy.flow.title}
        </h2>
        <p className="section-lede">{copy.flow.lede}</p>
        <FlowTiles report={report} />
      </section>

      <section className="section">
        <PartWeekNote report={report} />
        <RepoCharts report={report} />
      </section>

      <section aria-labelledby="authors-title" className="section card">
        <h2 id="authors-title" className="section-title">
          {copy.authors.title}
        </h2>
        <p className="chart-subtitle">{copy.authors.subtitle}</p>
        <AuthorsTable authors={report.authors} caption={copy.authors.title} />
      </section>

      <section aria-labelledby="prs-title" className="section card screen-only">
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

/** This repository's row in the repository list, once the list has loaded. */
function useListing(id: number) {
  return useRepos().data?.find((r) => r.id === id);
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
  const id = Number(useParams().id);
  // An address that does not name a repository is answered here, without asking the API.
  if (!isRecordId(id)) {
    return (
      <div className="page">
        <Link to="/repos" className="back-link">
          {copy.common.backToRepos}
        </Link>
        <div className="notice notice-info" role="status">
          <p className="notice-title">{copy.repo.notFound}</p>
          <Link to="/repos" className="button button-secondary">
            {copy.repo.toRepos}
          </Link>
        </div>
      </div>
    );
  }
  return <RepoView id={id} />;
}

function RepoView({ id }: { id: number }) {
  const { search } = useLocation();
  const [range, setRange] = useRangeParams();
  const [excluded, setExcluded] = useListParam("exclude");
  const report = useReport(id, range, excluded);
  const listing = useListing(id);
  const crawling = listing?.crawlStatus === "crawling";
  const showIssuesLink = listing !== undefined && hasIssueStatus(listing);
  const choices = report.data?.authorChoices ?? [];
  const leftOut = excludedInRange(choices, excluded);

  return (
    <div className="page">
      <StickyPanel>
        <Link to="/repos" className="back-link">
          {copy.common.backToRepos}
        </Link>
        <RepoHeader report={report.data} leftOut={leftOut} />
        <p className="button-row">
          <Link to={{ pathname: `/repos/${id}/code`, search }} className="button button-secondary">
            {copy.codeAnalysis.repoLink}
          </Link>
          {showIssuesLink && (
            <Link to={`/issues/${id}`} className="button button-secondary">
              {copy.repo.issuesLink}
            </Link>
          )}
        </p>

        <div className="controls-bar">
          <DateRangeControls value={range} onChange={setRange} />
          {choices.length > 0 && <AuthorFilter choices={choices} excluded={excluded} onChange={setExcluded} />}
        </div>
      </StickyPanel>

      {everyoneLeftOut(choices, leftOut) && <InfoNotice text={copy.authorFilter.noneChosen} />}
      {crawling && <InfoNotice text={copy.repo.crawlInProgress} />}

      <ReportState query={report} repoId={id} range={range} />
    </div>
  );
}
