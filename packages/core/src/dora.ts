import type { DeployRun, PullRequest } from "./types.js";
import { hoursBetween, median } from "./stats.js";
import { workStartedAt } from "./pullRequests.js";

export type Band = "elite" | "high" | "medium" | "low";

/**
 * Bands follow the DORA State of DevOps performance clusters, simplified to fixed thresholds
 * so a figure always maps to one band.
 */
export function deployFrequencyBand(perWeek: number): Band {
  if (perWeek >= 7) return "elite"; // on demand, daily or more
  if (perWeek >= 1) return "high"; // between daily and weekly
  if (perWeek >= 0.25) return "medium"; // between weekly and monthly
  return "low";
}

export function leadTimeBand(hours: number): Band {
  if (hours < 24) return "elite";
  if (hours < 168) return "high";
  if (hours < 720) return "medium";
  return "low";
}

export function changeFailureBand(rate: number): Band {
  if (rate <= 0.05) return "elite";
  if (rate <= 0.1) return "high";
  if (rate <= 0.15) return "medium";
  return "low";
}

export function restoreBand(hours: number): Band {
  if (hours < 1) return "elite";
  if (hours < 24) return "high";
  if (hours < 168) return "medium";
  return "low";
}

const isCompleted = (r: DeployRun) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure");

/** Completed success or failure runs on the deploy branch, oldest first. Cancelled and skipped runs are not deployments. */
export function productionRuns(runs: readonly DeployRun[], branch: string): DeployRun[] {
  return runs.filter((r) => r.branch === branch && isCompleted(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * First commit to the completion of the first successful deploy that started at or after the merge.
 * Returns one entry per merged PR into the deploy branch that has shipped, within the observed deploy window.
 */
export function leadTimes(prs: readonly PullRequest[], runs: readonly DeployRun[], branch: string) {
  const production = productionRuns(runs, branch);
  const successes = production.filter((r) => r.conclusion === "success");
  // A PR merged before the first observed deploy run would be matched to whatever deploy happened to be
  // recorded first, months later, so lead time is only measured inside the window deploys were observed.
  const observedFrom = production[0]?.createdAt;
  const inWindow = (pr: PullRequest): pr is PullRequest & { mergedAt: string } =>
    pr.mergedAt !== null && pr.baseRef === branch && observedFrom !== undefined && pr.mergedAt >= observedFrom;
  const result: { number: number; mergedAt: string; deployedAt: string; hours: number }[] = [];
  for (const pr of prs.filter(inWindow)) {
    const shipped = successes.find((r) => r.createdAt >= pr.mergedAt);
    const hours = shipped ? hoursBetween(workStartedAt(pr), shipped.completedAt) : null;
    if (shipped && hours !== null)
      result.push({ number: pr.number, mergedAt: pr.mergedAt, deployedAt: shipped.completedAt, hours });
  }
  return result;
}

/** Failed deploy to the completion of the next successful one, one entry per failure streak. */
export function restoreTimes(runs: readonly DeployRun[], branch: string) {
  const ordered = productionRuns(runs, branch);
  const result: { failedAt: string; restoredAt: string; hours: number }[] = [];
  let streakStart: DeployRun | null = null;
  for (const run of ordered) {
    if (run.conclusion === "failure") {
      streakStart ??= run;
    } else if (streakStart) {
      const hours = hoursBetween(streakStart.completedAt, run.completedAt);
      if (hours !== null) result.push({ failedAt: streakStart.completedAt, restoredAt: run.completedAt, hours });
      streakStart = null;
    }
  }
  return result;
}

const REVERT = /^(revert|hotfix)\b/i;

export interface DoraSummary {
  deploymentFrequency: { perWeek: number; total: number; weeks: number; band: Band } | null;
  leadTime: { medianHours: number; count: number; band: Band } | null;
  changeFailure: { rate: number; failed: number; total: number; band: Band; revertPrs: number } | null;
  timeToRestore: { medianHours: number; count: number; band: Band } | null;
}

export function doraSummary(prs: readonly PullRequest[], runs: readonly DeployRun[], branch: string, weeks: number): DoraSummary {
  const production = productionRuns(runs, branch);
  const successes = production.filter((r) => r.conclusion === "success");
  const failures = production.filter((r) => r.conclusion === "failure");
  const lead = leadTimes(prs, runs, branch).map((l) => l.hours);
  const restore = restoreTimes(runs, branch).map((r) => r.hours);
  const leadMedian = median(lead);
  const restoreMedian = median(restore);
  const perWeek = weeks > 0 ? successes.length / weeks : 0;

  return {
    deploymentFrequency:
      production.length > 0 ? { perWeek, total: successes.length, weeks, band: deployFrequencyBand(perWeek) } : null,
    leadTime: leadMedian !== null ? { medianHours: leadMedian, count: lead.length, band: leadTimeBand(leadMedian) } : null,
    changeFailure:
      production.length > 0
        ? {
            rate: failures.length / production.length,
            failed: failures.length,
            total: production.length,
            band: changeFailureBand(failures.length / production.length),
            revertPrs: prs.filter((p) => p.mergedAt && REVERT.test(p.title)).length,
          }
        : null,
    timeToRestore:
      restoreMedian !== null ? { medianHours: restoreMedian, count: restore.length, band: restoreBand(restoreMedian) } : null,
  };
}
