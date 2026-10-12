/**
 * The shapes and constants of the security report (ADR 0031 to ADR 0035), held apart from the functions that build
 * them so the crawl, the store, the report and the web all agree on one contract. Nothing here reads a clock or does
 * I/O. No field anywhere is named `secret`, and no shape carries a person's login (ADR 0008).
 */
import type { Band } from "./dora.js";
import type { GradePart } from "./codeGrade.js";
import type { Summary } from "./stats.js";
import type { Repo } from "./types.js";

// --- Alerts ---------------------------------------------------------------------------------------------------------

/** Where an alert came from. `osv` alerts are found by the optional OSV.dev lookup of locked dependencies. */
export const ALERT_SOURCES = ["dependabot", "code_scanning", "secret_scanning", "osv"] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

/**
 * In display order, most severe first, with `unknown` last. `unknown` is a published alert with no severity, graded as
 * medium, so `SEVERITY_RANK` in `securityAlerts.ts` ranks it just below a real medium when deciding which is worse.
 */
export const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AlertState = "open" | "fixed" | "dismissed";

/** An exploit prediction at or above this share marks an alert as likely to be exploited soon. */
export const LIKELY_EXPLOITED_EPSS = 0.1;

interface AlertBase {
  /** GitHub's alert number as text, or `${osvId}|${ecosystem}|${name}|${lockfile}` for OSV. Unique per source. */
  key: string;
  state: AlertState;
  /** When GitHub raised it, or for OSV the crawl that first found it, or found it again after it had been fixed. */
  createdAt: string;
  /** When it was fixed or dismissed, or for OSV the crawl in which it was no longer found. */
  closedAt: string | null;
  /** GitHub's own code for the close, never free text, such as `fixed`, `auto_dismissed`, `tolerable_risk` or `revoked`. */
  closeReason: string | null;
  /** The advisory summary, the rule description, or the secret type's display name. */
  title: string;
  /** GitHub's page for the alert, or the OSV advisory page. */
  url: string | null;
}

export interface DependencyAlert extends AlertBase {
  source: "dependabot" | "osv";
  /** As published: GitHub's advisory severity (moderate is medium), OSV's `database_specific.severity`, else unknown. */
  severity: Severity;
  dependency: {
    ecosystem: string;
    name: string;
    /** The manifest or lockfile that names the package. */
    manifestPath: string;
    scope: "runtime" | "development" | null;
    relationship: "direct" | "transitive" | null;
    lockedVersion: string | null;
    /** The first version that fixes it, or null when there is none yet. */
    patchedVersion: string | null;
    vulnerableRange: string | null;
    advisoryId: string;
    cveId: string | null;
    /** The exploit prediction scoring system figures, as fractions from 0 to 1. */
    epss: { percentage: number; percentile: number } | null;
    /** CVSS v4 base score when published, else v3, from 0 to 10. */
    cvssScore: number | null;
    /** Weakness ids such as "CWE-79". */
    cwes: string[];
  };
}

export interface CodeAlert extends AlertBase {
  source: "code_scanning";
  code: {
    ruleId: string;
    tool: string;
    ruleSeverity: "none" | "note" | "warning" | "error" | null;
    securitySeverity: "critical" | "high" | "medium" | "low" | null;
    /** True when the rule carries the `security` tag; untagged rules without a security severity are quality alerts. */
    securityTagged: boolean;
    path: string | null;
    line: number | null;
    cwes: string[];
  };
}

export interface SecretAlert extends AlertBase {
  source: "secret_scanning";
  /** Named so that no stored field is ever called `secret`; the value itself is never read. */
  exposure: {
    type: string;
    validity: "active" | "inactive" | "unknown";
    publiclyLeaked: boolean;
    pushProtectionBypassed: boolean;
  };
}

export type SecurityAlert = DependencyAlert | CodeAlert | SecretAlert;

/** Whether a source was read, and why not when it was not. */
export type SourceStatus = "ok" | "off" | "no_access" | "error" | "not_read";

export type SourceReason =
  // off
  | "disabled"
  | "not_set_up"
  | "needs_advanced_security"
  // no_access
  | "forbidden"
  | "admin_only_or_off"
  // osv not used
  | "lookup_off"
  | "dependabot_ok"
  | "no_inventory";

export interface SourceState {
  status: SourceStatus;
  reason: SourceReason | null;
  /** When the last successful read finished. */
  readAt: string | null;
  attemptedAt: string | null;
  /** True when the host held more alerts than were read. */
  truncated: boolean;
  /**
   * The failure's own message for the last failed attempt, or a neutral one when it was unexpected. It never carries the
   * token or a query string. The alerts from the previous read are kept.
   */
  error: string | null;
}

// --- Locked dependencies and OSV ------------------------------------------------------------------------------------

export type LockedEcosystem = "npm" | "PyPI" | "crates.io" | "RubyGems";

/** A package a lockfile proves came from the public registry; nothing else is ever sent to OSV (ADR 0034). */
export interface LockedPackage {
  ecosystem: LockedEcosystem;
  name: string;
  version: string;
  lockfile: string;
}

export interface LockfileSummary {
  path: string;
  /** `unreadable` is a lockfile over its size cap, past the first 20 or past the total budget, or one that failed to read. */
  read: "parsed" | "unreadable" | "malformed" | "not_supported";
  /** Every entry found. */
  packages: number;
  /** Entries proved to come from the public registry. */
  publicPackages: number;
}

/** One OSV record that affects a package at its locked version. */
export interface Vulnerability {
  id: string;
  modified: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  fixedVersions: string[];
  url: string;
}

// --- Supply chain facts from the clone ------------------------------------------------------------------------------

/** Raised when what the clone is read for changes, so every repository's facts are read again (ADR 0032). */
export const SUPPLY_CHAIN_VERSION = 1;

export interface ActionUse {
  file: string;
  line: number;
  /** `owner/repo[/path]`, `./local/path` or `docker://image`. */
  action: string;
  ref: string | null;
  pinned: boolean;
  /** `github` for actions owned by `actions` or `github`; `other` is split into own organisation and third party at report time. */
  kind: "github" | "local" | "docker" | "other";
}

export type WorkflowRisk =
  | "prHeadCheckout"
  | "scriptInjection"
  | "writeAll"
  | "noPermissions"
  | "unsecureCommands"
  | "curlPipeShell"
  | "secretsInherit"
  | "persistCredentials"
  | "selfHosted";

export interface WorkflowFinding {
  file: string;
  line: number | null;
  risk: WorkflowRisk;
  /** The expression, key or command fragment, at most 200 characters, never a whole run script. */
  evidence: string;
  /** Set on `selfHosted` findings only: true when the workflow also runs on `pull_request` or `pull_request_target`. */
  onPullRequest?: boolean;
}

export type SecurityToolCategory =
  "sast" | "dependency_review" | "secret_scan" | "container_scan" | "iac_scan" | "scorecard" | "audit";

export interface SecurityTool {
  tool: string;
  category: SecurityToolCategory;
  file: string;
}

export interface DockerfileFacts {
  path: string;
  images: number;
  unpinnedImages: number;
  latestImages: number;
  runsAsRoot: boolean;
  addsRemote: boolean;
  curlPipeShell: boolean;
}

export interface KeyFile {
  path: string;
  /** `strong` names almost always hold a key or secret; `weak` ones (`*.pem`, `*.key`) are often public certificates. */
  strength: "strong" | "weak";
}

export interface SupplyChainFacts {
  version: number;
  workflowsRead: number;
  /** Workflow files and composite actions that were listed but not read, at most 500, without duplicates. */
  workflowsUnread: string[];
  /** Dockerfiles that were listed but not read (over the size cap or past the count cap), at most 200 paths. */
  dockerfilesUnread: string[];
  /** How many Dockerfiles were not read in all, which is more than `dockerfilesUnread` holds when that was cut. */
  dockerfilesUnreadTotal: number;
  actions: ActionUse[];
  findings: WorkflowFinding[];
  securityTools: SecurityTool[];
  updateConfig: string | null;
  securityPolicy: string | null;
  codeowners: string | null;
  manifestsByEcosystem: Record<string, number>;
  missingLockfiles: string[];
  lockfiles: LockfileSummary[];
  keyFiles: KeyFile[];
  dockerfiles: DockerfileFacts[];
  /** Dependabot `package-ecosystem` names the repository needs, for a ready `.github/dependabot.yml`. */
  ecosystems: string[];
}

export interface SupplyChainRecord {
  commitSha: string;
  readAt: string;
  facts: SupplyChainFacts;
}

// --- Repository posture ---------------------------------------------------------------------------------------------

/** Each rule is null when it could not be seen, true when a ruleset or classic protection enforces it. */
export interface BranchRules {
  requirePullRequest: boolean | null;
  requiredApprovals: number | null;
  dismissStaleReviews: boolean | null;
  requireCodeOwnerReview: boolean | null;
  requireStatusChecks: boolean | null;
  blockForcePushes: boolean | null;
  blockDeletion: boolean | null;
  requireSignedCommits: boolean | null;
  requireLinearHistory: boolean | null;
}

export interface RepoPosture {
  visibility: "public" | "private" | "internal" | null;
  isAdmin: boolean | null;
  branch: {
    name: string;
    protected: boolean | null;
    rules: BranchRules;
    /** `full` when classic protection was readable, `rulesets_only` when only rulesets were, `none` when neither. */
    detail: "full" | "rulesets_only" | "none";
  };
  /** Each is null when not visible; most need a repository administrator. */
  settings: {
    dependabotSecurityUpdates: boolean | null;
    secretScanning: boolean | null;
    pushProtection: boolean | null;
    validityChecks: boolean | null;
    privateVulnerabilityReporting: boolean | null;
  };
  /** The repository's own security advisories by state, or null when not visible. */
  advisories: { draft: number; triage: number; published: number; closed: number } | null;
}

// --- OpenSSF Scorecard ----------------------------------------------------------------------------------------------

export interface ScorecardResult {
  score: number;
  date: string;
  checks: { name: string; score: number; reason: string }[];
}

export type ScorecardStatus = "ok" | "off" | "not_public" | "not_scanned" | "error";

// --- Review and change control --------------------------------------------------------------------------------------

export const REVIEW_WINDOW_DAYS = 90;
export const REVIEW_MIN_MERGED = 10;

/**
 * Merged pull requests of the window and how many had an approval. An approval counts when it was given by another
 * person at or before the merge. The crawl stores no commit times for reviews, so an approval given before later,
 * unreviewed commits were pushed still counts.
 */
export interface ReviewControls {
  from: string;
  to: string;
  merged: number;
  authors: number;
  unapproved: number;
  selfMergedUnapproved: number;
  /** `unapproved / merged`, or null when nothing was merged. */
  share: number | null;
  graded: boolean;
  notGradedBecause: "too_few" | "single_author" | null;
  /** Merged without approval, newest first, at most 50. Never a login. */
  pullRequests: { number: number; title: string; url: string; mergedAt: string; selfMerged: boolean }[];
}

// --- The grade ------------------------------------------------------------------------------------------------------

/** Days an open alert of each severity may stay open before it is past its fix-by date. Unknown uses medium's. */
export const FIX_WITHIN_DAYS = { critical: 7, high: 30, medium: 90, low: 180 } as const;

/** Stable names for each part's checks, in the order a tie is named. `all` means nothing held the part back. */
export const SECURITY_CHECKS = {
  vulnerabilities: [
    "secretExposed",
    "criticalPastFix",
    "criticalOpen",
    "highPastFix",
    "dependenciesUnwatched",
    "highOpen",
    "mediumPastFix",
    "all",
  ],
  supplyChain: [
    "prHeadCheckout",
    "scriptInjection",
    "selfHostedPublic",
    "unpinnedActions",
    "workflowPermissions",
    "unsecureCommands",
    "keyFiles",
    "all",
  ],
  changeControl: ["unapprovedMerges", "branchUnprotected", "forcePushAllowed", "all"],
} as const;

/** The order parts are named in when they tie. */
export const SECURITY_PARTS = ["vulnerabilities", "supplyChain", "changeControl"] as const;
export type SecurityPartName = (typeof SECURITY_PARTS)[number];
export type SecurityCheckName = Exclude<(typeof SECURITY_CHECKS)[SecurityPartName][number], "all">;

/** What could not be measured, so an elite band reads as "nothing found in what was measured". */
export type SecurityMeasure = "dependencies" | "code" | "secrets" | "supplyChain" | "changeControl";

/** The same shape as code health's `GradeCheck`, so the web renders both alike. */
export interface SecurityCheck {
  part: SecurityPartName;
  check: SecurityCheckName;
  value: number | boolean | null;
  /** The highest band this check alone allows; absent when the check could not be measured. */
  band?: Band;
  met?: boolean;
  count?: number;
  total?: number;
  oldestDays?: number;
  detail?: string[];
  /** True for the one check that set its part's band. */
  limits: boolean;
}

export interface SecurityGrade {
  overall: GradePart<SecurityCheckName | "all"> & { part: SecurityPartName };
  parts: Record<SecurityPartName, GradePart<SecurityCheckName | "all"> | null>;
  unmeasured: SecurityMeasure[];
}

// --- What to fix ----------------------------------------------------------------------------------------------------

/** In tie order. Kinds after `pin_own_actions` are advice and never move the grade. */
export const SECURITY_ACTION_KINDS = [
  "rotate_secret",
  "upgrade_dependency",
  "replace_dependency",
  "fix_code_alert",
  "fix_pr_head_checkout",
  "fix_script_injection",
  "stop_self_hosted_public",
  "pin_actions",
  "restrict_permissions",
  "remove_unsecure_commands",
  "remove_key_files",
  "require_review",
  "protect_branch",
  "block_force_push",
  "enable_dependabot",
  // advice only
  "pin_own_actions",
  "add_update_config",
  "add_lockfile",
  "add_security_policy",
  "add_codeowners",
  "review_weak_key_files",
  "enable_code_scanning",
  "check_secret_scanning",
  "grant_alert_access",
  "turn_on_code_analysis",
  "fix_low_alerts",
  "require_approvals",
  "require_status_checks",
  "dismiss_stale_reviews",
  "require_code_owner_review",
  "require_signed_commits",
  "enable_security_updates",
  "enable_push_protection",
  "enable_private_reporting",
  "triage_advisories",
  "add_dependency_review",
  "add_secret_scanner_ci",
  "add_static_analysis",
  "avoid_curl_pipe_shell",
  "avoid_secrets_inherit",
  "disable_persist_credentials",
  "pin_base_images",
  "avoid_latest_images",
  "run_as_non_root",
  "avoid_remote_add",
  "merge_dependency_updates",
] as const;
export type SecurityActionKind = (typeof SECURITY_ACTION_KINDS)[number];

export interface SecurityAction {
  kind: SecurityActionKind;
  /** The band of the check this action clears, or null for advice that never moves the grade. */
  band: Band | null;
  /** True when this action's band is the overall band, so the grade cannot rise until it is done. */
  onPath: boolean;
  severity: Severity | null;
  count: number;
  /** What to act on: a package such as "npm:lodash", a rule id, a workflow path, a secret type or a source name. */
  target: string | null;
  upgradeTo: string | null;
  ecosystem: string | null;
  manifestPath: string | null;
  /** How the package comes in, from its dependency group; null for an action that is not about a dependency. */
  relationship: "direct" | "transitive" | "mixed" | null;
  likelyExploited: boolean;
  /** At most 10, never a person: alert links, "path:line" labels with a null url, action references. */
  refs: { label: string; url: string | null }[];
}

// --- The report -----------------------------------------------------------------------------------------------------

export type SupplyChainCheckId =
  | "prHeadCheckout"
  | "scriptInjection"
  | "selfHostedPublic"
  | "unpinnedActions"
  | "ownActionsUnpinned"
  | "workflowPermissions"
  | "unsecureCommands"
  | "keyFiles"
  | "weakKeyFiles"
  | "curlPipeShell"
  | "secretsInherit"
  | "persistCredentials"
  | "updateConfig"
  | "lockfiles"
  | "securityPolicy"
  | "codeowners"
  | "dependencyReview"
  | "secretScanInCi"
  | "staticAnalysis"
  | "baseImagesPinned"
  | "latestImages"
  | "nonRootImages"
  | "remoteAdd";

export interface SupplyChainLine {
  check: SupplyChainCheckId;
  met: boolean;
  /** True when the check counts towards the grade; false for advice. */
  graded: boolean;
  /** Up to 50: a path, its line, and a short structured detail such as an action reference or an expression. */
  items: { path: string; line: number | null; detail: string | null }[];
  total: number;
}

export type AlertWhere =
  | { kind: "package"; ecosystem: string; name: string; version: string | null; manifestPath: string }
  | { kind: "code"; path: string | null; line: number | null; ruleId: string }
  | { kind: "secret"; type: string };

export interface SecurityAlertRef {
  source: AlertSource;
  key: string;
  severity: Severity;
  title: string;
  url: string | null;
  createdAt: string;
  ageHours: number;
  pastFix: boolean;
  likelyExploited: boolean;
  epss: number | null;
  cvssScore: number | null;
  cwes: string[];
  where: AlertWhere;
}

/** Open alerts for one package in one manifest; the same package in another manifest is another group. */
export interface DependencyGroup {
  ecosystem: string;
  name: string;
  manifestPath: string;
  /** From the alerts' `dependency.relationship`: `mixed` when some are direct and some transitive, null when none say. */
  relationship: "direct" | "transitive" | "mixed" | null;
  /** The distinct versions the alerts name as locked, lowest first. */
  lockedVersions: string[];
  alerts: number;
  worstSeverity: Severity;
  /** The highest patched version when every one compares, else null with each listed in `patchedVersions`. */
  upgradeTo: string | null;
  patchedVersions: string[];
  pastFix: number;
  likelyExploited: boolean;
}

export interface DependencyUpdates {
  openedInRange: number;
  mergedInRange: number;
  closedUnmergedInRange: number;
  openNow: number;
  /** Hours from creation to merge, over update pull requests merged in the range. */
  timeToMerge: Summary;
  oldestOpenDays: number | null;
}

export interface SecurityIssues {
  open: number;
  oldestOpenDays: number | null;
  closedInRange: number;
  /** Hours from creation to close, over security issues closed as completed in the range. */
  timeToClose: Summary;
}

export type SecurityGradeMissing = "not_crawled" | "nothing_measured";

export interface SecurityThresholds {
  /** The days of merges the change control check reads. */
  reviewWindowDays: number;
  reviewMinMerged: number;
  /** An open update pull request older than this many days is advice to merge or close it. */
  staleUpdateDays: number;
  /** The exploit prediction share, from 0 to 1, at or above which an alert is likely to be exploited. */
  likelyExploitedEpss: number;
  /** The share of merges without approval up to which change control is elite, and up to which it is high. */
  unapprovedLimits: { elite: number; high: number };
  /** A low alert becomes advice once it is older than this many days. */
  lowAlertAdviceDays: number;
}

export interface SecurityReport {
  repo: Pick<Repo, "id" | "owner" | "name" | "lastCrawledAt">;
  range: { from: string; to: string };
  gradedAt: string;
  /** Kept beside `thresholds`: the same constants, for readers of the older fields. */
  fixWithinDays: typeof FIX_WITHIN_DAYS;
  reviewMinMerged: number;
  likelyExploitedEpss: number;
  /** The limits the grade and the advice use, so copy never repeats a number. */
  thresholds: SecurityThresholds;
  /** The host's page for the repository's security settings. */
  settingsUrl: string;
  sources: Record<AlertSource, SourceState>;
  supplyChain:
    | {
        status: "ok";
        commitSha: string;
        readAt: string;
        workflowsRead: number;
        workflowsUnread: string[];
        dockerfilesUnread: string[];
        dockerfilesUnreadTotal: number;
        lines: SupplyChainLine[];
      }
    | { status: "none"; reason: "analysis_off" | "not_read" };
  /** Dependabot ecosystems the repository needs, for a ready `.github/dependabot.yml`. Empty without supply chain facts. */
  ecosystems: string[];
  posture: RepoPosture | null;
  postureReadAt: string | null;
  /** The failure's own message, or a neutral one, when the last posture read failed, else null; the earlier posture is kept. */
  postureError: string | null;
  /**
   * The update configuration path (Dependabot or Renovate) when Dependabot alerts are off and such a file exists, so
   * the page can say that version updates run although alerts do not. Null otherwise.
   */
  dependabotVersionUpdates: string | null;
  grade: SecurityGrade | null;
  gradeMissing: SecurityGradeMissing | null;
  checks: SecurityCheck[];
  /** The band reached if every action on the path were done, and how many actions that is (those with `onPath` set). */
  raiseGrade: { to: Band; actions: number } | null;
  open: {
    total: number;
    bySeverity: Record<Severity, number>;
    bySource: Record<AlertSource, number>;
    pastFix: Record<Severity, number>;
  };
  likelyExploitedOpen: number;
  weekly: {
    week: string;
    partial: boolean;
    opened: number;
    fixed: number;
    dismissed: number;
    openAtEnd: Record<Severity, number>;
    pastFixAtEnd: number;
  }[];
  timeToFix: Summary;
  /** Every severity, in `SEVERITIES` order. */
  timeToFixBySeverity: { severity: Severity; summary: Summary }[];
  fixedInRange: number;
  dismissed: { total: number; byReason: { reason: string; count: number }[] };
  pushProtectionBypassedInRange: number;
  /** Top 10 weakness ids by open alerts, then fixed in the range. */
  weaknesses: { cwe: string; open: number; fixedInRange: number }[];
  /** Worst first: severity, past fix-by, likely exploited, then age. At most 100. */
  openAlerts: SecurityAlertRef[];
  openAlertTotal: number;
  dependencyGroups: DependencyGroup[];
  /** The 90 day window ending now, used by the grade. */
  review: ReviewControls;
  /** The requested range, for display only. */
  reviewInRange: ReviewControls;
  dependencyUpdates: DependencyUpdates;
  /** Null when the repository has no stored issues. */
  securityIssues: SecurityIssues | null;
  scorecard: ScorecardResult | null;
  scorecardStatus: ScorecardStatus;
  actions: SecurityAction[];
}

/** One row of the list page, projected from the full report so the two can never disagree. */
export interface SecuritySummary {
  repo: Pick<Repo, "id" | "owner" | "name" | "lastCrawledAt" | "crawlStatus">;
  band: Band | null;
  limitedBy: { part: SecurityPartName; check: SecurityCheckName | "all" } | null;
  gradeMissing: SecurityGradeMissing | null;
  open: Record<Severity, number>;
  pastFix: number;
  likelyExploited: number;
  /** Actions that move the grade: every action with a band. Doing them all reaches elite; `raiseGrade` is the next step. */
  actions: number;
  /** The band reached by the actions on the path, and how many they are; null when elite or ungraded. */
  raiseGrade: { to: Band; actions: number } | null;
  /** True when any alert source has been read, so a row of zeros is a finding and not an absence of data. */
  read: boolean;
  /** As `SecurityReport.dependabotVersionUpdates`. */
  dependabotVersionUpdates: string | null;
  unmeasured: SecurityMeasure[];
  sources: Record<AlertSource, SourceStatus>;
  supplyChain: "ok" | "analysis_off" | "not_read";
  /** The latest successful read across the sources. */
  readAt: string | null;
  /** True when any source failed on its last attempt. */
  failed: boolean;
  scorecard: number | null;
  /** The limits the grade and the advice use, so a row's top action can name the real numbers. */
  thresholds: SecurityThresholds;
  topAction: SecurityAction | null;
}
