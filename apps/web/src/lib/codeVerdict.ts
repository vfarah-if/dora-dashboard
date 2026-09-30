import type { Band, CodeHealthReport, GradeCheck } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatPercent } from "./format";

/*
 * Core decides every threshold and every count. This module only chooses which checks to list, in what order,
 * and which sentence from copy.ts describes each one.
 */

export interface Finding {
  check: GradeCheck["check"];
  part: GradeCheck["part"];
  good: boolean;
  /** The band the check allows, or its part's band for a yes or no hygiene check. Lower is worse. */
  band: Band;
  /** True for the check that set its part's band. */
  limits: boolean;
  text: string;
}

const BAND_ORDER: Record<Band, number> = { low: 0, medium: 1, high: 2, elite: 3 };

const percentOne = (share: number) => `${(share * 100).toFixed(1)}%`;

const TOOL_NAMES: Record<string, string> = {
  eslint: "ESLint",
  prettier: "Prettier",
  biome: "Biome",
  ruff: "Ruff",
  "ruff format": "Ruff format",
  black: "Black",
  flake8: "Flake8",
  pylint: "Pylint",
  gofmt: "gofmt",
  "golangci-lint": "golangci-lint",
  rubocop: "RuboCop",
  clippy: "Clippy",
  rustfmt: "rustfmt",
  ktlint: "ktlint",
  detekt: "detekt",
  editorconfig: "EditorConfig",
};

export const toolName = (tool: string) => TOOL_NAMES[tool] ?? tool;
const toolNames = (check: GradeCheck) => (check.detail ?? []).map(toolName);

/** A check core measured, or undefined when the report does not carry it. */
export function checkOf(report: CodeHealthReport, check: GradeCheck["check"]): GradeCheck | undefined {
  return report.checks.find((c) => c.check === check);
}

function sentence(report: CodeHealthReport, c: GradeCheck, good: boolean, band: Band): string {
  const f = copy.codeHealth.findings;
  const poor = BAND_ORDER[band] <= BAND_ORDER.medium;
  const share = typeof c.value === "number" ? c.value : 0;
  switch (c.check) {
    case "linesAboveWarn":
      return f.linesAboveWarn(good, percentOne(share));
    case "linesAboveHigh":
      return f.linesAboveHigh(good, percentOne(share));
    case "longFunctions":
      return f.longFunctions(good, percentOne(share), c.count, report.longestFunction);
    case "manyParams":
      return f.manyParams(good, percentOne(share), c.count);
    case "testRatio":
      return f.testRatio(good, poor, share.toFixed(2));
    case "prsWithTests":
      return f.prsWithTests(good, poor, formatPercent(share), c.count ?? 0, c.total ?? 0);
    case "ciRunsTests":
      return f.ciRunsTests(good);
    case "coverageFloor":
      return f.coverageFloor(typeof c.value === "number" ? c.value : null, good);
    case "linter":
      return f.linter(toolNames(c));
    case "formatter":
      return f.formatter(toolNames(c), report.hygiene?.onlyEditorconfig ?? false);
    case "ciLinter":
      return f.ciLinter(toolNames(c));
    case "ciFormat":
      return f.ciFormat(toolNames(c));
  }
}

/** Every check that has a figure, in the order core lists them. A check with neither a figure nor a band is skipped. */
export function findings(report: CodeHealthReport): Finding[] {
  return report.checks
    .filter((c) => c.value !== null || c.band !== undefined)
    .map((c) => {
      const good = c.band === "elite" || c.met === true;
      const band = c.band ?? report.grade?.[c.part].band ?? "medium";
      return { check: c.check, part: c.part, good, band, limits: c.limits, text: sentence(report, c, good, band) };
    });
}

export interface Lists {
  good: Finding[];
  improve: Finding[];
}

/** Good is every check at elite or met. To improve is the rest, lowest band first, and the limiting check ahead on a tie. */
export function goodAndImprove(report: CodeHealthReport): Lists {
  const all = findings(report);
  return {
    good: all.filter((x) => x.good),
    improve: all
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => !x.good)
      .sort((a, b) => BAND_ORDER[a.x.band] - BAND_ORDER[b.x.band] || Number(b.x.limits) - Number(a.x.limits) || a.i - b.i)
      .map(({ x }) => x),
  };
}

/** The sentence for the check that set a part's band, worded neutrally, or null when nothing held the part back. */
export function limitingSentence(report: CodeHealthReport, part: GradeCheck["part"]): string | null {
  const found = findings(report).find((x) => x.part === part && x.limits);
  return found ? found.text.replace(/^Only /, "") : null;
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence naming the lowest part and the check that limited it, or null when there is no grade. */
export function verdictSentence(report: CodeHealthReport): string | null {
  const grade = report.grade;
  if (!grade) return null;
  const limit = limitingSentence(report, grade.overall.part);
  return limit === null
    ? copy.codeHealth.verdict.allPass
    : copy.codeHealth.verdict.lowestPart(copy.codeHealth.parts[grade.overall.part], sentenceCase(limit));
}

export const shareLabel = percentOne;
