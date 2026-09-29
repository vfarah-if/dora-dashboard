import { useId, type ReactNode } from "react";
import { copy } from "../copy";

export interface TableData {
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}

export interface ChartCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** The same data as the chart, rendered in a table behind a disclosure. */
  table: TableData;
  legend?: ReactNode;
  /** A caption naming the x axis, printed under the chart. */
  xLabel?: string;
  note?: ReactNode;
  empty?: boolean;
  className?: string;
}

export function DataTable({ columns, rows, caption }: TableData & { caption?: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={c}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A titled chart card. Every chart carries a subtitle and a "View as table" disclosure of its data. */
export function ChartCard({ title, subtitle, children, table, legend, xLabel, note, empty, className }: ChartCardProps) {
  const titleId = useId();
  return (
    <section className={`card chart-card${className ? ` ${className}` : ""}`} aria-labelledby={titleId}>
      <header className="chart-header">
        <h3 id={titleId} className="chart-title">
          {title}
        </h3>
        <p className="chart-subtitle">{subtitle}</p>
      </header>
      {note && <div className="chart-note">{note}</div>}
      {empty ? (
        <p className="chart-empty">{copy.charts.noData}</p>
      ) : (
        <>
          {legend}
          <div className="chart-body">{children}</div>
          {xLabel && <p className="axis-caption">{xLabel}</p>}
          <details className="table-disclosure">
            <summary>{copy.common.viewAsTable}</summary>
            <DataTable {...table} caption={title} />
          </details>
        </>
      )}
    </section>
  );
}
