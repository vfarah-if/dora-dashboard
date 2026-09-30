import type { Band, RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDuration, formatNumber, formatPercent } from "./format";

export interface DoraFigure {
  id: "deploymentFrequency" | "leadTime" | "changeFailure" | "timeToRestore";
  title: string;
  definition: string;
  value: string | null;
  band: Band | null;
  detail?: string;
  reason?: string;
}

interface FigureParts {
  value: string;
  detail: string;
}

/** A figure for a measure that may be missing. Everything derived from the measure is null or absent together. */
function figure<M extends { band: Band }>(
  id: DoraFigure["id"],
  measure: M | null | undefined,
  parts: (m: M) => FigureParts,
  reason: string,
): DoraFigure {
  const title = copy.dora[id];
  const definition = copy.dora[`${id}Definition`];
  if (!measure) return { id, title, definition, value: null, band: null, reason };
  const { value, detail } = parts(measure);
  return { id, title, definition, value, band: measure.band, detail, reason };
}

/** Why time to restore is missing: no failures to recover from, no recovery seen, or no deploy runs at all. */
function restoreReason(report: RepoReport, noRunsReason: string): string {
  const cf = report.dora.changeFailure;
  if (!cf) return noRunsReason;
  return cf.failed === 0 ? copy.dora.reasons.noFailures : copy.dora.reasons.noRecovery;
}

/** The four DORA measures of a report as display figures, each with the reason it is missing when it is. */
export function doraFigures(report: RepoReport): DoraFigure[] {
  const { dora, repo } = report;
  const noWorkflow = repo.deployWorkflows.length === 0;
  const noRunsReason = noWorkflow ? copy.dora.reasons.noWorkflow : copy.dora.reasons.noRuns(repo.deployBranch);

  return [
    figure(
      "deploymentFrequency",
      dora.deploymentFrequency,
      (m) => ({ value: copy.dora.perWeek(formatNumber(m.perWeek, 1)), detail: copy.dora.deploysCount(m.total, m.weeks) }),
      noRunsReason,
    ),
    figure(
      "leadTime",
      dora.leadTime,
      (m) => ({ value: formatDuration(m.medianHours), detail: copy.dora.leadCount(m.count) }),
      dora.deploymentFrequency ? copy.dora.reasons.noShipped : noRunsReason,
    ),
    figure(
      "changeFailure",
      dora.changeFailure,
      (m) => ({ value: formatPercent(m.rate), detail: copy.dora.failureCount(m.failed, m.total) }),
      noRunsReason,
    ),
    figure(
      "timeToRestore",
      dora.timeToRestore,
      (m) => ({ value: formatDuration(m.medianHours), detail: copy.dora.restoreCount(m.count) }),
      restoreReason(report, noRunsReason),
    ),
  ];
}
