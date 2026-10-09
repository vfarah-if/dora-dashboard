import { Link, useParams } from "react-router";
import type { IssueReport, RepoListing } from "@dora-dashboard/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { isRecordId, useIssueReport, useRepos } from "../api/hooks";
import { copy } from "../copy";
import { DateRangeControls } from "../components/DateRangeControls";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { IssueHygiene } from "../components/IssueHygiene";
import {
  AgeingTable,
  ClosedByKindChart,
  OpenAtEndChart,
  OpenByKindChart,
  OpenByPriorityChart,
  OpenedClosedChart,
  TimeToCloseChart,
  TimeToCloseTable,
} from "../components/IssueCharts";
import { StatTile } from "../components/StatTile";
import { ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { Toggle } from "../components/Toggle";
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent, isoDaysAgo } from "../lib/format";
import { issuePartWeekNote, oldestOpen } from "../lib/issues";
import { repoName } from "../lib/series";
import { shareOf } from "../lib/space";
import { useFlagParam, useRangeParams } from "../lib/urlState";
import { partWeek } from "../lib/weekly";

function IssueHeader({ report }: { report: IssueReport | undefined }) {
  const text = copy.issue;
  return (
    <header className="page-header page-header-row">
      <div className="page-header">
        <h1>{report ? repoName(report.repo) : text.loadingTitle}</h1>
        {report && (
          <p className="lede">
            {text.rangeSummary(formatDate(report.range.from), formatDate(report.range.to))}
            {report.repo.lastCrawledAt && ` · ${text.lastCrawled(formatDateTime(report.repo.lastCrawledAt))}`}
          </p>
        )}
      </div>
      {report && <DownloadReportButton subject={repoName(report.repo)} label={copy.issue.reportLabel} />}
    </header>
  );
}

function HeadlineTiles({ report }: { report: IssueReport }) {
  const text = copy.issue.headline;
  const { totals, timeToClose, linkedShare, ageing } = report;
  const oldest = oldestOpen(ageing);
  return (
    <section aria-labelledby="issue-headline-title" className="section">
      <h2 id="issue-headline-title" className="section-title">
        {text.title}
      </h2>
      <p className="section-lede">{text.lede}</p>
      <div className="tile-grid tile-grid-flow">
        <StatTile label={text.opened} value={formatNumber(totals.opened, 0)} hint={text.openedHint} />
        <StatTile label={text.closed} value={formatNumber(totals.closed, 0)} hint={text.closedHint(totals.notPlanned)} />
        <StatTile label={text.open} value={formatNumber(totals.open, 0)} hint={text.openHint(totals.openEpics)} />
        <StatTile
          label={text.timeToClose}
          value={formatDuration(timeToClose.median)}
          hint={text.timeToCloseHint(formatDuration(timeToClose.p75))}
        />
        <StatTile
          label={text.linked}
          value={formatPercent(shareOf(linkedShare.linked, linkedShare.total))}
          hint={text.linkedHint(linkedShare.linked, linkedShare.total)}
        />
        <StatTile
          label={text.oldest}
          value={formatDuration(oldest?.ageHours ?? null)}
          hint={oldest ? text.oldestHint(oldest.number) : text.oldestNone}
        />
      </div>
    </section>
  );
}

function IdeaToProduction({ report }: { report: IssueReport }) {
  const text = copy.issue.idea;
  const { toFirstPr, toProduction } = report.ideaToProduction;
  const { linked, total } = report.linkedShare;
  return (
    <section aria-labelledby="issue-idea-title" className="section">
      <h2 id="issue-idea-title" className="section-title">
        {text.title}
      </h2>
      <p className="section-lede">{text.lede(linked, total, formatPercent(shareOf(linked, total)))}</p>
      <div className="tile-grid">
        <StatTile
          label={text.toFirstPr}
          value={formatDuration(toFirstPr.median)}
          hint={text.toFirstPrHint(formatDuration(toFirstPr.p75), toFirstPr.count)}
        />
        <StatTile
          label={text.toProduction}
          value={formatDuration(toProduction.median)}
          hint={text.toProductionHint(formatDuration(toProduction.p75), toProduction.count)}
        />
      </div>
    </section>
  );
}

function IssueBody({ report, people }: { report: IssueReport; people: boolean }) {
  // The part week stays on the weekly charts, drawn lighter and marked as partial.
  const part = partWeek(report, isoDaysAgo(0));
  return (
    <>
      <HeadlineTiles report={report} />

      <section aria-labelledby="issue-flow-title" className="section">
        <h2 id="issue-flow-title" className="section-title">
          {copy.issue.flow.title}
        </h2>
        <p className="section-lede">{copy.issue.flow.lede}</p>
        {part && <p className="section-lede">{issuePartWeekNote(part)}</p>}
        <div className="chart-grid">
          <OpenedClosedChart weekly={report.weekly} part={part} />
          <ClosedByKindChart weekly={report.weekly} part={part} />
          <OpenAtEndChart weekly={report.weekly} part={part} />
        </div>
      </section>

      <section aria-labelledby="issue-open-title" className="section">
        <h2 id="issue-open-title" className="section-title">
          {copy.issue.open.title}
        </h2>
        <p className="section-lede">{copy.issue.open.lede}</p>
        <div className="chart-grid">
          <OpenByKindChart openByKind={report.openByKind} />
          <OpenByPriorityChart openByPriority={report.openByPriority} />
          <TimeToCloseChart byPriority={report.timeToCloseByPriority} />
        </div>
        <TimeToCloseTable byPriority={report.timeToCloseByPriority} />
        <AgeingTable items={report.ageing} total={report.ageingTotal} people={people} />
      </section>

      <IdeaToProduction report={report} />

      <section aria-labelledby="issue-hygiene-title" className="section">
        <h2 id="issue-hygiene-title" className="section-title">
          {copy.issue.hygiene.title}
        </h2>
        <p className="section-lede">{copy.issue.hygiene.lede}</p>
        <IssueHygiene findings={report.hygiene} people={people} staleUrgentDays={report.staleUrgentDays} />
      </section>
    </>
  );
}

function IssueNotFound() {
  return (
    <div className="notice notice-info" role="status">
      <p className="notice-title">{copy.issue.notFoundTitle}</p>
      <p>{copy.issue.notFoundBody}</p>
      <Link to="/issues" className="button button-secondary">
        {copy.issue.toIssues}
      </Link>
    </div>
  );
}

/** What the repositories list says about this repository: a failed crawl, a failed read of issues, a crawl under way. */
function ListingNotices({ listing }: { listing: RepoListing | undefined }) {
  const text = copy.issue;
  if (!listing) return null;
  return (
    <>
      {listing.crawlStatus === "failed" && (
        <div className="notice notice-warning" role="alert">
          <p className="notice-title">{text.crawlFailedTitle}</p>
          <p>{text.crawlFailedBody}</p>
          {listing.crawlError && <p>{text.crawlFailedReason(listing.crawlError)}</p>}
        </div>
      )}
      {listing.issueError && (
        <div className="notice notice-warning" role="alert">
          <p className="notice-title">{text.issueErrorTitle}</p>
          <p>{text.issueErrorBody}</p>
          <p>{text.issueErrorReason(listing.issueError)}</p>
        </div>
      )}
      {listing.issuesEnabled === false && (
        <div className="notice notice-info" role="status">
          <p className="notice-title">{text.issuesDisabledTitle}</p>
          <p>{text.issuesDisabledBody}</p>
        </div>
      )}
      {listing.crawlStatus === "crawling" && (
        <p className="notice notice-info" role="status">
          {copy.repo.crawlInProgress}
        </p>
      )}
    </>
  );
}

function ReportState({ query, people }: { query: UseQueryResult<IssueReport>; people: boolean }) {
  if (query.isError && query.error instanceof ApiError && query.error.status === 404) return <IssueNotFound />;
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
          <IssueBody report={query.data} people={people} />
        </div>
      )}
    </>
  );
}

export function IssuePage() {
  const id = Number(useParams().id);
  // An address that does not name a repository is answered here, without asking the API.
  if (!isRecordId(id)) {
    return (
      <div className="page">
        <Link to="/issues" className="back-link">
          {copy.common.backToIssues}
        </Link>
        <IssueNotFound />
      </div>
    );
  }
  return <IssueView id={id} />;
}

function IssueView({ id }: { id: number }) {
  const [range, setRange] = useRangeParams();
  const [people, setPeople] = useFlagParam("people");
  const report = useIssueReport(id, { from: range.from, to: range.to }, people);
  const repos = useRepos();
  const listing = repos.data?.find((repo) => repo.id === id);
  const notFound = report.isError && report.error instanceof ApiError && report.error.status === 404;

  return (
    <div className="page">
      <StickyPanel>
        <Link to="/issues" className="back-link">
          {copy.common.backToIssues}
        </Link>
        <IssueHeader report={report.data} />
        <div className="controls-bar">
          <DateRangeControls value={range} onChange={setRange} showBots={false} />
          <Toggle label={copy.issue.showPeople} hint={copy.issue.showPeopleHint} checked={people} onChange={setPeople} />
        </div>
      </StickyPanel>

      {!notFound && repos.isError && (
        <div className="notice notice-warning" role="alert">
          <p className="notice-title">{copy.issue.reposFailedTitle}</p>
          <p>{copy.issue.reposFailedBody}</p>
        </div>
      )}
      {!notFound && <ListingNotices listing={listing} />}
      <ReportState query={report} people={people} />
    </div>
  );
}
