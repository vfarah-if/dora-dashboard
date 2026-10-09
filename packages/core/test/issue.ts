import type { ClosedRepoIssue, DeployRun, OpenRepoIssue, PullRequest } from "../src/types.js";

/** What an open and a closed issue share. */
type IssueFields = Omit<OpenRepoIssue, "state" | "closeReason" | "closedAt">;

/** An open issue of acme/widgets with nothing special about it. */
export function issue(overrides: Partial<IssueFields> & { number: number }): OpenRepoIssue {
  return {
    title: `Issue ${overrides.number}`,
    url: `https://github.com/acme/widgets/issues/${overrides.number}`,
    state: "open",
    closeReason: null,
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-01T09:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    issueType: null,
    closedBy: [],
    events: [],
    ...overrides,
  };
}

/** An issue closed at `closedAt`, as completed unless said otherwise, with the close recorded as an event unless `events` is given. */
export function closedIssue(
  overrides: Partial<Omit<ClosedRepoIssue, "state">> & { number: number; closedAt: string },
): ClosedRepoIssue {
  const { closedAt, closeReason = "completed", ...fields } = overrides;
  return {
    ...issue({ updatedAt: closedAt, events: [{ at: closedAt, type: "closed" }], ...fields }),
    state: "closed",
    closeReason,
    closedAt,
  };
}

/** A merged pull request of acme/widgets into main. */
export function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/acme/widgets/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: "2026-09-01T14:00:00Z",
    closedAt: "2026-09-01T14:00:00Z",
    updatedAt: "2026-09-01T14:00:00Z",
    mergedBy: "alice",
    additions: 10,
    deletions: 5,
    firstCommitAt: null,
    baseRef: "main",
    headRef: null,
    reviews: [],
    ...overrides,
  };
}

/** A successful deploy run that completes ten minutes after it starts. */
export function deploy(runId: number, createdAt: string): DeployRun {
  return {
    runId,
    workflow: "deploy.yml",
    branch: "main",
    status: "completed",
    conclusion: "success",
    createdAt,
    completedAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
  };
}
