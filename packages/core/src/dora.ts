import type { DeployRun, PullRequest } from "./types.js";
import { hoursBetween, median } from "./stats.js";
import { workStartedAt } from "./pullRequests.js";
import { DEFAULT_DORA_PROFILE, doraProfile, type DoraProfile } from "./doraProfiles.js";

export type Band = "elite" | "high" | "medium" | "low";

/**
 * Bands follow a named, cited profile (ADR 0016), simplified to fixed thresholds so a figure always maps to one
 * band. Each function grades against the default profile unless another is passed.
 */
export function deployFrequencyBand(perWeek: number, profile: DoraProfile = doraProfile(DEFAULT_DORA_PROFILE)): Band {
  const [elite, high, medium] = profile.deployFrequency;
  if (perWeek >= elite) return "elite";
  if (perWeek >= high) return "high";
  if (perWeek >= medium) return "medium";
  return "low";
}

export function leadTimeBand(hours: number, profile: DoraProfile = doraProfile(DEFAULT_DORA_PROFILE)): Band {
  const [elite, high, medium] = profile.leadTimeHours;
  if (hours < elite) return "elite";
  if (hours < high) return "high";
  if (hours < medium) return "medium";
  return "low";
}

export function changeFailureBand(rate: number, profile: DoraProfile = doraProfile(DEFAULT_DORA_PROFILE)): Band {
  const [elite, high, medium] = profile.changeFailure;
  if (rate <= elite) return "elite";
  if (rate <= high) return "high";
  if (rate <= medium) return "medium";
  return "low";
}

export function restoreBand(hours: number, profile: DoraProfile = doraProfile(DEFAULT_DORA_PROFILE)): Band {
  const [elite, high, medium] = profile.restoreHours;
  if (hours < elite) return "elite";
  if (hours < high) return "high";
  if (hours < medium) return "medium";
  return "low";
}

const isCompleted = (r: DeployRun) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure");

/** Completed success or failure runs on the deploy branch, oldest first. Cancelled and skipped runs are not deployments. */
export function productionRuns(runs: readonly DeployRun[], branch: string): DeployRun[] {
  return runs.filter((r) => r.branch === branch && isCompleted(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Each merged PR into the deploy branch paired with the first successful deploy that started at or after its merge.
 * Only PRs merged inside the observed deploy window are paired; a PR not yet shipped is left out. Each `pr` is the
 * object passed in, so a caller can look its PRs up by identity.
 */
export function shippedPrs(prs: readonly PullRequest[], runs: readonly DeployRun[], branch: string) {
  const production = productionRuns(runs, branch);
  const successes = production.filter((r) => r.conclusion === "success");
  // A PR merged before the first observed deploy run would be matched to whatever deploy happened to be
  // recorded first, months later, so pairing only happens inside the window deploys were observed.
  const observedFrom = production[0]?.createdAt;
  const inWindow = (pr: PullRequest): pr is PullRequest & { mergedAt: string } =>
    pr.mergedAt !== null && pr.baseRef === branch && observedFrom !== undefined && pr.mergedAt >= observedFrom;
  const result: { pr: PullRequest & { mergedAt: string }; deploy: DeployRun }[] = [];
  for (const pr of prs.filter(inWindow)) {
    const deploy = successes.find((r) => r.createdAt >= pr.mergedAt);
    if (deploy) result.push({ pr, deploy });
  }
  return result;
}

/**
 * First commit to the completion of the first successful deploy that started at or after the merge.
 * Returns one entry per merged PR into the deploy branch that has shipped, within the observed deploy window.
 */
export function leadTimes(prs: readonly PullRequest[], runs: readonly DeployRun[], branch: string) {
  const result: { number: number; mergedAt: string; deployedAt: string; hours: number }[] = [];
  for (const { pr, deploy } of shippedPrs(prs, runs, branch)) {
    const hours = hoursBetween(workStartedAt(pr), deploy.completedAt);
    if (hours !== null) result.push({ number: pr.number, mergedAt: pr.mergedAt, deployedAt: deploy.completedAt, hours });
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

/** True when the title marks the PR as a revert or a hotfix, the signal both revert counts and rework use. */
export function isRevertOrHotfix(pr: Pick<PullRequest, "title">): boolean {
  return REVERT.test(pr.title);
}

export interface DoraSummary {
  /** The profile every band below was graded against (ADR 0016). */
  profile: Pick<DoraProfile, "id" | "name" | "source">;
  deploymentFrequency: { perWeek: number; total: number; weeks: number; band: Band } | null;
  leadTime: { medianHours: number; count: number; band: Band } | null;
  changeFailure: {
    rate: number;
    failed: number;
    total: number;
    band: Band;
    revertPrs: number;
    /**
     * Successful deploys that shipped at least one revert or hotfix PR, over all successful deploys. It has no
     * band because DORA publishes none. Null when there were no successful deploys.
     */
    rework: { rate: number; deploys: number; total: number } | null;
  } | null;
  timeToRestore: { medianHours: number; count: number; band: Band } | null;
}

/** Successful deploys that shipped a revert or hotfix PR, using the same PR to deploy pairing as lead time. */
function reworkOf(prs: readonly PullRequest[], runs: readonly DeployRun[], branch: string, successes: number) {
  if (successes === 0) return null;
  const reworked = new Set(
    shippedPrs(prs, runs, branch)
      .filter(({ pr }) => isRevertOrHotfix(pr))
      .map(({ deploy }) => deploy.runId),
  );
  return { rate: reworked.size / successes, deploys: reworked.size, total: successes };
}

export function doraSummary(
  prs: readonly PullRequest[],
  runs: readonly DeployRun[],
  branch: string,
  weeks: number,
  profile: DoraProfile = doraProfile(DEFAULT_DORA_PROFILE),
): DoraSummary {
  const production = productionRuns(runs, branch);
  const successes = production.filter((r) => r.conclusion === "success");
  const failures = production.filter((r) => r.conclusion === "failure");
  const lead = leadTimes(prs, runs, branch).map((l) => l.hours);
  const restore = restoreTimes(runs, branch).map((r) => r.hours);
  const leadMedian = median(lead);
  const restoreMedian = median(restore);
  const perWeek = weeks > 0 ? successes.length / weeks : 0;
  const failureRate = failures.length / production.length;

  return {
    profile: { id: profile.id, name: profile.name, source: profile.source },
    deploymentFrequency:
      production.length > 0 ? { perWeek, total: successes.length, weeks, band: deployFrequencyBand(perWeek, profile) } : null,
    leadTime:
      leadMedian !== null ? { medianHours: leadMedian, count: lead.length, band: leadTimeBand(leadMedian, profile) } : null,
    changeFailure:
      production.length > 0
        ? {
            rate: failureRate,
            failed: failures.length,
            total: production.length,
            band: changeFailureBand(failureRate, profile),
            revertPrs: prs.filter((p) => p.mergedAt && isRevertOrHotfix(p)).length,
            rework: reworkOf(prs, runs, branch, successes.length),
          }
        : null,
    timeToRestore:
      restoreMedian !== null
        ? { medianHours: restoreMedian, count: restore.length, band: restoreBand(restoreMedian, profile) }
        : null,
  };
}
