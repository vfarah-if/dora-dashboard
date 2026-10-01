import type { RepoReport } from "@dora-dashboard/core";
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { copy } from "../copy";
import { STAGE_KEYS } from "../lib/compare";
import { formatDuration, formatNumber, formatPercent, formatWeek } from "../lib/format";
import { seriesColour } from "../lib/series";
import { fromFirstActive } from "../lib/weekly";
import { ChartCard } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps, weekZoom } from "./chartParts";
import { SeriesLegend } from "./SeriesLegend";

const STAGE_LABEL = {
  coding: copy.charts.stages.coding,
  waitingForReview: copy.charts.stages.waitingForReview,
  inReview: copy.charts.stages.inReview,
  toMerge: copy.charts.stages.toMerge,
} as const;

const stageColour = (i: number) => `var(--stage-${i + 1})`;
const MIN_HOURS = 1 / 60;

const formatWeekLabel = (label: string | number) => `${copy.charts.weekStarting} ${formatWeek(String(label))}`;
const formatCount = (value: number) => formatNumber(value, 1);
const formatHours = (value: number) => formatDuration(value);

export function RepoCharts({ report }: { report: RepoReport }) {
  // The part-finished current week would read as a slump on every weekly chart.
  const weekly = report.weekly.filter((w) => !w.partial);
  const hasPrs = weekly.some((w) => w.opened > 0 || w.merged > 0);
  const hasDeploy = (w: (typeof weekly)[number]) => w.deploys > 0 || w.deployFailures > 0;
  const hasDeploys = weekly.some(hasDeploy);
  // Deploy history often starts long after pull request history, when the workflow was added.
  const deployWeeks = fromFirstActive(weekly, hasDeploy);
  const zoom = weekZoom(weekly.length);
  const deployZoom = weekZoom(deployWeeks.length);
  const stageRows = weekly.map((w) => ({ week: w.week, ...(w.stages ?? {}) }));
  const hasStages = weekly.some((w) => w.stages !== null);
  const distribution = report.distribution.map((d) => ({ label: d.short, share: d.share * 100, count: d.count }));
  const scatter = report.prs
    .filter((pr) => pr.openToMergeHours !== null)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      size: Math.max(1, pr.size),
      hours: Math.max(MIN_HOURS, pr.openToMergeHours!),
      rawHours: pr.openToMergeHours!,
      rawSize: pr.size,
    }));

  return (
    <div className="chart-grid">
      <ChartCard
        title={copy.charts.openedVsMerged.title}
        subtitle={copy.charts.openedVsMerged.subtitle}
        empty={!hasPrs}
        xLabel={copy.charts.weekStarting}
        legend={
          <SeriesLegend
            items={[
              { key: "opened", label: copy.charts.openedVsMerged.opened, colour: seriesColour(0) },
              { key: "merged", label: copy.charts.openedVsMerged.merged, colour: seriesColour(1) },
            ]}
          />
        }
        table={{
          columns: [copy.charts.weekStarting, copy.charts.openedVsMerged.opened, copy.charts.openedVsMerged.merged],
          rows: weekly.map((w) => [formatWeek(w.week), w.opened, w.merged]),
        }}
      >
        <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
          <BarChart data={weekly} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip
              content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatCount} />}
              cursor={{ fill: "var(--surface-sunken)" }}
            />
            <Bar dataKey="opened" name={copy.charts.openedVsMerged.opened} fill={seriesColour(0)} radius={[2, 2, 0, 0]} />
            <Bar dataKey="merged" name={copy.charts.openedVsMerged.merged} fill={seriesColour(1)} radius={[2, 2, 0, 0]} />
            {zoom && <Brush {...zoom.brush} />}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={copy.charts.weeklyOpenToMerge.title}
        subtitle={copy.charts.weeklyOpenToMerge.subtitle}
        empty={!weekly.some((w) => w.medianOpenToMergeHours !== null)}
        xLabel={copy.charts.weekStarting}
        table={{
          columns: [copy.charts.weekStarting, copy.charts.weeklyOpenToMerge.series],
          rows: weekly.map((w) => [formatWeek(w.week), formatDuration(w.medianOpenToMergeHours)]),
        }}
      >
        <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
          <LineChart data={weekly} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
            <YAxis
              {...axisProps}
              label={{
                value: copy.charts.hours,
                angle: -90,
                position: "insideLeft",
                fill: "var(--text-muted)",
                fontSize: 12,
                dx: 14,
              }}
            />
            <Tooltip content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatHours} />} />
            <Line
              type="monotone"
              dataKey="medianOpenToMergeHours"
              name={copy.charts.weeklyOpenToMerge.series}
              stroke={seriesColour(0)}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            {zoom && <Brush {...zoom.brush} />}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={copy.charts.deploys.title}
        subtitle={copy.charts.deploys.subtitle}
        empty={!hasDeploys}
        xLabel={copy.charts.weekStarting}
        legend={
          <SeriesLegend
            items={[
              { key: "deploys", label: copy.charts.deploys.deploys, colour: seriesColour(0) },
              { key: "failures", label: copy.charts.deploys.failures, colour: seriesColour(1) },
            ]}
          />
        }
        table={{
          columns: [copy.charts.weekStarting, copy.charts.deploys.deploys, copy.charts.deploys.failures],
          rows: deployWeeks.map((w) => [formatWeek(w.week), w.deploys, w.deployFailures]),
        }}
      >
        <ResponsiveContainer width="100%" height={deployZoom?.height ?? CHART_HEIGHT}>
          <BarChart data={deployWeeks} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip
              content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatCount} />}
              cursor={{ fill: "var(--surface-sunken)" }}
            />
            <Bar dataKey="deploys" name={copy.charts.deploys.deploys} fill={seriesColour(0)} radius={[2, 2, 0, 0]} />
            <Bar dataKey="deployFailures" name={copy.charts.deploys.failures} fill={seriesColour(1)} radius={[2, 2, 0, 0]} />
            {deployZoom && <Brush {...deployZoom.brush} />}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={copy.charts.stages.title}
        subtitle={copy.charts.stages.subtitle}
        empty={!hasStages}
        xLabel={copy.charts.weekStarting}
        legend={<SeriesLegend items={STAGE_KEYS.map((key, i) => ({ key, label: STAGE_LABEL[key], colour: stageColour(i) }))} />}
        table={{
          columns: [copy.charts.weekStarting, ...STAGE_KEYS.map((key) => STAGE_LABEL[key])],
          rows: weekly.map((w) => [
            formatWeek(w.week),
            ...STAGE_KEYS.map((key) => formatDuration(w.stages ? w.stages[key] : null)),
          ]),
        }}
      >
        <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
          <BarChart data={stageRows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
            <YAxis
              {...axisProps}
              label={{
                value: copy.charts.stages.meanHours,
                angle: -90,
                position: "insideLeft",
                fill: "var(--text-muted)",
                fontSize: 12,
                dx: 14,
              }}
            />
            <Tooltip
              content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatHours} />}
              cursor={{ fill: "var(--surface-sunken)" }}
            />
            {STAGE_KEYS.map((key, i) => (
              <Bar key={key} dataKey={key} name={STAGE_LABEL[key]} stackId="stages" fill={stageColour(i)} />
            ))}
            {zoom && <Brush {...zoom.brush} />}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={copy.charts.distribution.title}
        subtitle={copy.charts.distribution.subtitle}
        empty={report.totals.merged === 0}
        xLabel={copy.charts.distribution.bucket}
        table={{
          columns: [copy.charts.distribution.bucket, copy.charts.count, copy.charts.share],
          rows: report.distribution.map((d) => [d.label, d.count, formatPercent(d.share)]),
        }}
      >
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={distribution} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="label" {...axisProps} interval={0} fontSize={11} />
            <YAxis {...axisProps} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              content={<ChartTooltip formatValue={(v) => formatPercent(v / 100)} />}
              cursor={{ fill: "var(--surface-sunken)" }}
            />
            <Bar dataKey="share" name={copy.charts.share} fill={seriesColour(0)} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={copy.charts.scatter.title}
        subtitle={copy.charts.scatter.subtitle}
        empty={scatter.length === 0}
        xLabel={copy.charts.scatter.size}
        table={{
          columns: [copy.charts.scatter.pr, copy.charts.scatter.size, copy.charts.scatter.openToMerge],
          rows: scatter.map((p) => [`#${p.number}`, p.rawSize, formatDuration(p.rawHours)]),
        }}
      >
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
            <CartesianGrid stroke="var(--grid)" />
            <XAxis
              type="number"
              dataKey="size"
              name={copy.charts.scatter.size}
              scale="log"
              domain={["auto", "auto"]}
              {...axisProps}
            />
            <YAxis
              type="number"
              dataKey="hours"
              name={copy.charts.scatter.openToMerge}
              scale="log"
              domain={["auto", "auto"]}
              {...axisProps}
              tickFormatter={(v: number) => formatDuration(v)}
              width={64}
            />
            <Tooltip
              cursor={{ stroke: "var(--axis)" }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as (typeof scatter)[number] | undefined;
                if (!active || !point) return null;
                return (
                  <div className="chart-tooltip">
                    <p className="chart-tooltip-label">
                      #{point.number} {point.title}
                    </p>
                    <ul>
                      <li>
                        <span className="chart-tooltip-name">{copy.charts.scatter.size}</span>
                        <span className="chart-tooltip-value">{formatNumber(point.rawSize, 0)}</span>
                      </li>
                      <li>
                        <span className="chart-tooltip-name">{copy.charts.scatter.openToMerge}</span>
                        <span className="chart-tooltip-value">{formatDuration(point.rawHours)}</span>
                      </li>
                    </ul>
                  </div>
                );
              }}
            />
            <Scatter data={scatter} fill={seriesColour(0)} fillOpacity={0.6} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
