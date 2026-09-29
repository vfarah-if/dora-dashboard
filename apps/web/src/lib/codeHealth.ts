import type { CodeHealthReport, FunctionMetrics } from "@dora-dashboard/core";

/** The first seven characters of a commit sha, as git prints it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export interface DistributionRow {
  label: string;
  count: number;
}

export function distributionRows(report: Pick<CodeHealthReport, "distribution">): DistributionRow[] {
  return report.distribution.map((bucket) => ({ label: bucket.label, count: bucket.count }));
}

/** True when no bucket holds a function, so the chart has nothing to draw. */
export function distributionIsEmpty(rows: readonly DistributionRow[]): boolean {
  return rows.every((row) => row.count === 0);
}

/** A file and line such as src/app.ts:42. */
export function locationLabel(fn: Pick<FunctionMetrics, "file" | "startLine">): string {
  return `${fn.file}:${fn.startLine}`;
}
