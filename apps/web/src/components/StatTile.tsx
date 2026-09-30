export interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
  /** "danger" outlines the tile. The hint must still say what is wrong, so colour is never the only signal. */
  tone?: "danger";
}

export function StatTile({ label, value, hint, tone }: StatTileProps) {
  return (
    <article className={`tile stat-tile${tone ? ` tile-${tone}` : ""}`}>
      <h3 className="tile-label">{label}</h3>
      <p className="tile-value">{value}</p>
      {hint && <p className="tile-definition">{hint}</p>}
    </article>
  );
}
