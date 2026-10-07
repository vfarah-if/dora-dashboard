import type { DeployRun, PullRequest, RepoIssue } from "../src/types.js";

/** An open issue of acme/widgets with nothing special about it. */
export function issue(overrides: Partial<RepoIssue> & { number: number }): RepoIssue {
  return {
    title: `Issue ${overrides.number}`,
    url: `https://github.com/acme/widgets/issues/${overrides.number}`,
    state: "open",
    closeReason: null,
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-01T09:00:00Z",
    closedAt: null,
    author: "alice",
    assignees: [],
    labels: [],
    issueType: null,
    closedBy: [],
    events: [],
    ...overrides,
  };
}

/** An issue closed at `closedAt`, as completed unless said otherwise, with the close recorded as an event. */
export function closedIssue(overrides: Partial<RepoIssue> & { number: number; closedAt: string }): RepoIssue {
  const reason = overrides.closeReason ?? "completed";
  return issue({
    state: "closed",
    closeReason: reason,
    updatedAt: overrides.closedAt,
    events: [{ at: overrides.closedAt, type: "closed", reason }],
    ...overrides,
  });
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
