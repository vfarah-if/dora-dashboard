import type { SecurityReport } from "@dora-dashboard/core";
import { Bar, BarChart, Brush, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { formatNumber, formatWeek } from "../lib/format";
import { usePrinting } from "../lib/print";
import { severityRows, severitySeries } from "../lib/security";
import { weekNames, type PartWeek } from "../lib/weekly";
import { ChartCard } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps, PRINT_CHART_WIDTH, weekZoom, WeeklyCountBar } from "./chartParts";
import { SeriesLegend } from "./SeriesLegend";

const formatCount = (value: number) => formatNumber(value, 0);

/**
 * How many alerts were open at the end of each week, stacked by severity. The severities keep their own tones on the
 * stage ramp, so a week without a severity never repaints another, and the part week is drawn lighter inside an outline.
 */
export function OpenAlertsChart({ weekly, part }: { weekly: SecurityReport["weekly"]; part: PartWeek | null }) {
  const text = copy.security.weekly;
  const printing = usePrinting();
  const names = weekNames(part);
  const rows = severityRows(weekly);
  const series = severitySeries(weekly);
  const zoom = weekZoom(rows.length);
  return (
    <ChartCard
      title={text.chartTitle}
      subtitle={text.subtitle}
      empty={series.length === 0}
      xLabel={copy.charts.weekStarting}
      legend={
        <SeriesLegend
          items={[
            ...series.map((s) => ({ key: s.key, label: s.label, colour: s.colour })),
            ...(part
              ? [{ key: "part-week", label: names.heading(part.week), colour: "var(--text-muted)", shape: "part" as const }]
              : []),
          ]}
        />
      }
      table={{
        columns: [copy.charts.weekStarting, ...series.map((s) => s.label), text.total],
        rows: rows.map((w) => [names.cell(w.week), ...series.map((s) => w[s.key]), w.total]),
      }}
    >
      <ResponsiveContainer width={printing ? PRINT_CHART_WIDTH : "100%"} height={zoom?.height ?? CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="week" {...axisProps} tickFormatter={formatWeek} minTickGap={24} />
          <YAxis {...axisProps} allowDecimals={false} />
          <Tooltip
            content={<ChartTooltip formatLabel={names.heading} formatValue={formatCount} />}
            cursor={{ fill: "var(--surface-sunken)" }}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="open" fill={s.colour} shape={WeeklyCountBar} />
          ))}
          {zoom && <Brush {...zoom.brush} />}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
