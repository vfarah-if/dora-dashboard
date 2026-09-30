import type { OpenPullRequest } from "../src/types.js";

export function open(overrides: Partial<OpenPullRequest> & { number: number }): OpenPullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/acme/widgets/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "OPEN",
    createdAt: "2026-09-28T08:00:00Z",
    publishedAt: "2026-09-28T08:00:00Z",
    mergedAt: null,
    closedAt: null,
    updatedAt: "2026-09-28T08:00:00Z",
    mergedBy: null,
    additions: 10,
    deletions: 2,
    firstCommitAt: null,
    baseRef: "main",
    reviews: [],
    isDraft: false,
    requestedReviewers: [],
    headRef: `feature-${overrides.number}`,
    checks: "passing",
    linkedIssues: [],
    changedFiles: 2,
    ...overrides,
  };
}
