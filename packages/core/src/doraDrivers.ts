import {
  changeFailureBand,
  deployFrequencyBand,
  doraSummary,
  leadTimeBand,
  productionRuns,
  restoreBand,
  shippedPrs,
  type Band,
} from "./dora.js";
import type { BandThresholds, DoraProfile } from "./doraProfiles.js";
import { externalReviews, prTimings, workStartedAt } from "./pullRequests.js";
import { hoursBetween, isPartialWeek, isWithin, mean, summarise, weekRange, weekStart, type Summary } from "./stats.js";
import type { DeployRun, PullRequest } from "./types.js";

/**
 * Why each DORA figure is what it is, from the team's own data (ADR 0022). Every field is measured over the same
 * range and filters as `doraSummary`, so an explanation always agrees with its tile. Nothing here names a person.
 */

export type DoraMeasure = "deploymentFrequency" | "leadTime" | "changeFailure" | "timeToRestore";

/** Where a value sits against the profile, and what the next band up needs. */
export interface BandPosition {
  band: Band;
  /** The next band up; null at elite. */
  next: Band | null;
  /** The next band's threshold, in the measure's unit (deploys per week, hours, or a rate from 0 to 1); null at elite. */
  threshold: number | null;
  /**
   * How far the value must move to reach the next band, always positive, in the measure's unit; null at elite.
   * Strict thresholds (the durations) need the value to fall below the threshold, so the gap is to the threshold itself.
   */
  gap: number | null;
}

/** One part of the mean lead time; the parts add up to the mean (ADR 0006). */
export type LeadTimePart = "coding" | "waitingForReview" | "inReview" | "toMerge" | "toDeploy";

export interface LeadTimeDrivers {
  /** Shipped pull requests measured. */
  count: number;
  meanHours: number | null;
  p75Hours: number | null;
  /** Mean hours per part, largest first; empty when nothing shipped. */
  parts: { part: LeadTimePart; meanHours: number; share: number }[];
  /** Additions plus deletions of the shipped pull requests. */
  size: Summary;
}

export interface DeployFrequencyDrivers {
  /** Successful production deploys in the range. */
  deploys: number;
  /**
   * Complete weeks in the range: those lying wholly inside it at both ends. The tile divides by every week the range
   * touches instead, partial ones included, so this can be smaller than the tile's week count.
   */
  weeks: number;
  /** Complete weeks with no successful deploy; a partial week at either end is never counted. */
  weeksWithoutDeploy: number;
  /** Pull requests shipped by each successful deploy that shipped any. */
  prsPerDeploy: Summary;
}

export interface ChangeFailureDrivers {
  failed: number;
  total: number;
  /** Failed production runs by workflow name, most first. */
  byWorkflow: { workflow: string; failed: number; total: number }[];
  /** Successful deploys that shipped a revert or hotfix pull request, out of successful deploys. */
  rework: { deploys: number; total: number } | null;
}

export interface RestoreDrivers {
  /** Runs of consecutive failed production deploys that were followed by a success. */
  streaks: number;
  /** Failed runs in each recovered streak. */
  failedRunsPerStreak: Summary;
  longestHours: number | null;
  /** A failure streak at the end of the range with no success after it yet, if any. */
  unrecovered: { since: string; failedRuns: number } | null;
}

export interface DoraDrivers {
  position: Record<DoraMeasure, BandPosition | null>;
  leadTime: LeadTimeDrivers;
  deploymentFrequency: DeployFrequencyDrivers;
  changeFailure: ChangeFailureDrivers;
  timeToRestore: RestoreDrivers;
}

const BAND_OF: Record<DoraMeasure, (value: number, profile: DoraProfile) => Band> = {
  deploymentFrequency: deployFrequencyBand,
  leadTime: leadTimeBand,
  changeFailure: changeFailureBand,
  timeToRestore: restoreBand,
};

const THRESHOLDS_OF: Record<DoraMeasure, (profile: DoraProfile) => BandThresholds> = {
  deploymentFrequency: (p) => p.deployFrequency,
  leadTime: (p) => p.leadTimeHours,
  changeFailure: (p) => p.changeFailure,
  timeToRestore: (p) => p.restoreHours,
};

type UpperBand = Exclude<Band, "low">;
const NEXT_BAND: Record<Band, UpperBand | null> = { low: "medium", medium: "high", high: "elite", elite: null };
/** Where each band's threshold sits in a profile's `[elite, high, medium]` tuple. */
const THRESHOLD_INDEX: Record<UpperBand, 0 | 1 | 2> = { elite: 0, high: 1, medium: 2 };

/**
 * The band a value falls in for a measure and the gap to the next one, using the same comparisons as `dora.ts`.
 * Deployment frequency must rise to the threshold (`>=`) and change failure fall to it (`<=`). The durations need
 * the value to fall below the threshold by any amount (`<`), so a lead time of exactly 24 hours is high with a gap
 * of zero to elite.
 */
export function doraBandPosition(measure: DoraMeasure, value: number, profile: DoraProfile): BandPosition {
  const band = BAND_OF[measure](value, profile);
  const next = NEXT_BAND[band];
  if (next === null) return { band, next: null, threshold: null, gap: null };
  const threshold = THRESHOLDS_OF[measure](profile)[THRESHOLD_INDEX[next]];
  const gap = measure === "deploymentFrequency" ? threshold - value : value - threshold;
  return { band, next, threshold, gap };
}

const PARTS: readonly LeadTimePart[] = ["coding", "waitingForReview", "inReview", "toMerge", "toDeploy"];

/** One shipped pull request, measured from the same pair `leadTimes` uses. */
interface Shipped {
  deployRunId: number;
  leadHours: number;
  size: number;
  parts: Record<LeadTimePart, number>;
}

/**
 * The four review stages of a merged pull request with its draft time moved into coding. The stages from
 * `prTimings` count waiting for review from when the pull request opened; here it starts when it was ready for
 * review, as time to first review does, so a long draft is not read as a slow review. Only time is moved between
 * coding and waiting, so the four still add up to the same total.
 */
function stagesWithDraftAsCoding(pr: PullRequest): Record<Exclude<LeadTimePart, "toDeploy">, number> {
  const stages = prTimings(pr).stages!; // a shipped pull request is merged, so it always has stages
  const readyAt = pr.publishedAt ?? pr.createdAt;
  const firstReviewAt = earliestExternalReview(pr);
  const waitEnd = firstReviewAt && firstReviewAt < pr.mergedAt! ? firstReviewAt : pr.mergedAt!;
  const fromReady = Math.max(0, hoursBetween(readyAt, waitEnd) ?? 0);
  const waitingForReview = Math.min(stages.waitingForReview, fromReady);
  return { ...stages, coding: stages.coding + stages.waitingForReview - waitingForReview, waitingForReview };
}

/** When someone other than the author first reviewed the pull request, as `prTimings` reads it. */
function earliestExternalReview(pr: PullRequest): string | null {
  return (
    externalReviews(pr)
      .map((r) => r.submittedAt!)
      .sort()[0] ?? null
  );
}

/**
 * Every shipped pull request with a readable lead time, split into parts. The four review stages run from work
 * start to merge, with draft time counted as coding; merge to deploy runs on to the deploy's completion. The parts
 * therefore add up to the lead time exactly, unless inconsistent timestamps make a clamp at zero fire.
 */
function measureShipped(prs: readonly PullRequest[], production: readonly DeployRun[], branch: string): Shipped[] {
  const result: Shipped[] = [];
  for (const { pr, deploy } of shippedPrs(prs, production, branch)) {
    const leadHours = hoursBetween(workStartedAt(pr), deploy.completedAt);
    if (leadHours === null) continue; // `leadTimes` leaves these out too
    const stages = stagesWithDraftAsCoding(pr);
    const toDeploy = Math.max(0, hoursBetween(pr.mergedAt, deploy.completedAt) ?? 0);
    result.push({ deployRunId: deploy.runId, leadHours, size: pr.additions + pr.deletions, parts: { ...stages, toDeploy } });
  }
  return result;
}

function leadTimeDrivers(shipped: Shipped[]): LeadTimeDrivers {
  // The mean of each pull request's parts added together, so the parts below always sum to it. It equals the
  // mean lead time whenever no clamp fires (see `measureShipped`).
  const meanHours = mean(shipped.map((s) => PARTS.reduce((sum, part) => sum + s.parts[part], 0)));
  const partMeans = PARTS.map((part) => ({ part, meanHours: mean(shipped.map((s) => s.parts[part])) ?? 0 }));
  const whole = partMeans.reduce((sum, p) => sum + p.meanHours, 0);
  return {
    count: shipped.length,
    meanHours,
    p75Hours: summarise(shipped.map((s) => s.leadHours)).p75,
    // A stable sort, so equal parts keep the order of the stages.
    parts: shipped.length
      ? partMeans.map((p) => ({ ...p, share: whole > 0 ? p.meanHours / whole : 0 })).sort((a, b) => b.meanHours - a.meanHours)
      : [],
    size: summarise(shipped.map((s) => s.size)),
  };
}

/**
 * True for a week, given by its Monday, that lies wholly inside the range: it starts at or after `from` and had
 * finished by `to`. A range that starts mid-week leaves its first week partial, as one that ends mid-week does its last.
 */
function isCompleteWeek(week: string, range: { from: string; to: string }): boolean {
  return Date.parse(week) >= Date.parse(range.from) && !isPartialWeek(week, range.to);
}

function deployFrequencyDrivers(
  successes: DeployRun[],
  shipped: Shipped[],
  weeks: string[],
  range: { from: string; to: string },
): DeployFrequencyDrivers {
  const complete = weeks.filter((week) => isCompleteWeek(week, range));
  const deployWeeks = new Set(successes.map((r) => weekStart(r.createdAt)));
  const perDeploy = new Map<number, number>();
  for (const s of shipped) perDeploy.set(s.deployRunId, (perDeploy.get(s.deployRunId) ?? 0) + 1);
  return {
    deploys: successes.length,
    weeks: complete.length,
    weeksWithoutDeploy: complete.filter((week) => !deployWeeks.has(week)).length,
    prsPerDeploy: summarise([...perDeploy.values()]),
  };
}

function changeFailureDrivers(production: DeployRun[], rework: ChangeFailureDrivers["rework"]): ChangeFailureDrivers {
  const byName = new Map<string, { workflow: string; failed: number; total: number }>();
  for (const run of production) {
    const row = byName.get(run.workflow) ?? { workflow: run.workflow, failed: 0, total: 0 };
    row.total += 1;
    if (run.conclusion === "failure") row.failed += 1;
    byName.set(run.workflow, row);
  }
  return {
    failed: production.filter((r) => r.conclusion === "failure").length,
    total: production.length,
    byWorkflow: [...byName.values()].sort((a, b) => b.failed - a.failed || a.workflow.localeCompare(b.workflow)),
    rework,
  };
}

/** Walks the runs as `restoreTimes` does, also counting the failed runs in each streak and any left unrecovered. */
function restoreDrivers(production: DeployRun[]): RestoreDrivers {
  const recovered: { hours: number; failedRuns: number }[] = [];
  let streakStart: DeployRun | null = null;
  let failedRuns = 0;
  for (const run of production) {
    if (run.conclusion === "failure") {
      streakStart ??= run;
      failedRuns += 1;
    } else if (streakStart) {
      const hours = hoursBetween(streakStart.completedAt, run.completedAt);
      if (hours !== null) recovered.push({ hours, failedRuns });
      streakStart = null;
      failedRuns = 0;
    }
  }
  return {
    streaks: recovered.length,
    failedRunsPerStreak: summarise(recovered.map((r) => r.failedRuns)),
    longestHours: recovered.length ? Math.max(...recovered.map((r) => r.hours)) : null,
    unrecovered: streakStart ? { since: streakStart.createdAt, failedRuns } : null,
  };
}

/**
 * The drivers behind each DORA figure over the range, for the deploy branch. Pull requests are those merged in the
 * range and runs those started in it, compared exactly as `buildReport` scopes them, so passing the report's already
 * scoped lists changes nothing. Positions grade the very figures `doraSummary` returns for the same inputs, with the
 * same week count (every week the range touches, the partial one included), so an explanation agrees with its tile.
 */
export function doraDrivers(
  prs: PullRequest[],
  runs: DeployRun[],
  branch: string,
  range: { from: string; to: string },
  profile: DoraProfile,
): DoraDrivers {
  const scopedPrs = prs.filter((p) => isWithin(p.mergedAt, range.from, range.to));
  const production = productionRuns(runs, branch).filter((r) => isWithin(r.createdAt, range.from, range.to));
  const successes = production.filter((r) => r.conclusion === "success");
  const weeks = weekRange(weekStart(range.from), weekStart(range.to));
  const summary = doraSummary(scopedPrs, production, branch, weeks.length, profile);
  const shipped = measureShipped(scopedPrs, production, branch);
  const rework = summary.changeFailure?.rework;

  return {
    position: {
      deploymentFrequency: summary.deploymentFrequency
        ? doraBandPosition("deploymentFrequency", summary.deploymentFrequency.perWeek, profile)
        : null,
      leadTime: summary.leadTime ? doraBandPosition("leadTime", summary.leadTime.medianHours, profile) : null,
      changeFailure: summary.changeFailure ? doraBandPosition("changeFailure", summary.changeFailure.rate, profile) : null,
      timeToRestore: summary.timeToRestore ? doraBandPosition("timeToRestore", summary.timeToRestore.medianHours, profile) : null,
    },
    leadTime: leadTimeDrivers(shipped),
    deploymentFrequency: deployFrequencyDrivers(successes, shipped, weeks, range),
    changeFailure: changeFailureDrivers(production, rework ? { deploys: rework.deploys, total: rework.total } : null),
    timeToRestore: restoreDrivers(production),
  };
}
