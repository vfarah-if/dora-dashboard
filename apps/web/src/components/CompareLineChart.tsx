import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { endLabelOffsets, lastValueIndex, type ChartRow } from "../lib/compare";
import type { SeriesMeta } from "../lib/series";
import { axisProps, CHART_HEIGHT, ChartTooltip, endLabel, gridProps } from "./chartParts";

export interface CompareLineChartProps {
  rows: readonly ChartRow[];
  series: readonly SeriesMeta[];
  formatX: (x: string | number) => string;
  formatY: (value: number) => string;
  yLabel: string;
  log?: boolean;
  /** A step line reads better for counts that change week to week. */
  step?: boolean;
}

/** Right margin wide enough for the longest end label at 12px, roughly 7px a character, capped. */
function endLabelRoom(series: readonly SeriesMeta[]): number {
  const longest = Math.max(0, ...series.map((s) => s.shortLabel.length));
  return Math.min(220, 16 + longest * 7);
}

/** One line per repository on shared axes, with a direct label at each line's end. */
export function CompareLineChart({ rows, series, formatX, formatY, yLabel, log = false, step = false }: CompareLineChartProps) {
  const directLabels = series.length <= 4;
  // A log axis is not linear in value, so label spacing is only estimated on a linear one.
  const offsets =
    directLabels && !log
      ? endLabelOffsets(
          rows,
          series.map((s) => s.key),
          CHART_HEIGHT - 40,
        )
      : {};
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <LineChart
        data={rows as ChartRow[]}
        margin={{ top: 12, right: directLabels ? endLabelRoom(series) : 12, bottom: 0, left: 0 }}
      >
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="x" {...axisProps} tickFormatter={formatX} minTickGap={24} />
        <YAxis
          {...axisProps}
          scale={log ? "log" : "auto"}
          domain={log ? ["auto", "auto"] : [0, "auto"]}
          allowDataOverflow={log}
          tickFormatter={formatY}
          width={64}
          label={{ value: yLabel, angle: -90, position: "insideLeft", fill: "var(--text-muted)", fontSize: 12, dx: 4, dy: 40 }}
        />
        <Tooltip content={<ChartTooltip formatLabel={formatX} formatValue={formatY} />} cursor={{ stroke: "var(--axis)" }} />
        {series.map((s) => (
          <Line
            key={s.key}
            type={step ? "stepAfter" : "monotone"}
            dataKey={s.key}
            name={s.label}
            stroke={s.colour}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
            label={directLabels ? endLabel(s.shortLabel, lastValueIndex(rows, s.key), offsets[s.key] ?? 0) : undefined}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
