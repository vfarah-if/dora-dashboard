// ADR 0016
import type { PullRequest } from "./types.js";
import { isRevertOrHotfix } from "./dora.js";
import { isBot, prTimings } from "./pullRequests.js";
import { median, p75 } from "./stats.js";

/** What marks a pull request as AI-assisted: a label, compared case-insensitively, or a co-author name pattern. */
export interface AiSignals {
  labels: readonly string[];
  coAuthors: readonly RegExp[];
}

/**
 * Patterns match the whole name an assistant signs with (or its bot login), so a person called Claude Martin or
 * Devin Patel is not counted. A bare `ai` label is left out because repositories that build AI features use it as a
 * product area.
 */
export const DEFAULT_AI_SIGNALS: AiSignals = {
  labels: ["ai-assisted"],
  coAuthors: [
    /^claude(\s+(opus|sonnet|haiku|fable|code)\b.*)?$/i,
    /^(github\s+)?copilot(\b.*)?$/i,
    /^cursor(\s*agent|\[bot\])?$/i,
    /^(openai\s+)?codex(\b.*)?$/i,
    /^devin(\s+ai|-ai-integration\[bot\]|\[bot\])?$/i,
    /^gemini(\s+code\s+assist|-code-assist\[bot\]|\[bot\])?$/i,
  ],
};

/** `unknown` means the PR was crawled before labels and trailers were recorded, so it cannot be classed. */
export type AiAssistance = "assisted" | "unassisted" | "unknown";

/**
 * A PR is assisted when any label matches, any co-author matches, or it was opened by a bot whose login matches a
 * co-author pattern. It is unknown when neither labels nor co-authors were recorded, and otherwise unassisted.
 * Unmarked AI use therefore counts as unassisted.
 */
export function aiAssistance(pr: PullRequest, signals: AiSignals = DEFAULT_AI_SIGNALS): AiAssistance {
  const wanted = new Set(signals.labels.map((l) => l.toLowerCase()));
  const matchesCoAuthor = (name: string) => signals.coAuthors.some((pattern) => pattern.test(name));
  if (pr.labels?.some((l) => wanted.has(l.toLowerCase()))) return "assisted";
  if (pr.coAuthors?.some(matchesCoAuthor)) return "assisted";
  if (isBot(pr) && pr.author !== null && matchesCoAuthor(pr.author)) return "assisted";
  if (pr.labels == null && pr.coAuthors == null) return "unknown";
  return "unassisted";
}

export interface Cohort {
  prs: number;
  /** Median hours from first commit to merge (the PR cycle time), not to deploy. */
  medianCycleHours: number | null;
  p75CycleHours: number | null;
  /** Median additions plus deletions. */
  medianSize: number | null;
  /** Share of the cohort reviewed by someone other than the author. */
  reviewedShare: number | null;
  /** Share of the cohort whose title marks it as a revert or hotfix. */
  revertShare: number | null;
}

export interface AiCohorts {
  assisted: Cohort;
  unassisted: Cohort;
  /** PRs that could not be classed because they were crawled before labels and trailers were recorded. */
  unknown: number;
}

function cohortOf(prs: readonly PullRequest[]): Cohort {
  const timings = prs.map(prTimings);
  const cycle = timings.map((t) => t.cycleHours).filter((h): h is number => h !== null);
  const share = (count: number) => (prs.length ? count / prs.length : null);
  return {
    prs: prs.length,
    medianCycleHours: median(cycle),
    p75CycleHours: p75(cycle),
    medianSize: median(timings.map((t) => t.size)),
    reviewedShare: share(timings.filter((t) => t.reviewed).length),
    revertShare: share(prs.filter(isRevertOrHotfix).length),
  };
}

/** Splits pull requests, normally those merged in the range, into assisted and unassisted cohorts. */
export function aiCohorts(prs: readonly PullRequest[], signals: AiSignals = DEFAULT_AI_SIGNALS): AiCohorts {
  const assisted: PullRequest[] = [];
  const unassisted: PullRequest[] = [];
  let unknown = 0;
  for (const pr of prs) {
    const kind = aiAssistance(pr, signals);
    if (kind === "assisted") assisted.push(pr);
    else if (kind === "unassisted") unassisted.push(pr);
    else unknown += 1;
  }
  return { assisted: cohortOf(assisted), unassisted: cohortOf(unassisted), unknown };
}
