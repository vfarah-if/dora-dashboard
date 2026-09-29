import { mean, median, p75 } from "./stats.js";

/** One function found by a static analyser. `file` is relative to the repository root. */
export interface FunctionMetrics {
  file: string;
  language: string;
  name: string;
  startLine: number;
  /** Cyclomatic complexity: the number of independent paths through the function. */
  ccn: number;
  /** Lines of code, excluding blank lines and comments. */
  nloc: number;
  params: number;
}

/** What one analysis of one commit found. `error` is set, with no functions, when the analysis could not run. */
export interface CodeSnapshot {
  commitSha: string;
  analysedAt: string;
  functions: FunctionMetrics[];
  error?: string | null;
}

export interface CodeHealthThresholds {
  /** A function with a CCN above this is worth a look. */
  warn: number;
  /** A function with a CCN above this is hard to test and to change safely. */
  high: number;
}

export interface CcnBucket {
  label: string;
  min: number;
  /** Null for the open-ended top bucket. */
  max: number | null;
  count: number;
}

export interface LanguageHealth {
  language: string;
  functions: number;
  nloc: number;
  meanCcn: number;
}

export interface CodeHealthReport {
  status: "ok";
  commitSha: string;
  analysedAt: string;
  functions: number;
  nloc: number;
  ccn: { mean: number; median: number; p75: number; max: number };
  shareAboveWarn: number;
  shareAboveHigh: number;
  distribution: CcnBucket[];
  languages: LanguageHealth[];
  hotspots: FunctionMetrics[];
  /** Present when a newer analysis failed; the figures above then come from the last successful one. */
  lastError?: { message: string; analysedAt: string };
}

/** What the code health route returns: a report, or the reason there is not one. `error` means no analysis has ever succeeded. */
export type CodeHealthResponse = CodeHealthReport | { status: "none" } | { status: "error"; message: string; analysedAt: string };

export const DEFAULT_CODE_THRESHOLDS: CodeHealthThresholds = { warn: 10, high: 20 };

const BUCKETS: readonly { label: string; min: number; max: number | null }[] = [
  { label: "1 to 5", min: 1, max: 5 },
  { label: "6 to 10", min: 6, max: 10 },
  { label: "11 to 20", min: 11, max: 20 },
  { label: "21 to 50", min: 21, max: 50 },
  { label: "Over 50", min: 51, max: null },
];

const HOTSPOT_COUNT = 10;

/** Summarises the complexity of one analysed commit. Pure: the snapshot carries its own timestamp. */
export function codeHealth(snapshot: CodeSnapshot, thresholds: CodeHealthThresholds = DEFAULT_CODE_THRESHOLDS): CodeHealthReport {
  const fns = snapshot.functions;
  const ccns = fns.map((f) => f.ccn);
  const share = (limit: number) => (fns.length === 0 ? 0 : fns.filter((f) => f.ccn > limit).length / fns.length);

  const byLanguage = new Map<string, FunctionMetrics[]>();
  for (const fn of fns) {
    const list = byLanguage.get(fn.language);
    if (list) list.push(fn);
    else byLanguage.set(fn.language, [fn]);
  }
  const languages = [...byLanguage.entries()]
    .map(([language, list]) => ({
      language,
      functions: list.length,
      nloc: list.reduce((sum, f) => sum + f.nloc, 0),
      meanCcn: mean(list.map((f) => f.ccn)) ?? 0,
    }))
    .sort((a, b) => b.functions - a.functions || a.language.localeCompare(b.language));

  const hotspots = [...fns]
    .sort((a, b) => b.ccn - a.ccn || b.nloc - a.nloc || a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
    .slice(0, HOTSPOT_COUNT);

  return {
    status: "ok",
    commitSha: snapshot.commitSha,
    analysedAt: snapshot.analysedAt,
    functions: fns.length,
    nloc: fns.reduce((sum, f) => sum + f.nloc, 0),
    ccn: {
      mean: mean(ccns) ?? 0,
      median: median(ccns) ?? 0,
      p75: p75(ccns) ?? 0,
      // A reduce, not `Math.max(...ccns)`, which overflows the stack on very large repositories.
      max: ccns.reduce((top, c) => (c > top ? c : top), 0),
    },
    shareAboveWarn: share(thresholds.warn),
    shareAboveHigh: share(thresholds.high),
    distribution: BUCKETS.map((b) => ({
      ...b,
      count: fns.filter((f) => f.ccn >= b.min && (b.max === null || f.ccn <= b.max)).length,
    })),
    languages,
    hotspots,
  };
}
