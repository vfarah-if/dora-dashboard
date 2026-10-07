import { instant } from "./delivery.js";
import { isBot } from "./pullRequests.js";
import type { PullRequest, Repo, RepoIssue } from "./types.js";

/**
 * Which pull requests belong to which GitHub issue, the way Jira matches keys (ADR 0021), read from three places
 * (ADR 0028): a closing reference on the issue, `#n` in the pull request title, and a number in its branch name.
 */

/** `#12` in a title, not part of a longer word or number: no letter, digit or underscore just before or after it. */
const TITLE_REFERENCE = /(?<!\w)#(\d+)(?!\w)/g;
/**
 * A branch segment such as `526-tts-gating`, `issue-389-crash` or a bare `123`, as in `feat/526-tts-gating`. The number
 * must start the segment (after an optional word and hyphen) and end at a hyphen, underscore, slash or the end of the
 * name. A number followed by a hyphen or underscore and another digit is a date or a version shape, such as the 2026 in
 * `release/2026-10-07` or `backup/2025_03_01`, and does not count. Lookalikes that do not fit that shape, such as
 * `v2026.10` or `2026x`, never matched.
 */
const BRANCH_REFERENCE = /(?:^|\/)(?:[a-z]+-)?(\d+)(?=\/|$|[-_](?!\d))/gi;

export interface IssueLinks {
  /** Every stored issue's number, with its linked pull requests in number order; empty when none are linked. */
  byIssue: Map<number, PullRequest[]>;
  /** The numbers of the pull requests linked to at least one issue. */
  linkedPrNumbers: Set<number>;
}

const numbersIn = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map((m) => Number(m[1]));

/**
 * Links each issue of the repository to its pull requests. A closing reference counts when it names this repository
 * and a stored pull request, whatever the dates. A number in a title or branch counts only when it is a stored issue of
 * this repository, created at or before the pull request, and not already closed when the pull request was created
 * (closed, with a final close before `pr.createdAt`; an issue reopened and closed again later has a later close and
 * still counts). Issue and pull request numbers share one sequence on GitHub, so the first condition also rules out
 * the numbers of pull requests. A date-shaped branch segment is ruled out by the branch pattern. This is a heuristic:
 * an open issue whose number happens to appear in a title or branch is still linked. Pull requests by bots are ignored.
 */
export function linkIssues(
  repo: Pick<Repo, "owner" | "name">,
  issues: readonly RepoIssue[],
  prs: readonly PullRequest[],
): IssueLinks {
  const id = `${repo.owner}/${repo.name}`.toLowerCase();
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const linked = new Map<number, Map<number, PullRequest>>(issues.map((issue) => [issue.number, new Map()]));
  const link = (issueNumber: number, pr: PullRequest) => linked.get(issueNumber)?.set(pr.number, pr);

  for (const issue of issues) {
    for (const ref of issue.closedBy) {
      const pr = prByNumber.get(ref.number);
      if (pr && ref.repo.toLowerCase() === id && !isBot(pr)) link(issue.number, pr);
    }
  }
  for (const pr of prs.filter((p) => !isBot(p))) {
    const named = [...numbersIn(TITLE_REFERENCE, pr.title), ...numbersIn(BRANCH_REFERENCE, pr.headRef ?? "")];
    for (const number of named) {
      const issue = issueByNumber.get(number);
      if (!issue || instant(issue.createdAt) > instant(pr.createdAt)) continue;
      const closedBefore = issue.state === "closed" && instant(issue.closedAt) < instant(pr.createdAt);
      if (!closedBefore) link(number, pr);
    }
  }

  const byIssue = new Map(
    [...linked].map(([number, found]) => [number, [...found.values()].sort((a, b) => a.number - b.number)]),
  );
  const linkedPrNumbers = new Set([...byIssue.values()].flatMap((list) => list.map((pr) => pr.number)));
  return { byIssue, linkedPrNumbers };
}
