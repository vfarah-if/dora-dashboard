import type { CodeHealthReport } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { distributionIsEmpty, distributionRows, type DistributionRow } from "../lib/codeHealth";
import { formatNumber } from "../lib/format";
import { seriesColour } from "../lib/series";
import { ChartCard } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps } from "./chartParts";

function RangeKey() {
  const c = copy.codeHealth.chart;
  return (
    <ul className="range-key" aria-label={c.keyTitle}>
      {c.key.map((k) => (
        <li key={k.range}>
          <strong>{k.range}</strong> {k.meaning}
        </li>
      ))}
    </ul>
  );
}

/** How the files of the analysed commit spread across the line count bands, with the band key and a table. */
export function SizeDistributionChart({ report }: { report: CodeHealthReport }) {
  const rows = distributionRows(report);
  const c = copy.codeHealth.chart;
  return (
    <ChartCard
      title={c.title}
      subtitle={c.subtitle}
      empty={distributionIsEmpty(rows)}
      xLabel={c.x}
      note={<RangeKey />}
      table={{ columns: [c.x, c.series], rows: rows.map((r) => [r.label, r.count]) }}
    >
      <SizeDistributionBars rows={rows} />
    </ChartCard>
  );
}

function SizeDistributionBars({ rows }: { rows: DistributionRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          content={<ChartTooltip formatValue={(value) => formatNumber(value, 0)} />}
          cursor={{ fill: "var(--surface-sunken)" }}
        />
        <Bar dataKey="count" name={copy.codeHealth.chart.series} fill={seriesColour(0)} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
