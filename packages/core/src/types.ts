/** A repository the dashboard has been pointed at. */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  /** Workflow file names whose successful runs count as deployments, e.g. ["deploy.yml"]. */
  deployWorkflows: string[];
  /** Only runs on this branch count as deployments to production. */
  deployBranch: string;
  addedAt: string;
  lastCrawledAt: string | null;
  crawlStatus: "idle" | "crawling" | "failed";
  crawlError: string | null;
  crawlProgress: string | null;
}

export interface Review {
  author: string | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string | null;
  authorIsBot: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  /** When the PR left draft; equals createdAt for a PR opened ready for review. */
  publishedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  mergedBy: string | null;
  additions: number;
  deletions: number;
  /** Earliest authored or committed date of the PR's first commit. */
  firstCommitAt: string | null;
  baseRef: string;
  reviews: Review[];
  /** Paths of the files changed, capped at 100. Absent on pull requests crawled before this was recorded. */
  files?: string[] | null;
  /** True when the pull request changed more files than were recorded, so `files` is only the first part. */
  filesTruncated?: boolean;
  /** Label names on the pull request. Absent on pull requests crawled before this was recorded. */
  labels?: string[] | null;
  /**
   * Names from `Co-Authored-By` trailers on the PR's commits, with emails dropped (ADR 0016). Absent on pull
   * requests crawled before this was recorded.
   */
  coAuthors?: string[] | null;
}

export interface DeployRun {
  runId: number;
  workflow: string;
  branch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  /** Completion time; GitHub's updated_at on a completed run. */
  completedAt: string;
}
