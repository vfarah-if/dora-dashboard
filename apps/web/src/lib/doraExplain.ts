import { doraProfile } from "@dora-dashboard/core";
import type { BandPosition, DoraMeasure, DoraProfile, LeadTimePart, RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { durationUnit, formatDate, formatDurationIn, formatNumber, formatPercent, placesNeeded } from "./format";

/*
 * Core computes every figure (ADR 0022). This module chooses which findings to list, which practices to suggest and
 * which sentence from copy.ts describes each one. Nothing here names a person.
 */

const text = copy.dora.explain;

export type PracticeKey = keyof typeof text.practices;

export interface Practice {
  name: string;
  url: string;
  why: string;
}

export interface DoraExplanation {
  /** What the measure's current band means, cited to DORA. */
  meaning: string;
  source: { label: string; href: string };
  /** The value, the next band's requirement and how far away it is, or what holds an elite figure there. */
  gap: string;
  /** Two or three sentences from the team's own data, the largest driver first, at every band, so an elite figure says why it holds. */
  findings: string[];
  practices: Practice[];
  /** The 2023 report's finding on code review, present only below elite when waiting for review is the largest driver. */
  quote: { text: string; label: string; href: string } | null;
  /** A line about the measure's name in DORA's report, where it differs from this dashboard's. */
  note: string | null;
}

type Driver =
  "waitingForReview" | "codingTime" | "mergeToDeploy" | "fewDeploys" | "largeBatches" | "highFailureRate" | "slowRestore";

/** The driver to practice mapping of ADR 0022. At most three practices are shown, in this order, repeats removed. */
const DRIVER_PRACTICES: Record<Driver, readonly PracticeKey[]> = {
  waitingForReview: ["streamliningChangeApproval", "workingInSmallBatches", "trunkBasedDevelopment"],
  codingTime: ["workingInSmallBatches", "trunkBasedDevelopment"],
  mergeToDeploy: ["deploymentAutomation", "continuousDelivery"],
  fewDeploys: ["deploymentAutomation", "continuousDelivery"],
  largeBatches: ["workingInSmallBatches", "continuousIntegration"],
  highFailureRate: ["testAutomation", "continuousIntegration", "codeMaintainability"],
  slowRestore: ["monitoringAndObservability", "proactiveFailureNotification", "deploymentAutomation"],
};

/** Any of the three review parts is waiting for review; coding and merge to deploy stand alone. */
const PART_DRIVER: Record<LeadTimePart, Driver> = {
  coding: "codingTime",
  waitingForReview: "waitingForReview",
  inReview: "waitingForReview",
  toMerge: "waitingForReview",
  toDeploy: "mergeToDeploy",
};

const MAX_PRACTICES = 3;

interface Analysis {
  findings: string[];
  drivers: Driver[];
}

const NONE: Analysis = { findings: [], drivers: [] };

/*
 * Each analysis states its findings at every band, so an elite figure says why it holds. Whether its drivers lead to
 * practices is decided once, in `explainOne`, which offers practices only below elite.
 */

function leadTimeAnalysis(report: RepoReport): Analysis {
  const { parts, meanHours, p75Hours, size } = report.doraDrivers.leadTime;
  const [first, second] = parts;
  if (!first || meanHours === null) return NONE;
  const part = (p: LeadTimePart) => text.parts[p];
  const findings = [
    text.findings.largestPart(
      part(first.part),
      formatDurationIn(first.meanHours),
      formatPercent(first.share),
      formatDurationIn(meanHours),
    ),
  ];
  if (second && second.meanHours > 0) {
    findings.push(text.findings.nextPart(part(second.part), formatDurationIn(second.meanHours), formatPercent(second.share)));
  }
  if (p75Hours !== null) {
    findings.push(text.findings.spread(formatDurationIn(p75Hours), size.median === null ? null : formatNumber(size.median, 0)));
  }
  // The size is shown but never triggers a practice.
  return { findings, drivers: [PART_DRIVER[first.part]] };
}

/**
 * States the tile's own deploys and weeks first, so a reader can divide one by the other and reach the tile, then
 * the complete weeks with no deploy. The tile counts every week the range touches; only complete weeks can be empty.
 */
function deploymentFrequencyAnalysis(report: RepoReport): Analysis {
  const tile = report.dora.deploymentFrequency!; // `explainOne` analyses only a measured figure
  const { weeks, weeksWithoutDeploy, prsPerDeploy } = report.doraDrivers.deploymentFrequency;
  const findings = [text.findings.fewDeploys(tile.total, tile.weeks, weeks, weeksWithoutDeploy)];
  const found: Driver[] = ["fewDeploys"];
  if (prsPerDeploy.median !== null && prsPerDeploy.median > 1) {
    findings.push(text.findings.largeBatches(formatNumber(prsPerDeploy.median, 1)));
    found.push("largeBatches");
  }
  return { findings, drivers: found };
}

function changeFailureAnalysis(report: RepoReport): Analysis {
  const { failed, total, byWorkflow, rework } = report.doraDrivers.changeFailure;
  if (total === 0) return NONE;
  const findings = [text.findings.failures(failed, total, formatPercent(failed / total))];
  const worst = byWorkflow[0];
  if (worst && worst.failed > 0) findings.push(text.findings.worstWorkflow(worst.workflow, worst.failed, worst.total));
  if (rework) findings.push(text.findings.rework(rework.deploys, rework.total));
  return { findings, drivers: ["highFailureRate"] };
}

function timeToRestoreAnalysis(report: RepoReport): Analysis {
  const { streaks, failedRunsPerStreak, longestHours, unrecovered } = report.doraDrivers.timeToRestore;
  const findings: string[] = [];
  // An open streak comes first, because the median only sees streaks that recovered.
  if (unrecovered) findings.push(text.findings.unrecovered(formatDate(unrecovered.since), unrecovered.failedRuns));
  if (streaks > 0) {
    findings.push(
      text.findings.streaks(
        streaks,
        failedRunsPerStreak.median === null ? null : formatNumber(failedRunsPerStreak.median, 1),
        longestHours === null ? null : formatDurationIn(longestHours),
      ),
    );
  }
  return { findings, drivers: ["slowRestore"] };
}

const ANALYSE: Record<DoraMeasure, (report: RepoReport) => Analysis> = {
  deploymentFrequency: deploymentFrequencyAnalysis,
  leadTime: leadTimeAnalysis,
  changeFailure: changeFailureAnalysis,
  timeToRestore: timeToRestoreAnalysis,
};

/** The measured figure behind each tile, or null when the measure is missing. */
function valueOf(report: RepoReport, measure: DoraMeasure): number | null {
  const { dora } = report;
  switch (measure) {
    case "deploymentFrequency":
      return dora.deploymentFrequency?.perWeek ?? null;
    case "leadTime":
      return dora.leadTime?.medianHours ?? null;
    case "changeFailure":
      return dora.changeFailure?.rate ?? null;
    case "timeToRestore":
      return dora.timeToRestore?.medianHours ?? null;
  }
}

/** A value and a distance from it, written to the same precision so one can be read off the other. */
interface Written {
  value: string;
  distance: string;
}

/** How a measure is written and compared, so the gap sentence uses the same units as its tile. */
interface Wording {
  /** The value and a threshold's distance from it, to the same precision. */
  write: (value: number, distance: number) => Written;
  /** What reaching a threshold requires, written out. */
  require: (value: number) => string;
  /** The elite threshold in the profile. */
  elite: (profile: DoraProfile) => number;
  /** Distance in the measure's own direction, positive when the value is better than the threshold. */
  inside: (value: number, threshold: number) => number;
  /** The gap sentence for a figure below the next band. */
  raise: (value: string, band: string, requirement: string, by: string) => string;
}

/**
 * Deploys a week to one place, as the tile writes them, or to more when one place would show the distance as zero.
 * Thresholds keep up to two places, so the low band's 0.25 a week is written in full.
 */
function writeFrequency(value: number, distance: number): Written {
  const places = placesNeeded(distance, 1, 1);
  return { value: copy.dora.perWeek(formatNumber(value, places)), distance: copy.dora.perWeek(formatNumber(distance, places)) };
}

/**
 * A rate as a whole percentage, as the tile writes it, unless the distance needs a decimal to be read correctly,
 * when both take one: 24.4% is 9.4 points above 15%, where 24% would not add up.
 */
function writeRate(value: number, distance: number): Written {
  const places = placesNeeded(distance * 100, 0, 1);
  return {
    value: `${formatNumber(value * 100, places)}%`,
    distance: text.gap.points(formatNumber(distance * 100, places)),
  };
}

/**
 * A duration and a distance in the value's unit, so 8.3 days is 1.3 days above 7 days. A distance too small to
 * show in that unit is written in its own instead.
 */
function writeDuration(value: number, distance: number): Written {
  const inUnit = formatDurationIn(distance, durationUnit(value));
  const showsZero = distance > 0 && /^0 /.test(inUnit);
  return { value: formatDurationIn(value), distance: showsZero ? formatDurationIn(distance) : inUnit };
}

const percentLimit = (value: number) => `${formatNumber(value * 100, 1)}%`;

const WORDING: Record<DoraMeasure, Wording> = {
  deploymentFrequency: {
    write: writeFrequency,
    require: (v) => text.gap.atLeast(copy.dora.perWeek(formatNumber(v, 2))),
    elite: (p) => p.deployFrequency[0],
    inside: (v, t) => v - t,
    raise: text.gap.raise,
  },
  leadTime: {
    write: writeDuration,
    require: (v) => text.gap.under(formatDurationIn(v)),
    elite: (p) => p.leadTimeHours[0],
    inside: (v, t) => t - v,
    raise: text.gap.lowerDuration,
  },
  changeFailure: {
    write: writeRate,
    require: (v) => text.gap.atMost(percentLimit(v)),
    elite: (p) => p.changeFailure[0],
    inside: (v, t) => t - v,
    raise: text.gap.lowerRate,
  },
  timeToRestore: {
    write: writeDuration,
    require: (v) => text.gap.under(formatDurationIn(v)),
    elite: (p) => p.restoreHours[0],
    inside: (v, t) => t - v,
    raise: text.gap.lowerDuration,
  },
};

function gapSentence(measure: DoraMeasure, value: number, position: BandPosition, profile: DoraProfile): string {
  const w = WORDING[measure];
  if (position.next === null || position.threshold === null || position.gap === null) {
    const limit = w.elite(profile);
    const margin = w.inside(value, limit);
    const written = w.write(value, margin);
    return margin === 0
      ? text.gap.holdsOnLimit(written.value, w.require(limit))
      : text.gap.holds(written.value, w.require(limit), written.distance);
  }
  const band = copy.dora.band[position.next];
  const written = w.write(value, position.gap);
  if (position.gap === 0) {
    // Only the strict durations can sit exactly on a threshold without already being in the band.
    return text.gap.onLimit(written.value, band, w.require(position.threshold));
  }
  return w.raise(written.value, band, w.require(position.threshold), written.distance);
}

function practicesFor(found: readonly Driver[]): Practice[] {
  const keys = [...new Set(found.flatMap((driver) => DRIVER_PRACTICES[driver]))].slice(0, MAX_PRACTICES);
  return keys.map((key) => ({ name: text.practices[key].name, url: text.practices[key].href, why: text.practices[key].why }));
}

function explainOne(report: RepoReport, measure: DoraMeasure): DoraExplanation | null {
  const value = valueOf(report, measure);
  const position = report.doraDrivers.position[measure];
  if (value === null || position === null) return null;
  const { findings, drivers } = ANALYSE[measure](report);
  // An elite figure is explained by its findings, but there is no band to move up to, so no practice is suggested.
  const advise = position.band !== "elite";
  return {
    meaning: text.meaning[measure][position.band],
    source: text.source,
    gap: gapSentence(measure, value, position, doraProfile(report.dora.profile.id)),
    findings,
    practices: advise ? practicesFor(drivers) : [],
    quote: advise && drivers[0] === "waitingForReview" ? text.reviewQuote : null,
    note: measure === "timeToRestore" ? text.restoreRename : null,
  };
}

const MEASURES: readonly DoraMeasure[] = ["deploymentFrequency", "leadTime", "changeFailure", "timeToRestore"];

/** An explanation for each measure of the report, or null for one that was not measured, so a missing figure is never explained. */
export function explainDora(report: RepoReport): Record<DoraMeasure, DoraExplanation | null> {
  return Object.fromEntries(MEASURES.map((m) => [m, explainOne(report, m)])) as Record<DoraMeasure, DoraExplanation | null>;
}
