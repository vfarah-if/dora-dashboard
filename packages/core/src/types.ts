/** Where a repository's or a tracked space's crawl stands. */
export type CrawlStatus = "idle" | "crawling" | "failed";

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
  crawlStatus: CrawlStatus;
  crawlError: string | null;
  crawlProgress: string | null;
}

export interface Review {
  author: string | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null;
  /** True when the reviewer is a bot account. Absent when the host did not say; the login is then checked instead. */
  authorIsBot?: boolean;
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
  /** The branch the pull request was opened from. Absent on pull requests crawled before it was recorded. */
  headRef?: string | null;
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

/** Someone, or a team, asked to review a pull request and yet to do so. */
export interface RequestedReviewer {
  /** A user's login, or a team's name. */
  name: string;
  isTeam: boolean;
}

/** An open pull request, read live from the code host for the review queue. */
export interface OpenPullRequest extends PullRequest {
  isDraft: boolean;
  requestedReviewers: RequestedReviewer[];
  /** The branch the pull request was opened from. */
  headRef: string;
  /** State of the newest commit's checks: "none" when the repository reports no checks. */
  checks: "passing" | "failing" | "pending" | "none";
  /** Issues the pull request is set to close, as `#12`. */
  linkedIssues: string[];
  /** Number of files changed, as reported by the host. */
  changedFiles: number;
  /** The description, used only to find `Related:` lines. It is never sent to the browser. */
  body?: string;
}

/** Who has to act next on an open pull request. */
export type ReviewLane = "held" | "with_author" | "approved" | "awaiting_review" | "no_reviewer";

/** How long a pull request has waited, in weekday hours: fresh under 4, ageing 4 to 24, overdue over 24, stale from 120. */
export type WaitBand = "fresh" | "ageing" | "overdue" | "stale";

export interface QueueEntry {
  /** `repoId#number`, unique across repositories. */
  key: string;
  repoId: number;
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Null unless names were asked for. */
  author: string | null;
  authorIsBot: boolean;
  lane: ReviewLane;
  band: WaitBand;
  /** Weekday hours (Monday to Friday, UTC) since `waitingSince`. */
  waitHours: number;
  /** The later of the time the pull request was published and the last review by someone else. */
  waitingSince: string;
  /** Empty unless names were asked for; use `requestedReviewerCount` for the number. */
  requestedReviewers: RequestedReviewer[];
  /** How many people or teams are asked to review; present whether or not names are. */
  requestedReviewerCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: OpenPullRequest["checks"];
  isDraft: boolean;
  labels: string[];
  ticketKeys: string[];
  /** Blank unless names were asked for, because branch names often carry a login. */
  headRef: string;
  updatedAt: string;
  /** Whole days since the pull request was last updated, by the wall clock. */
  idleDays: number;
}

export interface ReviewQueueTiles {
  /** Pull requests in the awaiting_review and no_reviewer lanes. */
  waiting: { count: number; repos: number; heldForRedChecks: number };
  /** Waiting pull requests over 24 weekday hours. */
  pastDay: { count: number; longestHours: number | null };
  noReviewer: { count: number; oldestHours: number | null };
  /** Waiting pull requests at 120 weekday hours (5 weekdays) or more. */
  stale: { count: number; longestHours: number | null };
  /** Waiting pull requests under 400 changed lines and under 10 files. */
  fastLane: { count: number };
  /** Open pull requests, in any lane, not updated for 14 days or more. */
  idle: { count: number };
}

export interface RepoQueueSummary {
  repoId: number;
  repo: string;
  open: number;
  /** Band counts over the waiting pull requests only. */
  bands: Record<WaitBand, number>;
  /** Lane counts over every open pull request. */
  lanes: Record<ReviewLane, number>;
}

export interface FeatureMember {
  key: string;
  repoId: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  lane: ReviewLane;
  waitHours: number;
}

/** Open pull requests that look like parts of one piece of work. */
export interface FeatureGroup {
  id: string;
  /** A ticket key when one is shared, otherwise the title of the longest waiting member. */
  title: string;
  /** Why these were joined: ticket, related (a `Related:` line), branch (a shared head branch) or stack. */
  evidence: ("ticket" | "related" | "branch" | "stack")[];
  ticketKeys: string[];
  members: FeatureMember[];
  lanes: Record<ReviewLane, number>;
  longestWaitHours: number;
}

export interface ReviewQueueError {
  repoId: number;
  repo: string;
  message: string;
}

export interface ReviewQueue {
  /** The time the waits were worked out at. */
  now: string;
  /** The oldest time any repository's pull requests were read from the host. */
  fetchedAt: string;
  /** Longest wait first. */
  entries: QueueEntry[];
  tiles: ReviewQueueTiles;
  repos: RepoQueueSummary[];
  /** Entry keys: stale with no reviewer, stale awaiting review, overdue with no reviewer; longest wait first within each. */
  needsAttention: string[];
  features: FeatureGroup[];
  /** Repositories that could not be read; the rest of the queue is still complete. */
  errors: ReviewQueueError[];
  /** Repositories that were read only in part, for example because they have more open pull requests than are fetched. */
  warnings: ReviewQueueError[];
}

/** One Jira Cloud site (an Atlassian instance) the connected account can reach. */
export interface TrackerSite {
  /** The site's cloud id, used in every API path. */
  id: string;
  url: string;
  name: string;
}

/** A space (Jira still calls it a project in its API) on a tracker site, as listed live. */
export interface TrackerSpaceSummary {
  key: string;
  name: string;
  /** "software", "business" or "service_desk" on Jira Cloud; null when the tracker does not say. */
  type: string | null;
}

/** Jira's three fixed status categories, which every team-defined status belongs to. */
export type StatusCategory = "todo" | "in_progress" | "done";

export interface TrackerStatus {
  id: string;
  name: string;
  category: StatusCategory;
}

/** One column of a space's board, and the statuses that place an issue in it. */
export interface BoardColumn {
  name: string;
  statusIds: string[];
}

/**
 * What reading a space's board came to, so "no columns" can be told from "could not look".
 * - `read`: a board was found and its columns read.
 * - `none`: the space has no board (a space without Jira Software, say), so every status is off the board.
 * - `forbidden`: Jira refused the board, because the grant lacks the board scope (`read:board-scope.admin:jira-software`)
 *   or the person cannot see the board. Columns are empty, but the board may well exist.
 */
export type BoardAccess = "read" | "none" | "forbidden";

/** A space the dashboard tracks, with what was learnt about it on the last crawl. */
export interface TrackerSpace {
  id: number;
  siteId: string;
  siteUrl: string;
  key: string;
  name: string;
  statuses: TrackerStatus[];
  /** The first board's columns, left to right; empty unless `board` is `read`. */
  columns: BoardColumn[];
  /**
   * Whether `columns` is empty because there is no board or because the board could not be read. Null means the board
   * has not been read yet (a space linked but not yet crawled), which says nothing about whether it has one.
   */
  board: BoardAccess | null;
  lastCrawledAt: string | null;
  crawlStatus: CrawlStatus;
  crawlError: string | null;
  crawlProgress: string | null;
  /**
   * Assignee display names by account id, as of the last full crawl plus any that incremental crawls have added or
   * updated since. Shown only behind "Show people" (ADR 0008,
   * ADR 0021). Absent on spaces crawled before names were recorded.
   */
  people?: Record<string, string>;
}

/*
 * Bodies of the tracker routes, kept in core beside the domain types so the API and the web share one definition
 * rather than each keeping a copy, as they already share `CodeHealthResponse`.
 */

/** The body of `GET /api/jira`: whether the signed-in person has connected Jira, and the sites they can reach. */
export interface JiraConnection {
  /** Always true: the route is absent when Jira is not configured on the server. */
  enabled: true;
  connected: boolean;
  /** Empty when not connected. */
  sites: TrackerSite[];
  /**
   * Present only when not connected, and only when the server knows why a connection it once held is gone: `idle`
   * when it went unused for as long as a session lasts, `refused` when Jira turned the connection down, `expired` when
   * its access token ran out with no refresh token to renew it. Omitted for someone who has never connected, or whose
   * lapse the server no longer remembers.
   */
  lapsed?: "idle" | "refused" | "expired";
}

/** One space's statuses and board columns, read live so the picker shows how it flows before anything is linked. */
export interface SpaceDescription {
  statuses: TrackerStatus[];
  columns: BoardColumn[];
  /** Why `columns` is empty, when it is. */
  board: BoardAccess;
}

/** A tracked space as the spaces list shows it: its crawl state, how many items are held and the repositories it feeds. */
export interface SpaceListing {
  id: number;
  key: string;
  name: string;
  siteUrl: string;
  lastCrawledAt: string | null;
  crawlStatus: CrawlStatus;
  /** Why the last crawl failed, or null. Fit to show to the person. */
  crawlError: string | null;
  workItemCount: number;
  repos: { id: number; name: string }[];
}

/**
 * A linked space with how many of its work items are stored. It never carries assignee names (ADR 0008), and `never`
 * makes spreading a whole space into one a compile error rather than a leak.
 */
export type LinkedSpace = Omit<TrackerSpace, "people"> & { workItemCount: number; people?: never };

/** Where an issue sits in Jira's hierarchy: a sub-task, a standard issue (story, bug, task) or an epic and above. */
export type WorkItemLevel = "subtask" | "standard" | "epic";

/** One status change in an issue's history. */
export interface WorkItemTransition {
  at: string;
  /** Status names; `from` is null for the first status an issue was created in. */
  from: string | null;
  to: string;
  /** Null when the status no longer exists in the space, so its category cannot be looked up. */
  fromCategory: StatusCategory | null;
  toCategory: StatusCategory | null;
}

/** An issue read from a tracker, with its status history oldest first. */
export interface WorkItem {
  key: string;
  spaceKey: string;
  /** The issue type's name, such as "Story", "Bug", "Task" or "Sub-task". */
  type: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory | null;
  createdAt: string;
  updatedAt: string;
  /** When the issue was resolved; null while it is unresolved. */
  resolvedAt: string | null;
  /** The tracker's opaque account id; never a name or an email (ADR 0008). */
  assigneeId: string | null;
  parentKey: string | null;
  labels: string[];
  transitions: WorkItemTransition[];
  /** From the issue type's hierarchy level. Absent on items crawled before it was recorded; the type name is used then. */
  level?: WorkItemLevel;
}

/** A stable code the API adds to an error body when the web is expected to act on the error, not just show it. */
export type ApiErrorCode = "jira_unauthorised";

/** The body of an API error: a message fit to show the person, and a code when there is one to act on. */
export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}
