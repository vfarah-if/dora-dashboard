import type { CSSProperties } from "react";
import { PART_WEEK_FILL_OPACITY } from "./chartParts";

export interface LegendItem {
  key: string;
  label: string;
  colour: string;
  /** Use a line swatch for line charts, a square for bars, and a pale outlined square for a part week's bars. */
  shape?: "line" | "square" | "part";
}

/** A part week's swatch is drawn as its bars are: a pale fill inside a full-strength outline. */
function swatchStyle({ colour, shape }: LegendItem): CSSProperties {
  if (shape !== "part") return { background: colour };
  return { borderColor: colour, background: `color-mix(in srgb, ${colour} ${PART_WEEK_FILL_OPACITY * 100}%, transparent)` };
}

/** An HTML legend with swatches in the series colour and text in the text colour. */
export function SeriesLegend({ items }: { items: readonly LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="series-legend">
      {items.map((item) => (
        <li key={item.key}>
          <span
            className={`legend-swatch legend-swatch-${item.shape ?? "square"}`}
            style={swatchStyle(item)}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
