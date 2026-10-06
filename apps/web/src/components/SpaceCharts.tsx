import type { AgeingItem, ColumnTime, SpaceWeekRow } from "@dora-dashboard/core";
import { Bar, BarChart, Brush, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { formatDuration, formatNumber, formatWeek } from "../lib/format";
import { seriesColour } from "../lib/series";
import { browseUrl, columnLabel, columnRow, columnSegments, completeWeeks, throughputChart } from "../lib/space";
import { ChartCard, DataTable } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps, weekZoom } from "./chartParts";
import { ExternalLink } from "./ExternalLink";
import { SeriesLegend } from "./SeriesLegend";
import { ShowAllList } from "./ShowAllList";

const formatWeekLabel = (label: string | number) => `${copy.charts.weekStarting} ${formatWeek(String(label))}`;
const formatCount = (value: number) => formatNumber(value, 0);

export function ThroughputChart({ weekly }: { weekly: readonly SpaceWeekRow[] }) {
  const { series, rows } = throughputChart(weekly);
  const zoom = weekZoom(rows.length);
  const copyText = copy.space.flow.throughput;
  return (
    <ChartCard
      title={copyText.title}
      subtitle={copyText.subtitle}
      empty={series.length === 0}
      xLabel={copy.charts.weekStarting}
      legend={<SeriesLegend items={series.map((s) => ({ key: s.key, label: s.label, colour: s.colour }))} />}
      table={{
        columns: [copy.charts.weekStarting, ...series.map((s) => s.label), copyText.total],
        rows: rows.map((row) => [
          formatWeek(row.week),
          ...series.map((s) => row[s.key] as number),
          series.reduce((sum, s) => sum + (row[s.key] as number), 0),
        ]),
      }}
    >
      <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip
            content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatCount} />}
            cursor={{ fill: "var(--surface-sunken)" }}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="types" fill={s.colour} />
          ))}
          {zoom && <Brush {...zoom.brush} />}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function InProgressChart({ weekly }: { weekly: readonly SpaceWeekRow[] }) {
  const weeks = completeWeeks(weekly);
  const zoom = weekZoom(weeks.length);
  const copyText = copy.space.flow.wip;
  return (
    <ChartCard
      title={copyText.title}
      subtitle={copyText.subtitle}
      empty={weeks.length === 0}
      xLabel={copy.charts.weekStarting}
      table={{
        columns: [copy.charts.weekStarting, copyText.series],
        rows: weeks.map((w) => [formatWeek(w.week), w.inProgress]),
      }}
    >
      <ResponsiveContainer width="100%" height={zoom?.height ?? CHART_HEIGHT}>
        <LineChart data={weeks} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip content={<ChartTooltip formatLabel={formatWeekLabel} formatValue={formatCount} />} />
          <Line
            type="monotone"
            dataKey="inProgress"
            name={copyText.series}
            stroke={seriesColour(0)}
            strokeWidth={2}
            dot={false}
          />
          {zoom && <Brush {...zoom.brush} />}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function AgeingTable({ items, siteUrl }: { items: readonly AgeingItem[]; siteUrl: string }) {
  const text = copy.space.flow.ageing;
  return (
    <section className="card space-ageing" aria-labelledby="ageing-title">
      <h3 id="ageing-title" className="chart-title">
        {text.title}
      </h3>
      <p className="chart-subtitle">{text.subtitle}</p>
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
                    <th scope="col">{text.key}</th>
                    <th scope="col">{text.summary}</th>
                    <th scope="col">{text.type}</th>
                    <th scope="col">{text.status}</th>
                    <th scope="col">{text.age}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, limit).map((item) => (
                    <tr key={item.key}>
                      <th scope="row">
                        <ExternalLink href={browseUrl(siteUrl, item.key)}>{item.key}</ExternalLink>
                      </th>
                      <td>{item.summary}</td>
                      <td>{item.type}</td>
                      <td>{item.status}</td>
                      <td>{formatDuration(item.ageHours)}</td>
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

export function ColumnTimeChart({ columns }: { columns: readonly ColumnTime[] }) {
  const text = copy.space.columns;
  const segments = columnSegments(columns);
  const data = [columnRow(segments)];
  const total = segments.reduce((sum, s) => sum + s.meanHours, 0);
  const tableData = {
    columns: [text.column, text.mean, text.median, text.items],
    rows: columns.map((c) => [columnLabel(c.column), formatDuration(c.meanHours), formatDuration(c.medianHours), c.items]),
  };
  return (
    <ChartCard
      title={text.chartTitle}
      subtitle={text.subtitle}
      empty={segments.length === 0}
      legend={<SeriesLegend items={segments.map((s) => ({ key: s.key, label: s.label, colour: s.colour }))} />}
      table={tableData}
    >
      <ResponsiveContainer width="100%" height={110}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" {...axisProps} domain={[0, total]} tickFormatter={formatDuration} />
          <YAxis type="category" dataKey="name" hide />
          <Tooltip content={<ChartTooltip formatValue={formatDuration} />} cursor={{ fill: "var(--surface-sunken)" }} />
          {segments.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="columns"
              fill={s.colour}
              stroke="var(--surface)"
              isAnimationActive={false}
              barSize={36}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** The same figures as the column chart, always visible so they survive into the PDF report. */
export function ColumnTimeTable({ columns }: { columns: readonly ColumnTime[] }) {
  const text = copy.space.columns;
  if (columns.length === 0) return null;
  return (
    <div className="card">
      <DataTable
        caption={text.chartTitle}
        columns={[text.column, text.mean, text.median, text.items]}
        rows={columns.map((c) => [columnLabel(c.column), formatDuration(c.meanHours), formatDuration(c.medianHours), c.items])}
      />
    </div>
  );
}
