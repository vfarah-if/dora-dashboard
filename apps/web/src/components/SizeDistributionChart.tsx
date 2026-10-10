import type { CodeFigures } from "@dora-dashboard/core";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { copy } from "../copy";
import { distributionIsEmpty, distributionRows, type DistributionRow } from "../lib/codeHealth";
import { formatNumber } from "../lib/format";
import { usePrinting } from "../lib/print";
import { seriesColour } from "../lib/series";
import { ChartCard } from "./ChartCard";
import { axisProps, CHART_HEIGHT, ChartTooltip, gridProps, PRINT_CHART_WIDTH } from "./chartParts";

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

/** How the source functions spread across the complexity ranges, with the range key and a table. */
export function SizeDistributionChart({ figures }: { figures: Pick<CodeFigures, "distribution"> }) {
  const rows = distributionRows(figures);
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
  // The chart spans the section, about twice a printed page, so it is drawn at the page's width while printing.
  const printing = usePrinting();
  return (
    <ResponsiveContainer width={printing ? PRINT_CHART_WIDTH : "100%"} height={CHART_HEIGHT}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          content={<ChartTooltip formatValue={(value) => formatNumber(value, 0)} />}
          cursor={{ fill: "var(--surface-sunken)" }}
        />
        <Bar
          dataKey="count"
          name={copy.codeHealth.chart.series}
          fill={seriesColour(0)}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
