import type { SecurityReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { formatNumber } from "../lib/format";
import { usePrinting } from "../lib/print";
import { weaknessRows } from "../lib/security";
import { seriesColour } from "../lib/series";
import { ChartCard } from "./ChartCard";
import { axisProps, categoryAxisProps, CHART_HEIGHT, ChartTooltip, PRINT_CHART_WIDTH } from "./chartParts";
import { SeriesLegend } from "./SeriesLegend";

const ROW_HEIGHT = 40;
const formatCount = (value: number) => formatNumber(value, 0);

/** The kinds of weakness behind the alerts, named in plain words, with the open and the fixed count side by side. */
export function WeaknessesChart({ weaknesses }: { weaknesses: SecurityReport["weaknesses"] }) {
  const text = copy.security.weaknesses;
  const printing = usePrinting();
  const rows = weaknessRows(weaknesses);
  const axis = categoryAxisProps(rows.map((row) => row.name));
  const data = rows.map((row) => ({ name: row.name, open: row.open, fixed: row.fixed }));
  return (
    <ChartCard
      title={text.chartTitle}
      subtitle={text.subtitle}
      empty={rows.length === 0}
      legend={
        <SeriesLegend
          items={[
            { key: "open", label: text.open, colour: seriesColour(0) },
            { key: "fixed", label: text.fixed, colour: seriesColour(1) },
          ]}
        />
      }
      table={{
        columns: [text.kind, text.id, text.open, text.fixed, text.meaning],
        rows: rows.map((row) => [row.name, row.cwe, row.open, row.fixed, row.meaning]),
      }}
    >
      <ResponsiveContainer
        width={printing ? PRINT_CHART_WIDTH : "100%"}
        height={Math.max(CHART_HEIGHT, rows.length * ROW_HEIGHT + 40)}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" {...axisProps} allowDecimals={false} />
          <YAxis type="category" dataKey="name" {...axisProps} {...axis} interval={0} />
          <Tooltip content={<ChartTooltip formatValue={formatCount} />} cursor={{ fill: "var(--surface-sunken)" }} />
          <Bar dataKey="open" name={text.open} fill={seriesColour(0)} radius={[0, 2, 2, 0]} isAnimationActive={false} />
          <Bar dataKey="fixed" name={text.fixed} fill={seriesColour(1)} radius={[0, 2, 2, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
