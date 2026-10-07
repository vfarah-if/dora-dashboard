import type { ReactElement } from "react";
import { Rectangle, type BarShapeProps, type LabelProps } from "recharts";
import { copy } from "../copy";
import { formatWeek } from "../lib/format";
import { initialWindow } from "../lib/weekly";

/** Shared axis and grid styling. Every value is a token so charts follow the theme. */
export const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--text-muted)", fontSize: 12 },
  tickLine: false,
} as const;

export const gridProps = { stroke: "var(--grid)", vertical: false } as const;

export const CHART_HEIGHT = 280;

/**
 * A full-width chart's width on a printed A4 page: 186mm between the page margins (703px), less a card's 20px padding
 * and 1px border on each side, which leaves 661px, with a little to spare. The main area has no side padding in print,
 * whether from "Download PDF report" or the browser's own Print. The browser lays out the printed copy before a resize
 * could redraw a responsive chart, so such a chart is drawn at this width while printing.
 */
export const PRINT_CHART_WIDTH = 656;

const BRUSH_HEIGHT = 28;

/**
 * Props for the zoom slider under a weekly chart, or null when every week fits without one.
 * The slider opens on the latest weeks; dragging it widens the range back to the full history.
 * Spread the result into a Recharts `Brush` and size the chart with `height`.
 */
export function weekZoom(length: number) {
  const window = initialWindow(length);
  if (!window) return null;
  return {
    height: CHART_HEIGHT + BRUSH_HEIGHT,
    brush: {
      dataKey: "week",
      ...window,
      height: BRUSH_HEIGHT - 8,
      travellerWidth: 10,
      stroke: "var(--axis)",
      fill: "var(--surface)",
      tickFormatter: (value: unknown) => formatWeek(String(value)),
      ariaLabel: copy.charts.zoomLabel,
      className: "chart-brush",
    },
  };
}

/** How strongly a part week's count bar is filled. Its outline stays at full strength, so the bar keeps a clear edge. */
export const PART_WEEK_FILL_OPACITY = 0.35;
const PART_WEEK_STROKE_WIDTH = 1;

/**
 * The bar for a weekly count, passed to a Recharts `Bar` as its `shape`. A week the range ends part way through is
 * filled lighter inside a solid outline, so a count that covers only part of a week does not read as a slump.
 */
export function WeeklyCountBar(props: BarShapeProps) {
  const partial = (props.payload as { partial?: boolean } | undefined)?.partial === true;
  if (!partial) return <Rectangle {...props} />;
  return <Rectangle {...props} fillOpacity={PART_WEEK_FILL_OPACITY} stroke={props.fill} strokeWidth={PART_WEEK_STROKE_WIDTH} />;
}

/** Approximate width of one 12px tick character, so the axis can be sized without measuring the DOM. */
const TICK_CHAR_PX = 7;
const CATEGORY_AXIS_MIN = 60;
const CATEGORY_AXIS_MAX = 200;

/**
 * Props for the category axis of a horizontal bar chart. The axis is as wide as its longest name,
 * up to a cap; longer names are cut with an ellipsis so they never spill outside the card.
 * The tooltip still shows the full name.
 */
export function categoryAxisProps(names: readonly string[]) {
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const width = Math.min(CATEGORY_AXIS_MAX, Math.max(CATEGORY_AXIS_MIN, longest * TICK_CHAR_PX + 12));
  const maxChars = Math.floor((width - 12) / TICK_CHAR_PX);
  return {
    width,
    tickFormatter: (name: string) => (name.length > maxChars ? `${name.slice(0, maxChars - 1)}\u2026` : name),
  };
}

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
      <text x={x + 6} y={y + dy} dy={4} className="end-label" fill="var(--text)" stroke="none" fontSize={12}>
        {text}
      </text>
    );
  }
  return EndLabel;
}
