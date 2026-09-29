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

/** The four DORA measures of a report as display figures, each with the reason it is missing when it is. */
export function doraFigures(report: RepoReport): DoraFigure[] {
  const { dora, repo } = report;
  const noWorkflow = repo.deployWorkflows.length === 0;
  const noRunsReason = noWorkflow ? copy.dora.reasons.noWorkflow : copy.dora.reasons.noRuns(repo.deployBranch);

  const df = dora.deploymentFrequency;
  const lt = dora.leadTime;
  const cf = dora.changeFailure;
  const tr = dora.timeToRestore;

  let restoreReason = noRunsReason;
  if (cf) restoreReason = cf.failed === 0 ? copy.dora.reasons.noFailures : copy.dora.reasons.noRecovery;

  return [
    {
      id: "deploymentFrequency",
      title: copy.dora.deploymentFrequency,
      definition: copy.dora.deploymentFrequencyDefinition,
      value: df ? copy.dora.perWeek(formatNumber(df.perWeek, 1)) : null,
      band: df?.band ?? null,
      detail: df ? copy.dora.deploysCount(df.total, df.weeks) : undefined,
      reason: noRunsReason,
    },
    {
      id: "leadTime",
      title: copy.dora.leadTime,
      definition: copy.dora.leadTimeDefinition,
      value: lt ? formatDuration(lt.medianHours) : null,
      band: lt?.band ?? null,
      detail: lt ? copy.dora.leadCount(lt.count) : undefined,
      reason: df ? copy.dora.reasons.noShipped : noRunsReason,
    },
    {
      id: "changeFailure",
      title: copy.dora.changeFailure,
      definition: copy.dora.changeFailureDefinition,
      value: cf ? formatPercent(cf.rate) : null,
      band: cf?.band ?? null,
      detail: cf ? copy.dora.failureCount(cf.failed, cf.total) : undefined,
      reason: noRunsReason,
    },
    {
      id: "timeToRestore",
      title: copy.dora.timeToRestore,
      definition: copy.dora.timeToRestoreDefinition,
      value: tr ? formatDuration(tr.medianHours) : null,
      band: tr?.band ?? null,
      detail: tr ? copy.dora.restoreCount(tr.count) : undefined,
      reason: restoreReason,
    },
  ];
}
