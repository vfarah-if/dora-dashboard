import type { ReactNode } from "react";
import type { RepoReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { ChartCard, type TableData } from "./ChartCard";
import { CompareLineChart } from "./CompareLineChart";
import { SeriesLegend, type LegendItem } from "./SeriesLegend";
import { Toggle } from "./Toggle";
import { axisProps, CHART_HEIGHT, categoryAxisProps, ChartTooltip, gridProps, type TooltipEntry } from "./chartParts";
import {
  compositionRows,
  distributionRows,
  positiveOnly,
  someValue,
  STAGE_KEYS,
  type ChartRow,
  type CompareWeekly,
  type CompositionRow,
  type StageKey,
} from "../lib/compare";
import { formatDuration, formatNumber, formatPercent, formatWeek } from "../lib/format";
import type { SeriesMeta } from "../lib/series";

const STAGE_LABEL: Record<StageKey, string> = {
  coding: copy.charts.stages.coding,
  waitingForReview: copy.charts.stages.waitingForReview,
  inReview: copy.charts.stages.inReview,
  toMerge: copy.charts.stages.toMerge,
};

const stageColour = (index: number) => `var(--stage-${index + 1})`;

const STAGE_LEGEND: LegendItem[] = STAGE_KEYS.map((key, i) => ({ key, label: STAGE_LABEL[key], colour: stageColour(i) }));

const integer = (v: number) => formatNumber(v, 0);

/** The switches on the comparison that change how its charts are drawn. */
export interface ChartSwitches {
  aligned: boolean;
  perContributor: boolean;
  log: boolean;
  setLog: (next: boolean) => void;
}

interface SeriesProps {
  reports: readonly RepoReport[];
  series: readonly SeriesMeta[];
}

/** What every weekly line chart shares: the repositories, the x axis and the legend. */
interface WeeklyAxis {
  series: readonly SeriesMeta[];
  keys: string[];
  xLabel: string;
  formatX: (x: string | number) => string;
  legend: ReactNode;
}

function weeklyAxis(series: readonly SeriesMeta[], aligned: boolean): WeeklyAxis {
  const items: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, colour: s.colour, shape: "line" }));
  return {
    series,
    keys: series.map((s) => s.key),
    xLabel: aligned ? copy.compare.alignedAxis : copy.charts.weekStarting,
    formatX: (x) => (aligned ? copy.compare.weekN(Number(x)) : formatWeek(String(x))),
    legend: <SeriesLegend items={items} />,
  };
}

function tableFromRows(rows: readonly ChartRow[], axis: WeeklyAxis, formatY: (v: number) => string): TableData {
  return {
    columns: [axis.xLabel, ...axis.series.map((s) => s.label)],
    rows: rows.map((row) => [
      axis.formatX(row.x),
      ...axis.series.map((s) => {
        const value = row[s.key];
        return typeof value === "number" ? formatY(value) : copy.common.notAvailable;
      }),
    ]),
  };
}

interface LineText {
  title: string;
  subtitle: string;
  yLabel: string;
}

function throughputText(perContributor: boolean): LineText {
  const text = copy.compare.throughput;
  if (!perContributor) return text;
  return { title: text.titlePerContributor, subtitle: text.subtitlePerContributor, yLabel: text.yLabelPerContributor };
}

interface LineCardProps {
  axis: WeeklyAxis;
  text: LineText;
  rows: readonly ChartRow[];
  formatY: (v: number) => string;
  empty: boolean;
}

/** One weekly measure as a line per repository. */
function LineCard({ axis, text, rows, formatY, empty }: LineCardProps) {
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      legend={axis.legend}
      xLabel={axis.xLabel}
      empty={empty}
      table={tableFromRows(rows, axis, formatY)}
    >
      <CompareLineChart rows={rows} series={axis.series} formatX={axis.formatX} formatY={formatY} yLabel={text.yLabel} />
    </ChartCard>
  );
}

function OpenToMergeCard({
  axis,
  rows,
  log,
  setLog,
}: { axis: WeeklyAxis; rows: ChartRow[] } & Pick<ChartSwitches, "log" | "setLog">) {
  const text = copy.compare.openToMerge;
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      legend={
        <div className="chart-toolbar">
          {axis.legend}
          <Toggle label={copy.compare.logScale} checked={log} onChange={setLog} />
        </div>
      }
      note={log ? text.logNote : undefined}
      xLabel={axis.xLabel}
      empty={!someValue(rows, axis.keys)}
      table={tableFromRows(rows, axis, formatDuration)}
    >
      <CompareLineChart
        rows={log ? positiveOnly(rows, axis.keys) : rows}
        series={axis.series}
        formatX={axis.formatX}
        formatY={formatDuration}
        yLabel={text.yLabel}
        log={log}
      />
    </ChartCard>
  );
}

function DistributionCard({ reports, series }: SeriesProps) {
  const buckets = reports[0]?.distribution ?? [];
  const rows = distributionRows(
    reports,
    series.map((s) => s.key),
  );
  return (
    <ChartCard
      title={copy.compare.distribution.title}
      subtitle={copy.compare.distribution.subtitle}
      legend={<SeriesLegend items={series.map((s) => ({ key: s.key, label: s.label, colour: s.colour }))} />}
      xLabel={copy.charts.distribution.bucket}
      empty={reports.every((r) => r.totals.merged === 0)}
      table={{
        columns: [copy.charts.distribution.bucket, ...series.map((s) => s.label)],
        rows: buckets.map((bucket, b) => [bucket.label, ...reports.map((r) => formatPercent(r.distribution[b]?.share ?? null))]),
      }}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="x" {...axisProps} interval={0} fontSize={11} />
          <YAxis {...axisProps} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip
            content={<ChartTooltip formatValue={(v) => formatPercent(v / 100)} />}
            cursor={{ fill: "var(--surface-sunken)" }}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.colour} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** A stage's mean hours and share, as the table shows it. */
function stageCell(row: CompositionRow, key: StageKey): string {
  const hours = row[`${key}Hours`];
  const share = row[key];
  if (typeof hours !== "number" || typeof share !== "number") return copy.common.notAvailable;
  return `${formatDuration(hours)} (${formatPercent(share)})`;
}

/** The bar's hours sit beside its share on the same row, under `<stage>Hours`. */
function stageTooltip(share: number, entry: TooltipEntry): string {
  const payload = entry.payload as Record<string, number | null> | undefined;
  const hours = payload?.[`${String(entry.dataKey)}Hours`] ?? null;
  return `${formatDuration(hours)} (${formatPercent(share)})`;
}

function CompositionCard({ reports, series }: SeriesProps) {
  const rows = compositionRows(
    reports,
    series.map((s) => s.shortLabel),
  );
  return (
    <ChartCard
      title={copy.compare.composition.title}
      subtitle={copy.compare.composition.subtitle}
      legend={<SeriesLegend items={STAGE_LEGEND} />}
      empty={!rows.some((row) => row.coding !== null)}
      table={{
        columns: [copy.charts.stages.stage, ...series.map((s) => s.label)],
        rows: STAGE_KEYS.map((key) => [STAGE_LABEL[key], ...rows.map((row) => stageCell(row, key))]),
      }}
    >
      <ResponsiveContainer width="100%" height={Math.max(140, reports.length * 52 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" domain={[0, 1]} {...axisProps} tickFormatter={(v: number) => formatPercent(v)} />
          <YAxis type="category" dataKey="name" {...axisProps} {...categoryAxisProps(rows.map((r) => r.name))} />
          <Tooltip cursor={{ fill: "var(--surface-sunken)" }} content={<ChartTooltip formatValue={stageTooltip} />} />
          {STAGE_KEYS.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              name={STAGE_LABEL[key]}
              stackId="stages"
              fill={stageColour(i)}
              isAnimationActive={false}
              barSize={22}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
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

function BatchCard({ reports, series }: SeriesProps) {
  const text = copy.compare.batch;
  const bars = (value: (r: RepoReport) => number | null) =>
    reports.map((r, i) => ({ name: series[i]!.shortLabel, value: value(r), colour: series[i]!.colour }));
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      className="chart-card-wide"
      note={<p className="caveat">{text.caveat}</p>}
      table={{
        columns: [copy.compare.headline.metric, ...series.map((s) => s.label)],
        rows: [
          [text.linesPerAuthorWeek, ...reports.map((r) => formatNumber(r.totals.linesPerAuthorWeek, 0))],
          [text.medianSize, ...reports.map((r) => formatNumber(r.summary.size.median, 0))],
        ],
      }}
    >
      <div className="batch-grid">
        <div>
          <h4 className="chart-subheading">{text.linesPerAuthorWeek}</h4>
          <SeriesBarChart format={integer} rows={bars((r) => r.totals.linesPerAuthorWeek)} />
        </div>
        <div>
          <h4 className="chart-subheading">{text.medianSize}</h4>
          <SeriesBarChart format={integer} rows={bars((r) => r.summary.size.median)} />
        </div>
      </div>
    </ChartCard>
  );
}

export interface CompareChartsProps extends SeriesProps {
  weekly: CompareWeekly;
  switches: ChartSwitches;
}

/** The comparison's charts, each on shared axes with one colour per repository. */
export function CompareCharts({ reports, series, weekly, switches }: CompareChartsProps) {
  const axis = weeklyAxis(series, switches.aligned);
  const perContributor = switches.perContributor;
  return (
    <div className="chart-grid">
      <LineCard
        axis={axis}
        text={copy.compare.cumulative}
        rows={weekly.cumulative}
        formatY={integer}
        empty={weekly.cumulative.length === 0}
      />
      <LineCard
        axis={axis}
        text={throughputText(perContributor)}
        rows={weekly.throughput}
        formatY={(v) => formatNumber(v, perContributor ? 2 : 1)}
        empty={weekly.throughput.length === 0}
      />
      <OpenToMergeCard axis={axis} rows={weekly.openToMerge} log={switches.log} setLog={switches.setLog} />
      <DistributionCard reports={reports} series={series} />
      <CompositionCard reports={reports} series={series} />
      <LineCard
        axis={axis}
        text={copy.compare.deploys}
        rows={weekly.deploys}
        formatY={integer}
        empty={!someValue(weekly.deploys, axis.keys, (v) => v > 0)}
      />
      <BatchCard reports={reports} series={series} />
    </div>
  );
}
