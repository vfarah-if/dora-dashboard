import { ROOT_AREA, type AreaSummary, type Band, type Capped, type CodeFigures, type LineRange } from "@dora-dashboard/core";
import { copy } from "../copy";
import { shareLabel } from "./codeVerdict";

/** How many areas the chart draws. The table behind it lists them all. */
export const AREA_CHART_LIMIT = 12;

/** Line ranges as people say them, such as "12 to 30, 44", with "and 3 more" when the list was cut short. */
export function rangesLabel(ranges: Capped<LineRange>): string {
  const shown = ranges.items.map(([first, last]) =>
    first === last ? String(first) : copy.codeAnalysis.ranges.span(first, last),
  );
  const label = shown.join(", ");
  const more = ranges.total - ranges.items.length;
  return more > 0 ? copy.codeAnalysis.ranges.withMore(label, more) : label;
}

/** The name an area goes by on screen. The files at the repository root have no folder name, so they get a readable one. */
export function areaLabel(path: string | null | undefined): string {
  if (path === null || path === undefined) return copy.codeAnalysis.areas.none;
  return path === ROOT_AREA ? copy.codeAnalysis.areas.root : path;
}

export interface AreaChartRow {
  path: string;
  label: string;
  /** Source lines in functions with a complexity above the warning limit. */
  lines: number;
}

/**
 * The rows behind the areas chart, most lines above the warning complexity first and then by path. `bars` are the rows
 * the chart draws, and `all` is every row, for the table behind it.
 */
export function areaChartRows(
  areas: readonly Pick<AreaSummary, "path" | "nlocAboveWarn">[],
  limit = AREA_CHART_LIMIT,
): { bars: AreaChartRow[]; all: AreaChartRow[] } {
  const all = areas
    .map((a) => ({ path: a.path, label: areaLabel(a.path), lines: a.nlocAboveWarn }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { bars: all.slice(0, limit), all };
}

/** The address search with `area` set to a path, or removed for the whole repository, leaving every other parameter. */
export function searchWithArea(search: string, area: string | null): string {
  const params = new URLSearchParams(search);
  if (area) params.set("area", area);
  else params.delete("area");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface MaintainabilityLine {
  check: string;
  band: Band;
  text: string;
}

/** One sentence for each maintainability check of a scope, in the order core lists them, with the band that check allows. */
export function maintainabilityLines(
  figures: Pick<CodeFigures, "maintainabilityChecks" | "longestFunction">,
): MaintainabilityLine[] {
  const c = copy.codeHealth.findings;
  return figures.maintainabilityChecks.flatMap((check) => {
    if (typeof check.value !== "number" || check.band === undefined) return [];
    const share = shareLabel(check.value);
    const good = check.band === "elite";
    const text =
      check.check === "linesAboveWarn"
        ? c.linesAboveWarn(good, share)
        : check.check === "linesAboveHigh"
          ? c.linesAboveHigh(good, share)
          : check.check === "longFunctions"
            ? c.longFunctions(good, share, check.count, figures.longestFunction)
            : check.check === "manyParams"
              ? c.manyParams(good, share, check.count)
              : null;
    return text === null ? [] : [{ check: check.check, band: check.band, text }];
  });
}
