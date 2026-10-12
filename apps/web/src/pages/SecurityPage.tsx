import { Link, useLocation, useParams } from "react-router";
import type { SecurityReport } from "@dora-dashboard/core";
import { ApiError } from "../api/client";
import { isRecordId, useRepos, useSecurityReport } from "../api/hooks";
import { copy } from "../copy";
import { AlertsTable } from "../components/AlertsTable";
import { BandLabel } from "../components/BandLabel";
import { BranchProtectionCard } from "../components/BranchProtectionCard";
import { ChangeControlCard } from "../components/ChangeControlCard";
import { DateRangeControls } from "../components/DateRangeControls";
import { DependencyTable } from "../components/DependencyTable";
import { DependencyUpdatesCard } from "../components/DependencyUpdatesCard";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { NotReadNotice } from "../components/NotReadNotice";
import { Glossary } from "../components/Glossary";
import { OpenAlertsChart } from "../components/OpenAlertsChart";
import { ScorecardCard } from "../components/ScorecardCard";
import { SecurityActions } from "../components/SecurityActions";
import { SecurityGrade } from "../components/SecurityGrade";
import { SecurityIssuesCard } from "../components/SecurityIssuesCard";
import { SecurityBlock } from "../components/SecurityParts";
import { OpenAlertTiles, TimeToFix } from "../components/SecurityTiles";
import { SourcesPanel } from "../components/SourcesPanel";
import { StartHere } from "../components/StartHere";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { SupplyChainCard } from "../components/SupplyChainCard";
import { WeaknessesChart } from "../components/WeaknessesChart";
import { searchForCodePage } from "../lib/codeDetail";
import { formatDate, formatDateTime, isoDaysAgo } from "../lib/format";
import { alertsReadAt, joinWords, notReadYet, securityPartWeekNote, unreadParts } from "../lib/security";
import { repoName } from "../lib/series";
import { useRangeParams } from "../lib/urlState";
import { partWeek } from "../lib/weekly";

const c = copy.security.page;

function PartlyRead({ report }: { report: SecurityReport }) {
  const missing = unreadParts(report);
  if (missing.length === 0) return null;
  return (
    <aside className="notice notice-warning">
      <p className="notice-title">{c.partlyRead.title}</p>
      <p>{c.partlyRead.body(joinWords(missing))}</p>
      <a href="#security-sources" className="screen-only">
        {c.partlyRead.link}
      </a>
    </aside>
  );
}

function Header({ report, listingName }: { report: SecurityReport | undefined; listingName: string | null }) {
  const readAt = report ? alertsReadAt(report) : null;
  const name = report ? repoName(report.repo) : listingName;
  return (
    <header className="page-header page-header-row">
      <div className="page-header">
        <h1>{c.title}</h1>
        <p className="lede">{name ?? copy.repo.loadingTitle}</p>
        {report && (
          <>
            <p className="lede">
              {c.rangeSummary(formatDate(report.range.from), formatDate(report.range.to))}
              {" · "}
              {readAt ? c.alertsRead(formatDateTime(readAt)) : c.alertsNotRead}
            </p>
            <p className="grade-line">
              <span>{report.grade ? c.gradeLine : c.gradeNone}</span>{" "}
              {report.grade && <BandLabel band={report.grade.overall.band} />}
            </p>
          </>
        )}
      </div>
      {report && <DownloadReportButton subject={repoName(report.repo)} label={c.reportLabel} />}
    </header>
  );
}

function Body({ report }: { report: SecurityReport }) {
  if (notReadYet(report.sources)) {
    // No alert has been measured, so tables and charts of zeros are left out, because zeros would read as all clear.
    // What was read by other means, the workflow files and the branch rules, is facts and not zeros, so it stays.
    return (
      <>
        <NotReadNotice repoId={report.repo.id} />
        {report.supplyChain.status === "ok" && (
          <>
            <SupplyChainCard report={report} group="workflows" />
            <SupplyChainCard report={report} group="files" />
            <SupplyChainCard report={report} group="tools" />
            <SupplyChainCard report={report} group="images" />
          </>
        )}
        {report.posture && <BranchProtectionCard report={report} />}
        <SourcesPanel report={report} />
        <Glossary />
      </>
    );
  }
  // The part week stays on the weekly chart, drawn lighter and marked as partial.
  const part = partWeek(report, isoDaysAgo(0));
  return (
    <>
      <PartlyRead report={report} />
      <StartHere report={report} />
      <SecurityGrade report={report} />
      <SecurityActions report={report} />
      <OpenAlertTiles report={report} />
      <SecurityBlock id="security-weekly" title={copy.security.weekly.title}>
        {part && <p className="section-lede">{securityPartWeekNote(part)}</p>}
        <OpenAlertsChart weekly={report.weekly} part={part} />
      </SecurityBlock>
      <SecurityBlock id="security-weaknesses" title={copy.security.weaknesses.title} lede={copy.security.weaknesses.lede}>
        <WeaknessesChart weaknesses={report.weaknesses} />
      </SecurityBlock>
      <TimeToFix report={report} />
      <AlertsTable report={report} />
      <DependencyTable groups={report.dependencyGroups} />
      <DependencyUpdatesCard report={report} />
      <SupplyChainCard report={report} group="workflows" />
      <SupplyChainCard report={report} group="files" />
      <SupplyChainCard report={report} group="tools" />
      <SupplyChainCard report={report} group="images" />
      <BranchProtectionCard report={report} />
      <ChangeControlCard report={report} />
      <SecurityIssuesCard report={report} />
      <ScorecardCard report={report} />
      <SourcesPanel report={report} />
      <Glossary />
    </>
  );
}

function NotFound() {
  return (
    <div className="notice notice-info" role="status">
      <p className="notice-title">{c.notFoundTitle}</p>
      <p>{c.notFoundBody}</p>
      <Link to="/security" className="button button-secondary">
        {c.toList}
      </Link>
    </div>
  );
}

function SecurityView({ id }: { id: number }) {
  const { search } = useLocation();
  const [range, setRange] = useRangeParams();
  const report = useSecurityReport(id, { from: range.from, to: range.to });
  const repos = useRepos();
  const listing = repos.data?.find((repo) => repo.id === id);
  const notFound = report.isError && report.error instanceof ApiError && report.error.status === 404;

  return (
    <div className="page">
      <StickyPanel>
        <Link to={{ pathname: `/repos/${id}`, search: searchForCodePage(search) }} className="back-link">
          {c.backToRepo}
        </Link>
        <Header report={report.data} listingName={listing ? repoName(listing) : null} />
        <div className="controls-bar">
          <DateRangeControls value={range} onChange={setRange} showBots={false} />
        </div>
      </StickyPanel>
      <p className="lede">{c.lede}</p>

      {listing?.crawlStatus === "crawling" && (
        <p className="notice notice-info" role="status">
          {c.crawlInProgress}
        </p>
      )}
      {notFound && <NotFound />}
      {report.isPending && <SkeletonGrid count={4} height={150} label={c.loading} />}
      {report.isError && !notFound && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {report.data && (
        <div className={report.isPlaceholderData ? "is-refreshing" : undefined} aria-busy={report.isFetching}>
          <Body report={report.data} />
        </div>
      )}
    </div>
  );
}

/** The security report of one repository, at /repos/:id/security, with the date range held in the address. */
export function SecurityPage() {
  const id = Number(useParams().id);
  // An address that does not name a repository is answered here, without asking the API.
  if (!isRecordId(id)) {
    return (
      <div className="page">
        <Link to="/security" className="back-link">
          {c.toList}
        </Link>
        <EmptyState title={c.invalidAddress} />
      </div>
    );
  }
  return <SecurityView id={id} />;
}
