import type { Band } from "./dora.js";
import {
  HIGH_CCN,
  LONG_FUNCTION_NLOC,
  MAINTAINABILITY_LIMITS,
  MANY_PARAMS,
  WARN_CCN,
  maintainabilityGrade,
  type MaintainabilityFigures,
} from "./codeGrade.js";
import type { FunctionMetrics } from "./codeHealth.js";

/**
 * Advice on where to start simplifying. It uses the same figures and limits as the grade and adds conventions
 * of its own (ADR 0015); none of it changes a band.
 */

/**
 * How a function earns its score, which decides the kind of change that helps.
 *
 * - `component`: a React component (a capitalised function in a `.tsx` or `.jsx` file). Extract subcomponents.
 * - `dense`: at least one branch for every two lines, typically defaults, optional chaining or a case per value.
 *   A lookup table or small helpers usually reads better, and part of the score is how the analyser counts.
 * - `long`: 40 lines or more. Split it into named steps.
 * - `branching`: nested or chained conditions in a short function. Name the conditions as helpers.
 */
export type HotspotShape = "component" | "dense" | "long" | "branching";

export const DENSE_CCN_PER_LINE = 0.5;
export const LONG_SHAPE_NLOC = 40;

export interface Hotspot extends FunctionMetrics {
  /** Null when the function is within the complexity and length limits, so there is nothing to advise. */
  shape: HotspotShape | null;
  /** This function's NLOC over all source NLOC, from 0 to 1. */
  lineShare: number;
  /** True when the function is one of those `nextBand` names. */
  onPath: boolean;
}

/** A short list of functions to simplify for maintainability to reach the band above its current one. */
export interface NextBand {
  from: Band;
  to: Band;
  /** Largest first. */
  functions: FunctionMetrics[];
  /** Their NLOC, summed. */
  lines: number;
}

// Parameters are left out: a long parameter list calls for an options object, whatever the shape of the body.
const needsWork = (f: FunctionMetrics) => f.ccn > WARN_CCN || f.nloc > LONG_FUNCTION_NLOC;

export function hotspotShape(f: FunctionMetrics): HotspotShape | null {
  if (!needsWork(f)) return null;
  if (/\.(tsx|jsx)$/i.test(f.file) && /^[A-Z]/.test(f.name)) return "component";
  if (f.ccn / Math.max(f.nloc, 1) >= DENSE_CCN_PER_LINE) return "dense";
  if (f.nloc >= LONG_SHAPE_NLOC) return "long";
  return "branching";
}

const TARGET_INDEX: Record<Exclude<Band, "low">, 0 | 1 | 2> = { elite: 0, high: 1, medium: 2 };
const BAND_ABOVE: Record<Exclude<Band, "elite">, Exclude<Band, "low">> = { low: "medium", medium: "high", high: "elite" };

interface CheckRule {
  check: keyof MaintainabilityFigures;
  fails: (f: FunctionMetrics) => boolean;
  /** What the function contributes to the figure's numerator. */
  weight: (f: FunctionMetrics) => number;
  /** True when the figure is over all source lines, false when it is over all functions. */
  perLine: boolean;
}

// The CCN 20 check comes first so that the functions it needs also count towards the CCN 10 check.
const RULES: CheckRule[] = [
  { check: "linesAboveHigh", fails: (f) => f.ccn > HIGH_CCN, weight: (f) => f.nloc, perLine: true },
  { check: "linesAboveWarn", fails: (f) => f.ccn > WARN_CCN, weight: (f) => f.nloc, perLine: true },
  { check: "longFunctions", fails: (f) => f.nloc > LONG_FUNCTION_NLOC, weight: () => 1, perLine: false },
  { check: "manyParams", fails: (f) => f.params > MANY_PARAMS, weight: () => 1, perLine: false },
];

const checksFailed = (f: FunctionMetrics) => RULES.filter((rule) => rule.fails(f)).length;

/**
 * For a figure that counts functions, each pick removes one whatever its size, so a function that fails other
 * checks too goes first, because simplifying it helps them as well.
 */
const byChecksFailed = (a: FunctionMetrics, b: FunctionMetrics) => checksFailed(b) - checksFailed(a) || bySize(a, b);

/** Largest first, so the fewest functions clear a line-weighted figure; ties fall to complexity, file and name. */
const bySize = (a: FunctionMetrics, b: FunctionMetrics) =>
  b.nloc - a.nloc || b.ccn - a.ccn || a.file.localeCompare(b.file) || a.name.localeCompare(b.name);

/**
 * Picks functions until every maintainability figure is below the next band's limit: largest first for a figure
 * over lines, and those failing the most checks first for a figure over functions. A picked
 * function is assumed to end up within every limit, and the source size is assumed not to change, so the list
 * is a floor on the work rather than a promise. Null when maintainability is already elite or there is no source.
 */
export function nextBand(fns: readonly FunctionMetrics[], figures: MaintainabilityFigures): NextBand | null {
  if (fns.length === 0) return null;
  const from = maintainabilityGrade(figures).band;
  if (from === "elite") return null;
  const to = BAND_ABOVE[from];
  const totalLines = fns.reduce((sum, f) => sum + f.nloc, 0);
  const picked = new Set<FunctionMetrics>();

  for (const rule of RULES) {
    const limit = MAINTAINABILITY_LIMITS[rule.check][TARGET_INDEX[to]];
    const whole = rule.perLine ? totalLines : fns.length;
    const offenders = fns.filter((f) => rule.fails(f) && !picked.has(f)).sort(rule.perLine ? bySize : byChecksFailed);
    let remaining = offenders.reduce((sum, f) => sum + rule.weight(f), 0);
    for (const f of offenders) {
      if (remaining / whole < limit) break;
      picked.add(f);
      remaining -= rule.weight(f);
    }
  }

  const functions = [...picked].sort(bySize);
  return { from, to, functions, lines: functions.reduce((sum, f) => sum + f.nloc, 0) };
}

/** Each hotspot with its shape, its share of the source and whether it is on the path to the next band. */
export function describeHotspots(hotspots: readonly FunctionMetrics[], totalLines: number, path: NextBand | null): Hotspot[] {
  const onPath = new Set(path?.functions ?? []);
  return hotspots.map((f) => ({
    ...f,
    shape: hotspotShape(f),
    lineShare: totalLines === 0 ? 0 : f.nloc / totalLines,
    onPath: onPath.has(f),
  }));
}
