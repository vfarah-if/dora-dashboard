export interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
}

export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <article className="tile stat-tile">
      <h3 className="tile-label">{label}</h3>
      <p className="tile-value">{value}</p>
      {hint && <p className="tile-definition">{hint}</p>}
    </article>
  );
}
