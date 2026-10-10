import type { CodeFigures, CodeHealthThresholds } from "@dora-dashboard/core";
import { copy } from "../copy";
import { locationLabel } from "../lib/codeHealth";
import { shareLabel } from "../lib/codeVerdict";
import { formatNumber } from "../lib/format";
import { PathText } from "./PathText";
import { StatTile } from "./StatTile";

/** The figures the tiles read, which a whole-repository report and the scope of an area both carry. */
export type TileFigures = Pick<
  CodeFigures,
  "countAboveWarn" | "countAboveHigh" | "shareAboveWarn" | "shareAboveHigh" | "mostComplex" | "nloc" | "functions" | "tests"
>;

/** Counts above each complexity limit, the most complex function, source lines and function counts. */
export function FigureTiles({ figures, thresholds }: { figures: TileFigures; thresholds: CodeHealthThresholds }) {
  const d = copy.codeHealth.detail;
  const most = figures.mostComplex;
  return (
    <div className="tile-grid tile-grid-flow">
      <StatTile
        label={d.above(thresholds.warn)}
        value={d.aboveValue(formatNumber(figures.countAboveWarn, 0), shareLabel(figures.shareAboveWarn))}
        hint={d.aboveHint(thresholds.warn)}
      />
      <StatTile
        label={d.above(thresholds.high)}
        value={d.aboveValue(formatNumber(figures.countAboveHigh, 0), shareLabel(figures.shareAboveHigh))}
        hint={d.aboveHint(thresholds.high)}
      />
      <StatTile
        label={d.mostComplex}
        value={most ? d.mostComplexValue(formatNumber(most.ccn, 0)) : d.mostComplexNone}
        hint={most ? <PathText text={d.mostComplexHint(most.name, locationLabel(most))} /> : undefined}
      />
      <StatTile label={d.nloc} value={formatNumber(figures.nloc, 0)} hint={d.nlocHint} />
      <StatTile
        label={d.functions}
        value={formatNumber(figures.functions, 0)}
        hint={d.functionsHint(formatNumber(figures.tests.functions, 0))}
      />
    </div>
  );
}

export type StartFigures = Pick<CodeFigures, "functions" | "nextBand">;

export interface StartCardProps {
  figures: StartFigures;
  /** Whether to say maintainability is already elite when there is nothing to lift. */
  saysElite: boolean;
  /** The note under the list, which says how the list relates to the table beside it. */
  floor?: string;
}

/** The fewest functions to simplify for maintainability to reach the next band. */
export function StartCard({ figures, saysElite, floor }: StartCardProps) {
  const c = copy.codeHealth.start;
  const path = figures.nextBand;
  if (figures.functions === 0) return null;
  if (!path) {
    return saysElite ? (
      <section aria-labelledby="start-title" className="card start-card">
        <h3 id="start-title" className="chart-title">
          {c.title}
        </h3>
        <p>{c.elite}</p>
      </section>
    ) : null;
  }
  return (
    <section aria-labelledby="start-title" className="card start-card">
      <h3 id="start-title" className="chart-title">
        {c.title}
      </h3>
      <p>{c.lift(path.functions.length, path.lines, path.from, path.to)}</p>
      <ul className="start-list">
        {path.functions.map((fn, i) => (
          <li key={`${fn.file}:${fn.startLine}:${fn.name}:${i}`} className="mono">
            <PathText text={c.functionItem(fn.name, locationLabel(fn), fn.nloc)} />
          </li>
        ))}
      </ul>
      <p className="chart-subtitle">{floor ?? c.floor}</p>
    </section>
  );
}
