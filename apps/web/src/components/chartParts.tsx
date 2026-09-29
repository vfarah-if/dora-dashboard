import type { ReactElement } from "react";
import type { LabelProps } from "recharts";

/** Shared axis and grid styling. Every value is a token so charts follow the theme. */
export const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--text-muted)", fontSize: 12 },
  tickLine: false,
} as const;

export const gridProps = { stroke: "var(--grid)", vertical: false } as const;

export const CHART_HEIGHT = 280;

export interface TooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: unknown;
  payload?: unknown;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  formatLabel?: (label: string | number) => string;
  formatValue?: (value: number, entry: TooltipEntry) => string;
}

/** The hover card used by every chart. Values print in the text colour beside a swatch in the series colour. */
export function ChartTooltip({ active, label, payload, formatLabel, formatValue }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((entry) => typeof entry.value === "number");
  if (rows.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && label !== "" && <p className="chart-tooltip-label">{formatLabel ? formatLabel(label) : label}</p>}
      <ul>
        {rows.map((entry, i) => (
          <li key={`${String(entry.dataKey)}-${i}`}>
            <span className="legend-swatch legend-swatch-square" style={{ background: entry.color }} aria-hidden="true" />
            <span className="chart-tooltip-name">{entry.name}</span>
            <span className="chart-tooltip-value">
              {formatValue ? formatValue(entry.value as number, entry) : String(entry.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A direct label drawn at the last point of a line, in the text colour. Recharts calls this for every
 * point, so it only draws at `lastIndex`.
 */
export function endLabel(text: string, lastIndex: number, dy = 0) {
  function EndLabel(props: LabelProps): ReactElement {
    const { x, y, index } = props as LabelProps & { index?: number };
    if (index !== lastIndex || typeof x !== "number" || typeof y !== "number") return <g />;
    return (
      <text x={x + 6} y={y + dy} dy={4} className="end-label" fill="var(--text)" fontSize={12}>
        {text}
      </text>
    );
  }
  return EndLabel;
}
