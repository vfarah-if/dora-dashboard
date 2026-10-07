import type { Band } from "./dora.js";

/**
 * Grade thresholds. They are this project's convention, not an industry standard (ADR 0013), and each one is
 * exported so a test and the documentation can point at the same number.
 */
export const WARN_CCN = 10;
export const HIGH_CCN = 20;
export const LONG_FUNCTION_NLOC = 60;
export const MANY_PARAMS = 5;

/**
 * Upper limits, exclusive, for elite, high and medium. At or above the last one is low. Do not loosen them to win back
 * a grade that a more complete analyser lowered (ADR 0026).
 */
export const MAINTAINABILITY_LIMITS = {
  linesAboveWarn: [0.05, 0.1, 0.2],
  linesAboveHigh: [0.01, 0.03, 0.08],
  longFunctions: [0.01, 0.03, 0.06],
  manyParams: [0.01, 0.03, 0.06],
} as const;

export interface MaintainabilityFigures {
  /** Share of source lines (NLOC) in functions with a CCN above 10. */
  linesAboveWarn: number;
  /** Share of source lines (NLOC) in functions with a CCN above 20. */
  linesAboveHigh: number;
  /** Share of source functions longer than 60 lines. */
  longFunctions: number;
  /** Share of source functions with more than 5 parameters. */
  manyParams: number;
}

/** A coverage floor below this is recorded and shown, but does not count towards the elite testing band. */
export const MIN_COVERAGE_FLOOR = 60;

export interface TestingFigures {
  /** Test NLOC divided by source NLOC. */
  testRatio: number;
  /** Share of merged source-changing pull requests that also change tests; null when no pull request has file data. */
  prsWithTests: number | null;
  /** Leave undefined when the clone's tooling files were not read; the check is then left out, not failed. */
  ciRunsTests?: boolean;
  /** A percentage, or null when no floor is set. Leave undefined when tooling was not read. */
  coverageFloor?: number | null;
}

export interface HygieneFigures {
  linterConfigured: boolean;
  formatterConfigured: boolean;
  ciRunsLinter: boolean;
  ciChecksFormat: boolean;
  /** Set when the only formatter found is `.editorconfig`, so the reason can say why it did not count. */
  onlyEditorconfig: boolean;
}

export type GradePartName = "maintainability" | "testing" | "hygiene";

/**
 * Every value `check` can take, per part. They are stable identifiers for front ends to write their own wording
 * from (with the figures beside them); the English in `reason` is for the command line and logs.
 *
 * - maintainability: `linesAboveWarn` and `linesAboveHigh` (share of source lines in complex functions),
 *   `longFunctions` (share of functions over 60 lines), `manyParams` (share with more than 5 parameters).
 * - testing: `testRatio` (test size against source size, or no tests at all when the figure is 0),
 *   `prsWithTests`, `ciRunsTests`, `coverageFloor`.
 * - hygiene: `linter` and `formatter` (not configured), `ciLinter` and `ciFormat` (not run in CI).
 * - every part: `all` when nothing held the band back.
 */
export const GRADE_CHECKS = {
  maintainability: ["linesAboveWarn", "linesAboveHigh", "longFunctions", "manyParams", "all"],
  testing: ["testRatio", "prsWithTests", "ciRunsTests", "coverageFloor", "all"],
  hygiene: ["linter", "formatter", "ciLinter", "ciFormat", "all"],
} as const;

export type MaintainabilityCheck = (typeof GRADE_CHECKS.maintainability)[number];
export type TestingCheck = (typeof GRADE_CHECKS.testing)[number];
export type HygieneCheck = (typeof GRADE_CHECKS.hygiene)[number];

/**
 * One line of evidence behind a grade, so a front end needs no thresholds or arithmetic of its own.
 *
 * - `value`: the figure measured. A share (0 to 1) for shares, the ratio for `testRatio`, the percentage for
 *   `coverageFloor`, true or false for the yes or no checks, and null when the figure is unknown.
 * - `band`: for banded checks (all maintainability checks, `testRatio`, `prsWithTests`, `ciRunsTests` and
 *   `coverageFloor`), the highest band this check alone allows. Absent when the check is ignored.
 * - `met`: for testing and hygiene, whether the check is fully satisfied (banded testing checks: elite).
 * - `count` and `total`: the items behind a share, such as functions or pull requests.
 * - `detail`: tool names for hygiene checks.
 * - `limits`: true for the one check that set its part's band.
 */
export interface GradeCheck {
  part: GradePartName;
  check: Exclude<MaintainabilityCheck | TestingCheck | HygieneCheck, "all">;
  value: number | boolean | null;
  band?: Band;
  met?: boolean;
  count?: number;
  total?: number;
  detail?: string[];
  limits: boolean;
}

export interface GradePart<Check extends string = string> {
  band: Band;
  /** The check that set the band, or `all` when nothing held it back. See `GRADE_CHECKS`. */
  check: Check;
  reason: string;
}

export interface CodeGrade {
  overall: GradePart<MaintainabilityCheck | TestingCheck | HygieneCheck> & { part: GradePartName };
  maintainability: GradePart<MaintainabilityCheck>;
  testing: GradePart<TestingCheck>;
  hygiene: GradePart<HygieneCheck>;
}

const RANK: Record<Band, number> = { low: 0, medium: 1, high: 2, elite: 3 };
const label = (band: Band) => band[0]!.toUpperCase() + band.slice(1);
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

const bandBelow = (value: number, [elite, high, medium]: readonly [number, number, number]): Band =>
  value < elite ? "elite" : value < high ? "high" : value < medium ? "medium" : "low";

const bandAtLeast = (value: number, needs: { elite: number; high: number; medium: number }): Band =>
  value >= needs.elite ? "elite" : value >= needs.high ? "high" : value >= needs.medium ? "medium" : "low";

/** The lowest band among checks that have one, and the first check at it; null when none is banded. */
function lowestBanded<T extends { band?: Band }>(checks: T[]): { band: Band; check: T } | null {
  let worst: { band: Band; check: T } | null = null;
  for (const check of checks) {
    if (check.band && (!worst || RANK[check.band] < RANK[worst.band])) worst = { band: check.band, check };
  }
  return worst;
}

// ---- maintainability -----------------------------------------------------------------------------------------

/** How many source functions stand behind each maintainability share. */
export type MaintainabilityCounts = Record<keyof MaintainabilityFigures, number>;

const MAINTAINABILITY_TEXT: Record<keyof MaintainabilityFigures, (share: number) => string> = {
  linesAboveWarn: (s) => `${percent(s)} of source lines sit in functions with a complexity above ${WARN_CCN}`,
  linesAboveHigh: (s) => `${percent(s)} of source lines sit in functions with a complexity above ${HIGH_CCN}`,
  longFunctions: (s) => `${percent(s)} of source functions are longer than ${LONG_FUNCTION_NLOC} lines`,
  manyParams: (s) => `${percent(s)} of source functions take more than ${MANY_PARAMS} parameters`,
};

export function maintainabilityChecks(figures: MaintainabilityFigures, counts?: MaintainabilityCounts): GradeCheck[] {
  return (Object.keys(MAINTAINABILITY_LIMITS) as (keyof MaintainabilityFigures)[]).map((check) => ({
    part: "maintainability",
    check,
    value: figures[check],
    band: bandBelow(figures[check], MAINTAINABILITY_LIMITS[check]),
    ...(counts ? { count: counts[check] } : {}),
    limits: false,
  }));
}

/** The worst of four checks; on a tie the check listed first wins. */
export function maintainabilityGrade(figures: MaintainabilityFigures): GradePart<MaintainabilityCheck> {
  const { band, check } = lowestBanded(maintainabilityChecks(figures))!;
  if (band === "elite") return { band, check: "all", reason: "Every maintainability check is in the elite band" };
  const name = check.check as keyof MaintainabilityFigures;
  return { band, check: name, reason: MAINTAINABILITY_TEXT[name](figures[name]) };
}

// ---- testing -------------------------------------------------------------------------------------------------

const RATIO_NEEDS = { elite: 0.5, high: 0.3, medium: 0.1 } as const;
const PRS_NEEDS = { elite: 0.6, high: 0.4, medium: 0.2 } as const;
type Target = keyof typeof RATIO_NEEDS;

/** Each testing check's own ceiling: the highest band its figure allows. Band-less checks are ignored. */
export function testingChecks(figures: TestingFigures, prs?: { withTests: number; total: number } | null): GradeCheck[] {
  const checks: GradeCheck[] = [
    {
      part: "testing",
      check: "testRatio",
      value: figures.testRatio,
      band: bandAtLeast(figures.testRatio, RATIO_NEEDS),
      limits: false,
    },
    {
      part: "testing",
      check: "prsWithTests",
      value: figures.prsWithTests,
      ...(figures.prsWithTests === null ? {} : { band: bandAtLeast(figures.prsWithTests, PRS_NEEDS) }),
      ...(prs ? { count: prs.withTests, total: prs.total } : {}),
      limits: false,
    },
  ];
  if (figures.ciRunsTests !== undefined) {
    // CI running the tests is needed for high and elite; medium asks nothing of CI.
    checks.push({
      part: "testing",
      check: "ciRunsTests",
      value: figures.ciRunsTests,
      band: figures.ciRunsTests ? "elite" : "medium",
      limits: false,
    });
  }
  if (figures.coverageFloor !== undefined) {
    const floor = figures.coverageFloor;
    // Only elite asks for a floor, and a token one does not count.
    checks.push({
      part: "testing",
      check: "coverageFloor",
      value: floor,
      band: floor !== null && floor >= MIN_COVERAGE_FLOOR ? "elite" : "high",
      limits: false,
    });
  }
  return checks.map((c) => (c.band ? { ...c, met: c.band === "elite" } : c));
}

/** What held a check below the band above it, worded for the command line. */
function shortfall(check: GradeCheck["check"], figures: TestingFigures, target: Target): string {
  const needs = label(target);
  switch (check) {
    case "testRatio":
      return figures.testRatio === 0
        ? "No test code was found"
        : `Test code is ${figures.testRatio.toFixed(2)} of the size of source code, and ${needs} needs ${RATIO_NEEDS[target].toFixed(1)}`;
    case "prsWithTests":
      return `${percent(figures.prsWithTests ?? 0)} of merged pull requests that change source also change tests, and ${needs} needs ${Math.round(PRS_NEEDS[target] * 100)}%`;
    case "ciRunsTests":
      return "CI does not run the tests";
    default:
      return figures.coverageFloor == null
        ? "No coverage floor is set"
        : `The coverage floor is ${figures.coverageFloor}%, and ${needs} needs at least ${MIN_COVERAGE_FLOOR}%`;
  }
}

const ABOVE: Record<Band, Target> = { low: "medium", medium: "high", high: "elite", elite: "elite" };

/** The lowest ceiling among the checks; the reason names the first check at it. Elite means every requirement is met. */
export function testingGrade(figures: TestingFigures): GradePart<TestingCheck> {
  const { band, check } = lowestBanded(testingChecks(figures))!;
  if (band === "elite") return { band, check: "all", reason: "Every testing requirement is met" };
  const name = check.check as Exclude<TestingCheck, "all">;
  return { band, check: name, reason: shortfall(name, figures, ABOVE[band]) };
}

// ---- hygiene -------------------------------------------------------------------------------------------------

export interface HygieneTools {
  linters: string[];
  formatters: string[];
  ciLinters: string[];
  ciFormatChecks: string[];
}

const HYGIENE_MISSING: Record<Exclude<HygieneCheck, "all">, (f: HygieneFigures) => string> = {
  linter: () => "no linter is configured",
  formatter: (f) =>
    f.onlyEditorconfig ? "no formatter is configured (an editorconfig file only guides editors)" : "no formatter is configured",
  ciLinter: () => "CI does not run a linter",
  ciFormat: () => "CI does not check formatting",
};

export function hygieneChecks(figures: HygieneFigures, tools?: HygieneTools): GradeCheck[] {
  const rows: [Exclude<HygieneCheck, "all">, boolean, string[] | undefined][] = [
    ["linter", figures.linterConfigured, tools?.linters],
    ["formatter", figures.formatterConfigured, tools?.formatters],
    ["ciLinter", figures.ciRunsLinter, tools?.ciLinters],
    ["ciFormat", figures.ciChecksFormat, tools?.ciFormatChecks],
  ];
  return rows.map(([check, met, detail]) => ({
    part: "hygiene",
    check,
    value: met,
    met,
    ...(detail ? { detail } : {}),
    limits: false,
  }));
}

/** Four checks: all four is elite, three high, one or two medium, none low. */
export function hygieneGrade(figures: HygieneFigures): GradePart<HygieneCheck> {
  const missing = hygieneChecks(figures).filter((c) => !c.met);
  const passed = 4 - missing.length;
  const band: Band = passed === 4 ? "elite" : passed === 3 ? "high" : passed >= 1 ? "medium" : "low";
  if (missing.length === 0) return { band, check: "all", reason: "All four hygiene checks pass" };
  const sentence = missing.map((c) => HYGIENE_MISSING[c.check as Exclude<HygieneCheck, "all">](figures)).join(", and ");
  return { band, check: missing[0]!.check as HygieneCheck, reason: sentence[0]!.toUpperCase() + sentence.slice(1) };
}

// ---- overall -------------------------------------------------------------------------------------------------

const PART_LABEL: Record<GradePartName, string> = { maintainability: "Maintainability", testing: "Testing", hygiene: "Hygiene" };

/** The lowest of the three parts; on a tie the part listed first (maintainability, testing, hygiene) is named. */
export function overallGrade(parts: Record<GradePartName, GradePart>): CodeGrade["overall"] {
  let lowest: GradePartName = "maintainability";
  for (const name of ["testing", "hygiene"] as const) if (RANK[parts[name].band] < RANK[parts[lowest].band]) lowest = name;
  const part = parts[lowest];
  const reason =
    part.band === "elite" ? "Every part is in the elite band" : `${PART_LABEL[lowest]} is the lowest part. ${part.reason}`;
  return { part: lowest, band: part.band, check: part.check as CodeGrade["overall"]["check"], reason };
}

export interface GradeInputs {
  maintainability: MaintainabilityFigures;
  counts: MaintainabilityCounts;
  testing: TestingFigures;
  prs: { withTests: number; total: number } | null;
  hygiene: HygieneFigures;
  tools: HygieneTools;
}

/** The grade and the evidence behind it, from one list of checks, with `limits` set on the check behind each part. */
export function gradeCodeHealth(inputs: GradeInputs): { grade: CodeGrade; checks: GradeCheck[] } {
  const parts = {
    maintainability: maintainabilityGrade(inputs.maintainability),
    testing: testingGrade(inputs.testing),
    hygiene: hygieneGrade(inputs.hygiene),
  };
  const checks = [
    ...maintainabilityChecks(inputs.maintainability, inputs.counts),
    ...testingChecks(inputs.testing, inputs.prs),
    ...hygieneChecks(inputs.hygiene, inputs.tools),
  ].map((c) => ({ ...c, limits: parts[c.part].check === c.check }));
  return { grade: { ...parts, overall: overallGrade(parts) }, checks };
}
