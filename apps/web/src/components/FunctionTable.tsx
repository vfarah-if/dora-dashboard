import type { FunctionMetrics, FunctionRow, Hotspot } from "@dora-dashboard/core";
import { copy } from "../copy";
import { adviceFor } from "../lib/codeAdvice";
import { locationLabel } from "../lib/codeHealth";
import { formatPercent } from "../lib/format";
import { PathText } from "./PathText";

/**
 * The columns every row carries, from core's function metrics. A hotspot adds the advice shape and whether it is on the
 * path to the next band, and a row from the detailed analysis adds an area and a measured coverage share.
 */
export type FunctionTableRow = Pick<FunctionMetrics, "file" | "name" | "startLine" | "ccn" | "nloc"> &
  Partial<Pick<Hotspot, "shape" | "onPath">> &
  Partial<Pick<FunctionRow, "area" | "coverage">>;

export interface FunctionTableProps {
  rows: readonly FunctionTableRow[];
  caption: string;
  /** Adds an Area column, with the readable name of each area. */
  areaLabel?: (area: string | null | undefined) => string;
  /** Adds a Measured coverage column. */
  showCoverage?: boolean;
  /** Adds the advice column, which needs each row's `shape`. */
  showAdvice?: boolean;
  /** Shown instead of the table when there are no rows. */
  empty?: string;
}

/** Functions as a table: name, location and size, with the area, measured coverage and advice when asked for. */
export function FunctionTable({ rows, caption, areaLabel, showCoverage = false, showAdvice = true, empty }: FunctionTableProps) {
  const c = copy.codeHealth.hotspots;
  if (rows.length === 0) return <p className="chart-empty">{empty ?? c.empty}</p>;
  // The plain five-column table keeps the print widths set for it; one with more columns lets its text wrap instead.
  const plain = !areaLabel && !showCoverage && showAdvice;
  return (
    <div className="table-scroll">
      <table className={`data-table ${plain ? "hotspots-table" : "function-table"}`}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{c.function}</th>
            <th scope="col">{c.location}</th>
            {areaLabel && <th scope="col">{copy.codeAnalysis.functions.area}</th>}
            <th scope="col" className="numeric">
              {c.ccn}
            </th>
            <th scope="col" className="numeric">
              {c.nloc}
            </th>
            {showCoverage && (
              <th scope="col" className="numeric">
                {copy.codeAnalysis.functions.coverage}
              </th>
            )}
            {showAdvice && <th scope="col">{c.advice}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((fn, i) => (
            // Two functions can share a file, line and name, such as callbacks written side by side.
            <tr key={`${fn.file}:${fn.startLine}:${fn.name}:${i}`}>
              <th scope="row" className="mono wrap-anywhere">
                {fn.name}
                {fn.onPath && <span className="start-tag">{c.startHere}</span>}
              </th>
              <td className="mono wrap-anywhere">
                <PathText text={locationLabel(fn)} />
              </td>
              {areaLabel && <td className="wrap-anywhere">{areaLabel(fn.area)}</td>}
              <td className="numeric">{fn.ccn}</td>
              <td className="numeric">{fn.nloc}</td>
              {showCoverage && (
                <td className="numeric">
                  {fn.coverage === null || fn.coverage === undefined
                    ? copy.codeAnalysis.functions.coverageUnknown
                    : formatPercent(fn.coverage)}
                </td>
              )}
              {showAdvice && <td className="advice-cell">{adviceFor(fn.shape ?? null)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
