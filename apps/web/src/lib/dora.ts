import type { Band, RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { explainDora, type DoraExplanation } from "./doraExplain";
import { formatDate, formatDuration, formatNumber, formatPercent } from "./format";

type BandedId = "deploymentFrequency" | "leadTime" | "changeFailure" | "timeToRestore";

export interface DoraFigure {
  id: BandedId | "reworkRate";
  title: string;
  definition: string;
  value: string | null;
  band: Band | null;
  detail?: string;
  reason?: string;
  /** Why the figure has no band, for a measure DORA publishes none for. */
  noBandNote?: string;
  /** Why this band and how to move up; absent for a figure that is missing or has no band. */
  explanation?: DoraExplanation | null;
}

/** The rework rate as a figure with no band, because DORA publishes none (ADR 0016). */
export function reworkFigure(report: RepoReport): DoraFigure {
  const rework = report.dora.changeFailure?.rework ?? null;
  const base = {
    id: "reworkRate" as const,
    title: copy.dora.rework,
    definition: copy.dora.reworkDefinition,
    band: null,
    noBandNote: copy.dora.reworkNoBand,
  };
  if (!rework) return { ...base, value: null, reason: copy.dora.reasons.noRework };
  return { ...base, value: formatPercent(rework.rate), detail: copy.dora.reworkCount(rework.deploys, rework.total) };
}

interface FigureParts {
  value: string;
  detail: string;
}

/** A figure for a measure that may be missing. Everything derived from the measure is null or absent together. */
function figure<M extends { band: Band }>(
  id: BandedId,
  measure: M | null | undefined,
  parts: (m: M) => FigureParts,
  reason: string,
  explanation: DoraExplanation | null,
): DoraFigure {
  const title = copy.dora[id];
  const definition = copy.dora[`${id}Definition`];
  if (!measure) return { id, title, definition, value: null, band: null, reason };
  const { value, detail } = parts(measure);
  return { id, title, definition, value, band: measure.band, detail, reason, explanation };
}

/**
 * Why time to restore is missing: no deploy runs at all, no failures to recover from, failures still open since a
 * date, or no recovery seen. When failures exist and none has recovered, the last streak is still open, so the reason
 * says since when and how many; the generic reason remains for runs whose times cannot be read.
 */
function restoreReason(report: RepoReport, noRunsReason: string): string {
  const cf = report.dora.changeFailure;
  if (!cf) return noRunsReason;
  if (cf.failed === 0) return copy.dora.reasons.noFailures;
  const open = report.doraDrivers.timeToRestore.unrecovered;
  return open ? copy.dora.reasons.unrecovered(formatDate(open.since), open.failedRuns) : copy.dora.reasons.noRecovery;
}

/** The four DORA measures of a report as display figures, each with the reason it is missing when it is. */
export function doraFigures(report: RepoReport): DoraFigure[] {
  const { dora, repo } = report;
  const noWorkflow = repo.deployWorkflows.length === 0;
  const noRunsReason = noWorkflow ? copy.dora.reasons.noWorkflow : copy.dora.reasons.noRuns(repo.deployBranch);
  const explanations = explainDora(report);

  return [
    figure(
      "deploymentFrequency",
      dora.deploymentFrequency,
      (m) => ({ value: copy.dora.perWeek(formatNumber(m.perWeek, 1)), detail: copy.dora.deploysCount(m.total, m.weeks) }),
      noRunsReason,
      explanations.deploymentFrequency,
    ),
    figure(
      "leadTime",
      dora.leadTime,
      (m) => ({ value: formatDuration(m.medianHours), detail: copy.dora.leadCount(m.count) }),
      dora.deploymentFrequency ? copy.dora.reasons.noShipped : noRunsReason,
      explanations.leadTime,
    ),
    figure(
      "changeFailure",
      dora.changeFailure,
      (m) => ({ value: formatPercent(m.rate), detail: copy.dora.failureCount(m.failed, m.total) }),
      noRunsReason,
      explanations.changeFailure,
    ),
    figure(
      "timeToRestore",
      dora.timeToRestore,
      (m) => ({ value: formatDuration(m.medianHours), detail: copy.dora.restoreCount(m.count) }),
      restoreReason(report, noRunsReason),
      explanations.timeToRestore,
    ),
  ];
}

/** The repository page, anchored at its DORA section and carrying the range, so a comparison can point at the explanations. */
export function repoDoraHref(
  repoId: number,
  range: { from: string | null; to: string | null; includeBots?: boolean; profile?: string | null },
): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (range.includeBots) params.set("bots", "1");
  if (range.profile) params.set("profile", range.profile);
  const query = params.toString();
  return `/repos/${repoId}${query ? `?${query}` : ""}#dora-title`;
}
