import { Link, useParams } from "react-router";
import type { RepoReport } from "@dora-dashboard/core";
import { useRepos, useReport } from "../api/hooks";
import { copy } from "../copy";
import { AuthorsTable } from "../components/AuthorsTable";
import { DateRangeControls } from "../components/DateRangeControls";
import { DoraTile } from "../components/DoraTile";
import { PrTable } from "../components/PrTable";
import { RepoCharts } from "../components/RepoCharts";
import { StatTile } from "../components/StatTile";
import { ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { doraFigures } from "../lib/dora";
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent } from "../lib/format";
import { repoName } from "../lib/series";
import { useRangeParams } from "../lib/urlState";

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

export function RepoPage() {
  const params = useParams();
  const id = Number(params.id);
  const [range, setRange] = useRangeParams();
  const report = useReport(id, range);
  const repos = useRepos();
  const crawling = repos.data?.find((r) => r.id === id)?.crawlStatus === "crawling";
  const data = report.data;

  return (
    <div className="page">
      <Link to="/" className="back-link">
        {copy.common.backToRepos}
      </Link>
      <header className="page-header">
        <h1>{data ? repoName(data.repo) : copy.repo.loadingTitle}</h1>
        {data && (
          <p className="lede">
            {copy.repo.rangeSummary(formatDate(data.range.from), formatDate(data.range.to))}
            {data.repo.lastCrawledAt && ` · ${copy.repo.lastCrawled(formatDateTime(data.repo.lastCrawledAt))}`}
          </p>
        )}
      </header>

      <div className="controls-bar">
        <DateRangeControls value={range} onChange={setRange} />
      </div>

      {crawling && (
        <p className="notice notice-info" role="status">
          {copy.repo.crawlInProgress}
        </p>
      )}

      {report.isPending && (
        <>
          <SkeletonGrid count={4} height={150} />
          <Skeleton height={320} />
        </>
      )}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}

      {data && (
        <div className={report.isPlaceholderData ? "is-refreshing" : undefined} aria-busy={report.isFetching}>
          <section aria-labelledby="dora-title" className="section">
            <h2 id="dora-title" className="section-title">
              {copy.dora.title}
            </h2>
            <p className="section-lede">{copy.dora.lede}</p>
            <div className="tile-grid">
              {doraFigures(data).map((figure) => (
                <DoraTile key={figure.id} {...figure} />
              ))}
            </div>
          </section>

          <section aria-labelledby="flow-title" className="section">
            <h2 id="flow-title" className="section-title">
              {copy.flow.title}
            </h2>
            <p className="section-lede">{copy.flow.lede}</p>
            <FlowTiles report={data} />
          </section>

          <section className="section">
            <RepoCharts report={data} />
          </section>

          <section aria-labelledby="authors-title" className="section card">
            <h2 id="authors-title" className="section-title">
              {copy.authors.title}
            </h2>
            <p className="chart-subtitle">{copy.authors.subtitle}</p>
            <AuthorsTable authors={data.authors} caption={copy.authors.title} />
          </section>

          <section aria-labelledby="prs-title" className="section card">
            <h2 id="prs-title" className="section-title">
              {copy.prTable.title}
            </h2>
            <p className="chart-subtitle">{copy.prTable.subtitle}</p>
            <PrTable prs={data.prs} />
          </section>
        </div>
      )}
    </div>
  );
}
