import { Link, useParams } from "react-router";
import type { SpaceReport } from "@dora-dashboard/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { useSpaceReport } from "../api/hooks";
import { copy } from "../copy";
import { DateRangeControls } from "../components/DateRangeControls";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { SpaceHygiene } from "../components/SpaceHygiene";
import { AgeingTable, ColumnTimeChart, ColumnTimeTable, InProgressChart, ThroughputChart } from "../components/SpaceCharts";
import { StatTile } from "../components/StatTile";
import { ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { Toggle } from "../components/Toggle";
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent } from "../lib/format";
import { shareOf } from "../lib/space";
import { useFlagParam, useRangeParams } from "../lib/urlState";

function SpaceHeader({ report }: { report: SpaceReport | undefined }) {
  const text = copy.space;
  return (
    <header className="page-header page-header-row">
      <div className="page-header">
        <h1>{report ? report.space.name : text.loadingTitle}</h1>
        {report && (
          <p className="lede">
            {text.rangeSummary(formatDate(report.range.from), formatDate(report.range.to))}
            {report.space.lastCrawledAt && ` · ${text.lastCrawled(formatDateTime(report.space.lastCrawledAt))}`}
          </p>
        )}
      </div>
      {report && <DownloadReportButton subject={report.space.name} />}
    </header>
  );
}

function HeadlineTiles({ report }: { report: SpaceReport }) {
  const text = copy.space.headline;
  const { totals, issueCycleTime, issueLeadTime, ideaToProduction } = report;
  return (
    <section aria-labelledby="space-headline-title" className="section">
      <h2 id="space-headline-title" className="section-title">
        {text.title}
      </h2>
      <p className="section-lede">{text.lede}</p>
      <div className="tile-grid tile-grid-flow">
        <StatTile label={text.done} value={formatNumber(totals.done, 0)} hint={text.doneHint(totals.created)} />
        <StatTile
          label={text.inProgress}
          value={formatNumber(totals.inProgress, 0)}
          hint={text.inProgressHint(totals.epicsOpen)}
        />
        <StatTile
          label={text.cycle}
          value={formatDuration(issueCycleTime.median)}
          hint={text.cycleHint(formatDuration(issueCycleTime.p75))}
        />
        <StatTile
          label={text.lead}
          value={formatDuration(issueLeadTime.median)}
          hint={text.leadHint(formatDuration(issueLeadTime.p75))}
        />
        <StatTile label={text.flowEfficiency} value={formatPercent(report.flowEfficiency)} hint={text.flowEfficiencyHint} />
        <StatTile
          label={text.linked}
          value={formatPercent(shareOf(ideaToProduction.linked, ideaToProduction.of))}
          hint={text.linkedHint(ideaToProduction.linked, ideaToProduction.of)}
        />
      </div>
    </section>
  );
}

function IdeaToProduction({ report }: { report: SpaceReport }) {
  const text = copy.space.idea;
  const { toFirstPr, toProduction, linked, of } = report.ideaToProduction;
  return (
    <section aria-labelledby="space-idea-title" className="section">
      <h2 id="space-idea-title" className="section-title">
        {text.title}
      </h2>
      <p className="section-lede">{text.lede(linked, of, formatPercent(shareOf(linked, of)))}</p>
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

function SpaceBody({ report, people }: { report: SpaceReport; people: boolean }) {
  return (
    <>
      <HeadlineTiles report={report} />

      <section aria-labelledby="space-flow-title" className="section">
        <h2 id="space-flow-title" className="section-title">
          {copy.space.flow.title}
        </h2>
        <p className="section-lede">{copy.space.flow.lede}</p>
        <div className="chart-grid">
          <ThroughputChart weekly={report.weekly} />
          <InProgressChart weekly={report.weekly} />
        </div>
        <AgeingTable items={report.ageing} siteUrl={report.space.siteUrl} />
      </section>

      <section aria-labelledby="space-columns-title" className="section">
        <h2 id="space-columns-title" className="section-title">
          {copy.space.columns.title}
        </h2>
        <p className="section-lede">{copy.space.columns.lede}</p>
        <ColumnTimeChart columns={report.columns} />
        <ColumnTimeTable columns={report.columns} />
      </section>

      <IdeaToProduction report={report} />

      <section aria-labelledby="space-hygiene-title" className="section">
        <h2 id="space-hygiene-title" className="section-title">
          {copy.space.hygiene.title}
        </h2>
        <p className="section-lede">{copy.space.hygiene.lede}</p>
        <SpaceHygiene findings={report.hygiene} siteUrl={report.space.siteUrl} people={people} />
      </section>
    </>
  );
}

function ReportState({ query, people }: { query: UseQueryResult<SpaceReport>; people: boolean }) {
  if (query.isError && query.error instanceof ApiError && query.error.status === 404) {
    return (
      <div className="notice notice-info" role="status">
        <p className="notice-title">{copy.space.notFoundTitle}</p>
        <p>{copy.space.notFoundBody}</p>
        <Link to="/spaces" className="button button-secondary">
          {copy.space.toSpaces}
        </Link>
      </div>
    );
  }
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
          <SpaceBody report={query.data} people={people} />
        </div>
      )}
    </>
  );
}

export function SpacePage() {
  const params = useParams();
  const id = Number(params.id);
  const [range, setRange] = useRangeParams();
  const [people, setPeople] = useFlagParam("people");
  const report = useSpaceReport(id, { from: range.from, to: range.to }, people);

  return (
    <div className="page">
      <StickyPanel>
        <Link to="/spaces" className="back-link">
          {copy.common.backToSpaces}
        </Link>
        <SpaceHeader report={report.data} />
        <div className="controls-bar">
          <DateRangeControls value={range} onChange={setRange} showBots={false} />
          <Toggle label={copy.space.showPeople} hint={copy.space.showPeopleHint} checked={people} onChange={setPeople} />
        </div>
      </StickyPanel>

      <ReportState query={report} people={people} />
    </div>
  );
}
