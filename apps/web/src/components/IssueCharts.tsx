import type { IssueAgeingItem, IssueReport } from "@dora-dashboard/core";
import { Bar, BarChart, Brush, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { formatDuration, formatNumber, formatWeek } from "../lib/format";
import {
  closedKindSeries,
  flowRows,
  hasFlow,
  kindLabel,
  openByKindBars,
  openByPriorityBars,
  priorityLabel,
  type OpenBar,
} from "../lib/issues";
import { seriesColour } from "../lib/series";
import { weekNames, type PartWeek } from "../lib/weekly";
import { ChartCard, DataTable } from "./ChartCard";
import { axisProps, categoryAxisProps, CHART_HEIGHT, ChartTooltip, gridProps, weekZoom, WeeklyCountBar } from "./chartParts";
import { ExternalLink } from "./ExternalLink";
import { SeriesLegend } from "./SeriesLegend";
import { ShowAllList } from "./ShowAllList";

const formatCount = (value: number) => formatNumber(value, 0);

/** Priority is an ordered scale rather than a set of kinds, so its bars use a neutral ramp colour, not a kind's. */
const SCALE_COLOUR = "var(--stage-2)";

interface WeeklyProps {
  weekly: IssueReport["weekly"];
  /** The week the range ends part way through, or null when the range ends with a week. */
  part: PartWeek | null;
}

const partLegend = (part: PartWeek | null) =>
  part
    ? [
        {
          key: "part-week",
          label: weekNames(part).heading(part.week),
          colour: "var(--text-muted)",
          shape: "part" as const,
        },
      ]
    : [];

export function OpenedClosedChart({ weekly, part }: WeeklyProps) {
  const text = copy.issue.flow.openedClosed;
  const names = weekNames(part);
  const rows = flowRows(weekly);
  const zoom = weekZoom(rows.length);
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      empty={!hasFlow(weekly)}
      xLabel={copy.charts.weekStarting}
      legend={
        <SeriesLegend
          items={[
            { key: "opened", label: text.opened, colour: seriesColour(0) },
            { key: "closed", label: text.closed, colour: seriesColour(1) },
            ...partLegend(part),
          ]}
        />
      }
      table={{
        columns: [copy.charts.weekStarting, text.opened, text.closed],
        rows: rows.map((w) => [names.cell(w.week), w.opened, w.closed]),
      }}
    >
      <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip
            content={<ChartTooltip formatLabel={names.heading} formatValue={formatCount} />}
            cursor={{ fill: "var(--surface-sunken)" }}
          />
          <Bar dataKey="opened" name={text.opened} fill={seriesColour(0)} radius={[2, 2, 0, 0]} shape={WeeklyCountBar} />
          <Bar dataKey="closed" name={text.closed} fill={seriesColour(1)} radius={[2, 2, 0, 0]} shape={WeeklyCountBar} />
          {zoom && <Brush {...zoom.brush} />}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function ClosedByKindChart({ weekly, part }: WeeklyProps) {
  const text = copy.issue.flow.closedByKind;
  const names = weekNames(part);
  const rows = flowRows(weekly);
  const series = closedKindSeries(weekly);
  const zoom = weekZoom(rows.length);
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      empty={series.length === 0}
      xLabel={copy.charts.weekStarting}
      legend={
        <SeriesLegend items={[...series.map((s) => ({ key: s.key, label: s.label, colour: s.colour })), ...partLegend(part)]} />
      }
      table={{
        columns: [copy.charts.weekStarting, ...series.map((s) => s.label), text.total],
        rows: rows.map((w) => [names.cell(w.week), ...series.map((s) => w[s.key]), w.closed]),
      }}
    >
      <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip
            content={<ChartTooltip formatLabel={names.heading} formatValue={formatCount} />}
            cursor={{ fill: "var(--surface-sunken)" }}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="kinds" fill={s.colour} shape={WeeklyCountBar} />
          ))}
          {zoom && <Brush {...zoom.brush} />}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function OpenAtEndChart({ weekly, part }: WeeklyProps) {
  const text = copy.issue.flow.openAtEnd;
  const names = weekNames(part);
  const rows = flowRows(weekly);
  const zoom = weekZoom(rows.length);
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      empty={rows.length === 0}
      xLabel={copy.charts.weekStarting}
      table={{
        columns: [copy.charts.weekStarting, text.series],
        rows: rows.map((w) => [names.cell(w.week), w.openAtEnd]),
      }}
    >
      <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip content={<ChartTooltip formatLabel={names.heading} formatValue={formatCount} />} />
          <Line type="monotone" dataKey="openAtEnd" name={text.series} stroke={seriesColour(0)} strokeWidth={2} dot={false} />
          {zoom && <Brush {...zoom.brush} />}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface CountBarsProps {
  title: string;
  subtitle: string;
  seriesName: string;
  categoryName: string;
  bars: readonly OpenBar[];
}

/** One bar per category, each in its own colour, with the count in the tooltip and the figures in a table. */
function CountBarsChart({ title, subtitle, seriesName, categoryName, bars }: CountBarsProps) {
  // One bar series per category, so each keeps its colour and its swatch in the tooltip.
  const rows = bars.map((bar) => ({ name: bar.label, [bar.key]: bar.count }));
  const axis = categoryAxisProps(bars.map((bar) => bar.label));
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      empty={bars.every((bar) => bar.count === 0)}
      table={{ columns: [categoryName, seriesName], rows: bars.map((bar) => [bar.label, bar.count]) }}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" {...axisProps} allowDecimals={false} />
          <YAxis type="category" dataKey="name" {...axisProps} {...axis} interval={0} />
          <Tooltip content={<ChartTooltip formatValue={formatCount} />} cursor={{ fill: "var(--surface-sunken)" }} />
          {bars.map((bar) => (
            <Bar key={bar.key} dataKey={bar.key} name={bar.label} stackId="open" fill={bar.colour} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function OpenByKindChart({ openByKind }: { openByKind: IssueReport["openByKind"] }) {
  const text = copy.issue.open.byKind;
  return (
    <CountBarsChart
      title={text.title}
      subtitle={text.subtitle}
      seriesName={text.series}
      categoryName={text.kind}
      bars={openByKindBars(openByKind)}
    />
  );
}

export function OpenByPriorityChart({ openByPriority }: { openByPriority: IssueReport["openByPriority"] }) {
  const text = copy.issue.open.byPriority;
  return (
    <CountBarsChart
      title={text.title}
      subtitle={text.subtitle}
      seriesName={text.series}
      categoryName={text.priority}
      bars={openByPriorityBars(openByPriority, SCALE_COLOUR)}
    />
  );
}

type TimeToClose = IssueReport["timeToCloseByPriority"];

const formatHours = (value: number) => formatDuration(value);

export function TimeToCloseChart({ byPriority }: { byPriority: TimeToClose }) {
  const text = copy.issue.open.timeToClose;
  const rows = byPriority.map(({ priority, summary }) => ({ name: priorityLabel(priority), median: summary.median }));
  return (
    <ChartCard
      title={text.title}
      subtitle={text.subtitle}
      empty={byPriority.every(({ summary }) => summary.count === 0)}
      table={{
        columns: [text.priority, text.median],
        rows: byPriority.map(({ priority, summary }) => [priorityLabel(priority), formatDuration(summary.median)]),
      }}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} interval={0} />
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
          <Tooltip content={<ChartTooltip formatValue={formatHours} />} cursor={{ fill: "var(--surface-sunken)" }} />
          <Bar dataKey="median" name={text.series} fill={SCALE_COLOUR} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** The figures behind the time to close chart, always visible so they survive into the PDF report. */
export function TimeToCloseTable({ byPriority }: { byPriority: TimeToClose }) {
  const text = copy.issue.open.timeToClose;
  return (
    <div className="card">
      <DataTable
        caption={text.title}
        columns={[text.priority, text.issues, text.median, text.p75, text.mean]}
        rows={byPriority.map(({ priority, summary }) => [
          priorityLabel(priority),
          summary.count,
          formatDuration(summary.median),
          formatDuration(summary.p75),
          formatDuration(summary.mean),
        ])}
      />
    </div>
  );
}

export function AgeingTable({
  items,
  total,
  people,
}: {
  items: readonly IssueAgeingItem[];
  /** Every open issue, which is more than `items` when the API has cut the list. */
  total: number;
  people: boolean;
}) {
  const text = copy.issue.ageing;
  return (
    <section className="card space-ageing" aria-labelledby="issue-ageing-title">
      <h3 id="issue-ageing-title" className="chart-title">
        {text.title}
      </h3>
      <p className="chart-subtitle">{text.subtitle}</p>
      {total > items.length && items.length > 0 && <p className="chart-subtitle">{text.cut(items.length, total)}</p>}
      {items.length === 0 ? (
        <p className="chart-empty">{text.empty}</p>
      ) : (
        <ShowAllList total={items.length}>
          {(limit) => (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">{text.title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{text.number}</th>
                    <th scope="col">{text.issueTitle}</th>
                    <th scope="col">{text.kind}</th>
                    <th scope="col">{text.priority}</th>
                    <th scope="col">{text.age}</th>
                    {people && <th scope="col">{text.assignee}</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, limit).map((item) => (
                    <tr key={item.number}>
                      <th scope="row">
                        <ExternalLink href={item.url}>{`#${item.number}`}</ExternalLink>
                      </th>
                      <td>{item.title}</td>
                      <td>{kindLabel(item.kind)}</td>
                      <td>{item.priority ?? text.noPriority}</td>
                      <td>{formatDuration(item.ageHours)}</td>
                      {people && <td>{item.assignee ?? text.unassigned}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ShowAllList>
      )}
    </section>
  );
}
