import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Band, RepoReport } from "@dora-dashboard/core";
import { useCompare, type ReportRange } from "../api/hooks";
import { copy } from "../copy";
import { AuthorsTable } from "../components/AuthorsTable";
import { BandLabel } from "../components/BandLabel";
import { CompareCharts } from "../components/CompareCharts";
import { DateRangeControls } from "../components/DateRangeControls";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { ProfileLine } from "../components/ProfileLine";
import { EmptyState, ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { Toggle } from "../components/Toggle";
import { StickyPanel } from "../components/StickyPanel";
import { compareWeekly, overlappingRange } from "../lib/compare";
import { repoDoraHref } from "../lib/dora";
import { formatDuration, formatNumber, formatPercent } from "../lib/format";
import { MAX_SERIES, repoName, seriesFor, type SeriesMeta } from "../lib/series";
import { parseIds, useFlagParam, useRangeParams } from "../lib/urlState";

interface HeadlineRow {
  label: string;
  values: (report: RepoReport) => ReactNode;
}

function dora(value: string | null, band: Band | null): ReactNode {
  if (value === null) return <span className="text-muted">{copy.dora.notMeasured}</span>;
  return (
    <span className="headline-dora">
      <span>{value}</span>
      {band && <BandLabel band={band} />}
    </span>
  );
}

const HEADLINE: HeadlineRow[] = [
  { label: copy.compare.headline.merged, values: (r) => formatNumber(r.totals.merged, 0) },
  { label: copy.compare.headline.authors, values: (r) => formatNumber(r.totals.authors, 0) },
  { label: copy.compare.headline.authorWeeks, values: (r) => formatNumber(r.totals.authorWeeks, 0) },
  { label: copy.compare.headline.perAuthorWeek, values: (r) => formatNumber(r.totals.mergedPerAuthorWeek, 2) },
  { label: copy.compare.headline.medianSize, values: (r) => formatNumber(r.summary.size.median, 0) },
  { label: copy.compare.headline.coding, values: (r) => formatDuration(r.summary.codingHours.median) },
  { label: copy.compare.headline.firstReview, values: (r) => formatDuration(r.summary.firstReviewHours.median) },
  { label: copy.compare.headline.openToMerge, values: (r) => formatDuration(r.summary.openToMergeHours.median) },
  { label: copy.compare.headline.openToMergeReviewed, values: (r) => formatDuration(r.summary.openToMergeReviewedHours.median) },
  {
    label: copy.compare.headline.openToMergeUnreviewed,
    values: (r) => formatDuration(r.summary.openToMergeUnreviewedHours.median),
  },
  { label: copy.compare.headline.reviewed, values: (r) => formatPercent(r.totals.reviewedShare) },
  { label: copy.compare.headline.selfMerged, values: (r) => formatPercent(r.totals.selfMergedShare) },
  {
    label: copy.compare.headline.deploysPerWeek,
    values: (r) =>
      dora(
        r.dora.deploymentFrequency ? formatNumber(r.dora.deploymentFrequency.perWeek, 1) : null,
        r.dora.deploymentFrequency?.band ?? null,
      ),
  },
  {
    label: copy.compare.headline.leadTime,
    values: (r) => dora(r.dora.leadTime ? formatDuration(r.dora.leadTime.medianHours) : null, r.dora.leadTime?.band ?? null),
  },
  {
    label: copy.compare.headline.changeFailure,
    values: (r) =>
      dora(r.dora.changeFailure ? formatPercent(r.dora.changeFailure.rate) : null, r.dora.changeFailure?.band ?? null),
  },
  {
    label: copy.compare.headline.timeToRestore,
    values: (r) =>
      dora(r.dora.timeToRestore ? formatDuration(r.dora.timeToRestore.medianHours) : null, r.dora.timeToRestore?.band ?? null),
  },
];

function HeadlineTable({
  reports,
  series,
  range,
}: {
  reports: readonly RepoReport[];
  series: readonly SeriesMeta[];
  range: ReportRange;
}) {
  return (
    <section className="card section" aria-labelledby="headline-title">
      <h2 id="headline-title" className="chart-title">
        {copy.compare.headline.title}
      </h2>
      <p className="chart-subtitle">{copy.compare.headline.subtitle}</p>
      {new Set(reports.map((r) => r.dora.profile.id)).size > 1 ? (
        <p className="notice notice-warning" role="alert">
          {copy.dora.profileMismatch}
        </p>
      ) : (
        reports[0] && <ProfileLine profile={reports[0].dora.profile} />
      )}
      <div className="table-scroll">
        <table className="data-table headline-table">
          <caption className="visually-hidden">{copy.compare.headline.title}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.compare.headline.metric}</th>
              {series.map((s) => (
                <th scope="col" key={s.key}>
                  <span className="series-heading">
                    <span className="legend-swatch legend-swatch-square" style={{ background: s.colour }} aria-hidden="true" />
                    {s.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HEADLINE.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {reports.map((report) => (
                  <td key={report.repo.id}>{row.values(report)}</td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">{copy.dora.explain.whyBandRow}</th>
              {reports.map((report) => (
                <td key={report.repo.id}>
                  <Link
                    to={repoDoraHref(report.repo.id, range)}
                    aria-label={copy.dora.explain.whyBandLabel(repoName(report.repo))}
                  >
                    {copy.dora.explain.whyBand}
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FairPanel({ reports, series }: { reports: readonly RepoReport[]; series: readonly SeriesMeta[] }) {
  return (
    <aside className="card fair-panel" aria-labelledby="fair-title">
      <h2 id="fair-title" className="chart-title">
        {copy.compare.fair.title}
      </h2>
      <ul className="fair-list">
        <li>
          {copy.compare.fair.teamSizes}
          <ul className="fair-authors">
            {reports.map((report, i) => (
              <li key={report.repo.id}>
                <span
                  className="legend-swatch legend-swatch-square"
                  style={{ background: series[i]?.colour }}
                  aria-hidden="true"
                />
                {copy.compare.fair.authorsOf(series[i]?.label ?? "", report.totals.authors)}
              </li>
            ))}
          </ul>
        </li>
        <li>{copy.compare.fair.reviewSplit}</li>
        <li>{copy.compare.fair.ages}</li>
        <li>{copy.compare.fair.overlap}</li>
        <li>{copy.compare.fair.leadTime}</li>
        <li>{copy.compare.fair.partialWeek}</li>
      </ul>
    </aside>
  );
}

function PeopleSection({ reports, series }: { reports: readonly RepoReport[]; series: readonly SeriesMeta[] }) {
  return (
    <section className="section" aria-labelledby="people-title">
      <h2 id="people-title" className="section-title">
        {copy.compare.people.title}
      </h2>
      <div className="chart-grid">
        {reports.map((report, i) => (
          <section key={report.repo.id} className="card">
            <h3 className="chart-title">
              <span className="series-heading">
                <span
                  className="legend-swatch legend-swatch-square"
                  style={{ background: series[i]!.colour }}
                  aria-hidden="true"
                />
                {series[i]!.label}
              </span>
            </h3>
            <p className="chart-subtitle">{copy.compare.people.subtitle(series[i]!.label)}</p>
            <AuthorsTable authors={report.authors} caption={copy.compare.people.subtitle(series[i]!.label)} />
          </section>
        ))}
      </div>
    </section>
  );
}

function CompareHeader({ series }: { series: readonly SeriesMeta[] }) {
  return (
    <>
      <Link to="/repos" className="back-link">
        {copy.common.backToRepos}
      </Link>
      <header className="page-header page-header-row">
        <div className="page-header">
          <h1>{copy.compare.title}</h1>
          <p className="lede">{copy.compare.lede}</p>
        </div>
        {series.length > 0 && <DownloadReportButton subject={copy.report.compareSubject(series.map((s) => s.label))} />}
      </header>
    </>
  );
}

/** The comparison's switches, each kept in the address so a shared link opens the same view. */
function useCompareSwitches() {
  const [aligned, setAligned] = useFlagParam("align");
  const [perContributor, setPerContributor] = useFlagParam("perContributor");
  const [showPeople, setShowPeople] = useFlagParam("people");
  const [log, setLog] = useFlagParam("log");
  return { aligned, setAligned, perContributor, setPerContributor, showPeople, setShowPeople, log, setLog };
}

type CompareSwitches = ReturnType<typeof useCompareSwitches>;

interface CompareControlsProps {
  range: ReportRange;
  onRangeChange: (next: ReportRange) => void;
  switches: CompareSwitches;
  /** The period every compared repository was active, offered as a preset; null when there is none. */
  overlap: { from: string; to: string } | null;
  notices: { tooMany: boolean; clippedTo: number | null };
}

function CompareControls({ range, onRangeChange, switches, overlap, notices }: CompareControlsProps) {
  const extraPresets = overlap ? [{ key: "overlap", label: copy.range.allActive, range: overlap }] : [];
  return (
    <section className="controls-bar" aria-label={copy.compare.controls}>
      <DateRangeControls value={range} onChange={onRangeChange} extraPresets={extraPresets} />
      <div className="toggle-row">
        <Toggle
          label={copy.compare.align}
          hint={copy.compare.alignHint}
          checked={switches.aligned}
          onChange={switches.setAligned}
        />
        <Toggle
          label={copy.compare.perContributor}
          hint={copy.compare.perContributorHint}
          checked={switches.perContributor}
          onChange={switches.setPerContributor}
        />
        <Toggle
          label={copy.compare.showPeople}
          hint={copy.compare.showPeopleHint}
          checked={switches.showPeople}
          onChange={switches.setShowPeople}
        />
      </div>
      {notices.tooMany && <p className="notice notice-info">{copy.compare.tooMany}</p>}
      {switches.aligned && notices.clippedTo !== null && (
        <p className="notice notice-info" role="status">
          {copy.compare.clippedNote(notices.clippedTo)}
        </p>
      )}
    </section>
  );
}

function CompareStatus({ compare, missing }: { compare: ReturnType<typeof useCompare>; missing: number }) {
  return (
    <>
      {compare.isPending && (
        <>
          <Skeleton height={360} />
          <SkeletonGrid count={2} height={300} />
        </>
      )}
      {compare.isError && <ErrorState error={compare.error} onRetry={() => void compare.refetch()} />}
      {missing > 0 && (
        <p className="notice notice-warning" role="alert">
          {copy.compare.missing(missing)}
        </p>
      )}
    </>
  );
}

function NeedTwo({ header }: { header: ReactNode }) {
  return (
    <div className="page">
      <StickyPanel>{header}</StickyPanel>
      <EmptyState>
        <p>{copy.compare.needTwo}</p>
        <Link to="/repos" className="button button-secondary">
          {copy.common.backToRepos}
        </Link>
      </EmptyState>
    </div>
  );
}

export function ComparePage() {
  const [params] = useSearchParams();
  const idsParam = params.get("ids");
  const requested = useMemo(() => parseIds(idsParam), [idsParam]);
  const ids = useMemo(() => requested.slice(0, MAX_SERIES), [requested]);
  const [range, setRange] = useRangeParams();
  const switches = useCompareSwitches();
  const compare = useCompare(ids, range);

  const reports = useMemo(() => {
    const byId = new Map((compare.data ?? []).map((r) => [r.repo.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is RepoReport => r !== undefined);
  }, [compare.data, ids]);
  const series = useMemo(() => seriesFor(reports, ids), [reports, ids]);
  const weekly = compareWeekly(
    reports.map((r, i) => ({ key: series[i]!.key, weekly: r.weekly })),
    { aligned: switches.aligned, perContributor: switches.perContributor },
  );
  const header = <CompareHeader series={series} />;

  if (ids.length < 2) return <NeedTwo header={header} />;

  return (
    <div className="page">
      <StickyPanel>
        {header}
        <CompareControls
          range={range}
          onRangeChange={setRange}
          switches={switches}
          overlap={overlappingRange(reports)}
          notices={{ tooMany: requested.length > MAX_SERIES, clippedTo: reports.length > 0 ? weekly.clippedTo : null }}
        />
      </StickyPanel>

      <CompareStatus compare={compare} missing={compare.data ? ids.length - reports.length : 0} />

      {compare.data && reports.length > 0 && (
        <div className={`compare-layout${compare.isPlaceholderData ? " is-refreshing" : ""}`} aria-busy={compare.isFetching}>
          <div className="compare-main">
            <HeadlineTable reports={reports} series={series} range={range} />
            <CompareCharts reports={reports} series={series} weekly={weekly} switches={switches} />
            {switches.showPeople && <PeopleSection reports={reports} series={series} />}
          </div>

          <FairPanel reports={reports} series={series} />
        </div>
      )}
    </div>
  );
}
