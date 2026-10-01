import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Band, RepoReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCompare } from "../api/hooks";
import { copy } from "../copy";
import { AuthorsTable } from "../components/AuthorsTable";
import { BandLabel } from "../components/BandLabel";
import { ChartCard, type TableData } from "../components/ChartCard";
import { CompareLineChart } from "../components/CompareLineChart";
import { DateRangeControls } from "../components/DateRangeControls";
import { DownloadReportButton } from "../components/DownloadReportButton";
import { ProfileLine } from "../components/ProfileLine";
import { SeriesLegend, type LegendItem } from "../components/SeriesLegend";
import { EmptyState, ErrorState, Skeleton, SkeletonGrid } from "../components/States";
import { Toggle } from "../components/Toggle";
import { StickyPanel } from "../components/StickyPanel";
import { axisProps, CHART_HEIGHT, categoryAxisProps, ChartTooltip, gridProps, type TooltipEntry } from "../components/chartParts";
import {
  cumulative,
  meanStages,
  completeWeeks,
  mergeWeekly,
  overlappingRange,
  positiveOnly,
  STAGE_KEYS,
  stageShares,
  throughput,
  type ChartRow,
  type WeeklySeries,
} from "../lib/compare";
import { formatDuration, formatNumber, formatPercent, formatWeek } from "../lib/format";
import { MAX_SERIES, seriesFor, type SeriesMeta } from "../lib/series";
import { parseIds, useFlagParam, useRangeParams } from "../lib/urlState";

const STAGE_LABEL = {
  coding: copy.charts.stages.coding,
  waitingForReview: copy.charts.stages.waitingForReview,
  inReview: copy.charts.stages.inReview,
  toMerge: copy.charts.stages.toMerge,
} as const;

function tableFromRows(
  rows: readonly ChartRow[],
  series: readonly SeriesMeta[],
  xLabel: string,
  formatX: (x: string | number) => string,
  formatY: (v: number) => string,
): TableData {
  return {
    columns: [xLabel, ...series.map((s) => s.label)],
    rows: rows.map((row) => [
      formatX(row.x),
      ...series.map((s) => {
        const value = row[s.key];
        return typeof value === "number" ? formatY(value) : copy.common.notAvailable;
      }),
    ]),
  };
}

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

function HeadlineTable({ reports, series }: { reports: readonly RepoReport[]; series: readonly SeriesMeta[] }) {
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

function SeriesBarChart({
  rows,
  format,
}: {
  rows: { name: string; value: number | null; colour: string }[];
  format: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 44 + 40)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={format} />
        <YAxis type="category" dataKey="name" {...axisProps} {...categoryAxisProps(rows.map((r) => r.name))} />
        <Tooltip content={<ChartTooltip formatValue={format} />} cursor={{ fill: "var(--surface-sunken)" }} />
        <Bar dataKey="value" radius={[0, 2, 2, 0]} isAnimationActive={false} barSize={18}>
          {rows.map((row) => (
            <Cell key={row.name} fill={row.colour} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ComparePage() {
  const [params] = useSearchParams();
  const idsParam = params.get("ids");
  const requested = useMemo(() => parseIds(idsParam), [idsParam]);
  const ids = useMemo(() => requested.slice(0, MAX_SERIES), [requested]);
  const [range, setRange] = useRangeParams();
  const [aligned, setAligned] = useFlagParam("align");
  const [perContributor, setPerContributor] = useFlagParam("perContributor");
  const [showPeople, setShowPeople] = useFlagParam("people");
  const [log, setLog] = useFlagParam("log");
  const compare = useCompare(ids, range);

  const reports = useMemo(() => {
    const byId = new Map((compare.data ?? []).map((r) => [r.repo.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is RepoReport => r !== undefined);
  }, [compare.data, ids]);
  const series = useMemo(() => seriesFor(reports, ids), [reports, ids]);
  const weeklySeries: WeeklySeries[] = reports.map((r, i) => ({ key: series[i]!.key, weekly: r.weekly }));
  const keys = series.map((s) => s.key);
  const legendItems: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, colour: s.colour, shape: "line" }));

  const xLabel = aligned ? copy.compare.alignedAxis : copy.charts.weekStarting;
  const formatX = (x: string | number) => (aligned ? copy.compare.weekN(Number(x)) : formatWeek(String(x)));

  // Weekly rates leave off the part-finished current week; the running total keeps it.
  const completeSeries = completeWeeks(weeklySeries);
  const throughputMerged = mergeWeekly(completeSeries, { aligned, value: (w) => throughput(w, perContributor) });
  const mergedCounts = mergeWeekly(weeklySeries, { aligned, value: (w) => w.merged });
  const cumulativeRows = cumulative(mergedCounts.rows, keys);
  const openToMerge = mergeWeekly(completeSeries, { aligned, value: (w) => w.medianOpenToMergeHours });
  const openToMergeRows = log ? positiveOnly(openToMerge.rows, keys) : openToMerge.rows;
  const deploys = mergeWeekly(completeSeries, { aligned, value: (w) => w.deploys });
  const clippedTo = throughputMerged.clippedTo;
  const overlap = overlappingRange(reports);
  const extraPresets = overlap ? [{ key: "overlap", label: copy.range.allActive, range: overlap }] : [];

  const buckets = reports[0]?.distribution ?? [];
  const distributionRows = buckets.map((bucket, b) => {
    const row: ChartRow = { x: bucket.short };
    reports.forEach((r, i) => {
      row[series[i]!.key] = (r.distribution[b]?.share ?? 0) * 100;
    });
    return row;
  });

  const compositionRows = reports.map((r, i) => {
    const means = meanStages(r.weekly);
    const shares = stageShares(means);
    const row: Record<string, string | number | null> = { name: series[i]!.shortLabel };
    for (const key of STAGE_KEYS) {
      row[key] = shares ? shares[key] : null;
      row[`${key}Hours`] = means ? means[key] : null;
    }
    return row;
  });
  const hasComposition = compositionRows.some((row) => row.coding !== null);

  const integer = (v: number) => formatNumber(v, 0);
  const throughputFormat = (v: number) => formatNumber(v, perContributor ? 2 : 1);

  const header = (
    <>
      <Link to="/repos" className="back-link">
        {copy.common.backToRepos}
      </Link>
      <header className="page-header page-header-row">
        <div className="page-header">
          <h1>{copy.compare.title}</h1>
          <p className="lede">{copy.compare.lede}</p>
        </div>
        {reports.length > 0 && <DownloadReportButton subject={copy.report.compareSubject(series.map((s) => s.label))} />}
      </header>
    </>
  );

  if (ids.length < 2) {
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

  const missing = compare.data ? ids.length - reports.length : 0;

  return (
    <div className="page">
      <StickyPanel>
        {header}

        <section className="controls-bar" aria-label={copy.compare.controls}>
          <DateRangeControls value={range} onChange={setRange} extraPresets={extraPresets} />
          <div className="toggle-row">
            <Toggle label={copy.compare.align} hint={copy.compare.alignHint} checked={aligned} onChange={setAligned} />
            <Toggle
              label={copy.compare.perContributor}
              hint={copy.compare.perContributorHint}
              checked={perContributor}
              onChange={setPerContributor}
            />
            <Toggle
              label={copy.compare.showPeople}
              hint={copy.compare.showPeopleHint}
              checked={showPeople}
              onChange={setShowPeople}
            />
          </div>
          {requested.length > MAX_SERIES && <p className="notice notice-info">{copy.compare.tooMany}</p>}
          {aligned && clippedTo !== null && reports.length > 0 && (
            <p className="notice notice-info" role="status">
              {copy.compare.clippedNote(clippedTo)}
            </p>
          )}
        </section>
      </StickyPanel>

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

      {compare.data && reports.length > 0 && (
        <div className={`compare-layout${compare.isPlaceholderData ? " is-refreshing" : ""}`} aria-busy={compare.isFetching}>
          <div className="compare-main">
            <HeadlineTable reports={reports} series={series} />

            <div className="chart-grid">
              <ChartCard
                title={copy.compare.cumulative.title}
                subtitle={copy.compare.cumulative.subtitle}
                legend={<SeriesLegend items={legendItems} />}
                xLabel={xLabel}
                empty={cumulativeRows.length === 0}
                table={tableFromRows(cumulativeRows, series, xLabel, formatX, integer)}
              >
                <CompareLineChart
                  rows={cumulativeRows}
                  series={series}
                  formatX={formatX}
                  formatY={integer}
                  yLabel={copy.compare.cumulative.yLabel}
                />
              </ChartCard>

              <ChartCard
                title={perContributor ? copy.compare.throughput.titlePerContributor : copy.compare.throughput.title}
                subtitle={perContributor ? copy.compare.throughput.subtitlePerContributor : copy.compare.throughput.subtitle}
                legend={<SeriesLegend items={legendItems} />}
                xLabel={xLabel}
                empty={throughputMerged.rows.length === 0}
                table={tableFromRows(throughputMerged.rows, series, xLabel, formatX, throughputFormat)}
              >
                <CompareLineChart
                  rows={throughputMerged.rows}
                  series={series}
                  formatX={formatX}
                  formatY={throughputFormat}
                  yLabel={perContributor ? copy.compare.throughput.yLabelPerContributor : copy.compare.throughput.yLabel}
                />
              </ChartCard>

              <ChartCard
                title={copy.compare.openToMerge.title}
                subtitle={copy.compare.openToMerge.subtitle}
                legend={
                  <div className="chart-toolbar">
                    <SeriesLegend items={legendItems} />
                    <Toggle label={copy.compare.logScale} checked={log} onChange={setLog} />
                  </div>
                }
                note={log ? copy.compare.openToMerge.logNote : undefined}
                xLabel={xLabel}
                empty={!openToMerge.rows.some((row) => keys.some((k) => typeof row[k] === "number"))}
                table={tableFromRows(openToMerge.rows, series, xLabel, formatX, formatDuration)}
              >
                <CompareLineChart
                  rows={openToMergeRows}
                  series={series}
                  formatX={formatX}
                  formatY={formatDuration}
                  yLabel={copy.compare.openToMerge.yLabel}
                  log={log}
                />
              </ChartCard>

              <ChartCard
                title={copy.compare.distribution.title}
                subtitle={copy.compare.distribution.subtitle}
                legend={<SeriesLegend items={series.map((s) => ({ key: s.key, label: s.label, colour: s.colour }))} />}
                xLabel={copy.charts.distribution.bucket}
                empty={reports.every((r) => r.totals.merged === 0)}
                table={{
                  columns: [copy.charts.distribution.bucket, ...series.map((s) => s.label)],
                  rows: buckets.map((bucket, b) => [
                    bucket.label,
                    ...reports.map((r) => formatPercent(r.distribution[b]?.share ?? null)),
                  ]),
                }}
              >
                <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                  <BarChart data={distributionRows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="x" {...axisProps} interval={0} fontSize={11} />
                    <YAxis {...axisProps} tickFormatter={(v: number) => `${v}%`} />
                    <Tooltip
                      content={<ChartTooltip formatValue={(v) => formatPercent(v / 100)} />}
                      cursor={{ fill: "var(--surface-sunken)" }}
                    />
                    {series.map((s) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        name={s.label}
                        fill={s.colour}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard
                title={copy.compare.composition.title}
                subtitle={copy.compare.composition.subtitle}
                legend={
                  <SeriesLegend
                    items={STAGE_KEYS.map((key, i) => ({ key, label: STAGE_LABEL[key], colour: `var(--stage-${i + 1})` }))}
                  />
                }
                empty={!hasComposition}
                table={{
                  columns: [copy.charts.stages.stage, ...series.map((s) => s.label)],
                  rows: STAGE_KEYS.map((key) => [
                    STAGE_LABEL[key],
                    ...compositionRows.map((row) => {
                      const hours = row[`${key}Hours`];
                      const share = row[key];
                      return typeof hours === "number" && typeof share === "number"
                        ? `${formatDuration(hours)} (${formatPercent(share)})`
                        : copy.common.notAvailable;
                    }),
                  ]),
                }}
              >
                <ResponsiveContainer width="100%" height={Math.max(140, reports.length * 52 + 40)}>
                  <BarChart data={compositionRows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--grid)" horizontal={false} />
                    <XAxis type="number" domain={[0, 1]} {...axisProps} tickFormatter={(v: number) => formatPercent(v)} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      {...axisProps}
                      {...categoryAxisProps(compositionRows.map((r) => String(r.name)))}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--surface-sunken)" }}
                      content={
                        <ChartTooltip
                          formatValue={(v: number, entry: TooltipEntry) => {
                            const payload = entry.payload as Record<string, number | null> | undefined;
                            const hours = payload?.[`${String(entry.dataKey)}Hours`] ?? null;
                            return `${formatDuration(hours)} (${formatPercent(v)})`;
                          }}
                        />
                      }
                    />
                    {STAGE_KEYS.map((key, i) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        name={STAGE_LABEL[key]}
                        stackId="stages"
                        fill={`var(--stage-${i + 1})`}
                        isAnimationActive={false}
                        barSize={22}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard
                title={copy.compare.deploys.title}
                subtitle={copy.compare.deploys.subtitle}
                legend={<SeriesLegend items={legendItems} />}
                xLabel={xLabel}
                empty={!deploys.rows.some((row) => keys.some((k) => typeof row[k] === "number" && (row[k] as number) > 0))}
                table={tableFromRows(deploys.rows, series, xLabel, formatX, integer)}
              >
                <CompareLineChart
                  rows={deploys.rows}
                  series={series}
                  formatX={formatX}
                  formatY={integer}
                  yLabel={copy.compare.deploys.yLabel}
                />
              </ChartCard>

              <ChartCard
                title={copy.compare.batch.title}
                subtitle={copy.compare.batch.subtitle}
                className="chart-card-wide"
                note={<p className="caveat">{copy.compare.batch.caveat}</p>}
                table={{
                  columns: [copy.compare.headline.metric, ...series.map((s) => s.label)],
                  rows: [
                    [copy.compare.batch.linesPerAuthorWeek, ...reports.map((r) => formatNumber(r.totals.linesPerAuthorWeek, 0))],
                    [copy.compare.batch.medianSize, ...reports.map((r) => formatNumber(r.summary.size.median, 0))],
                  ],
                }}
              >
                <div className="batch-grid">
                  <div>
                    <h4 className="chart-subheading">{copy.compare.batch.linesPerAuthorWeek}</h4>
                    <SeriesBarChart
                      format={integer}
                      rows={reports.map((r, i) => ({
                        name: series[i]!.shortLabel,
                        value: r.totals.linesPerAuthorWeek,
                        colour: series[i]!.colour,
                      }))}
                    />
                  </div>
                  <div>
                    <h4 className="chart-subheading">{copy.compare.batch.medianSize}</h4>
                    <SeriesBarChart
                      format={integer}
                      rows={reports.map((r, i) => ({
                        name: series[i]!.shortLabel,
                        value: r.summary.size.median,
                        colour: series[i]!.colour,
                      }))}
                    />
                  </div>
                </div>
              </ChartCard>
            </div>

            {showPeople && (
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
            )}
          </div>

          <FairPanel reports={reports} series={series} />
        </div>
      )}
    </div>
  );
}
