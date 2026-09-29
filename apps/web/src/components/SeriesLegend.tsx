export interface LegendItem {
  key: string;
  label: string;
  colour: string;
  /** Use a line swatch for line charts and a square for bars. */
  shape?: "line" | "square";
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
            style={{ background: item.colour }}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
