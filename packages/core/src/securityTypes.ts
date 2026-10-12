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

/**
 * Every code an alert can be closed with, as the host publishes it, never free text: Dependabot's `fixed`,
 * `auto_dismissed` and dismissal reasons, code scanning's and secret scanning's resolutions, and `not_found` for an OSV
 * finding the crawl no longer found.
 */
export const CLOSE_REASONS = [
  "fixed",
  "auto_dismissed",
  "fix_started",
  "inaccurate",
  "no_bandwidth",
  "not_used",
  "tolerable_risk",
  "false_positive",
  "wont_fix",
  "used_in_tests",
  "revoked",
  "pattern_edited",
  "pattern_deleted",
  "not_found",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

interface AlertBase {
  /** GitHub's alert number as text, or `${osvId}|${ecosystem}|${name}|${lockfile}` for OSV. Unique per source. */
  key: string;
  state: AlertState;
  /** When GitHub raised it, or for OSV the crawl that first found it, or found it again after it had been fixed. */
  createdAt: string;
  /** When it was fixed or dismissed, or for OSV the crawl in which it was no longer found. */
  closedAt: string | null;
  /** Null while open, and for a close the host gave no known reason for. */
  closeReason: CloseReason | null;
  /** The advisory summary, the rule description, or the secret type's display name. */
  title: string;
  /** GitHub's page for the alert, or the OSV advisory page. */
  url: string | null;
}

/** What a dependency alert says about the vulnerable package. */
export interface DependencyFacts {
  /** Null when the host named no package, so the alert is grouped on its own rather than with other unnamed ones. */
  ecosystem: string | null;
  name: string | null;
  /** The manifest or lockfile that names the package, or null when the host named none. */
  manifestPath: string | null;
  scope: "runtime" | "development" | null;
  relationship: "direct" | "transitive" | null;
  lockedVersion: string | null;
  /** The first version that fixes it, or null when there is none yet. */
  patchedVersion: string | null;
  vulnerableRange: string | null;
  /** The GHSA id, else the CVE id, or null when the advisory carries neither. */
  advisoryId: string | null;
  cveId: string | null;
  /** The exploit prediction scoring system figures, as fractions from 0 to 1. */
  epss: { percentage: number; percentile: number } | null;
  /**
   * The CVSS v4 base score when published, else v3, else the advisory's overall `cvss.score`, from 0 to 10. A score of
   * 0 is read as none, since GitHub sends 0 for a vector it has not scored.
   */
  cvssScore: number | null;
  /** Weakness ids such as "CWE-79". */
  cwes: string[];
}

export interface DependabotAlert extends AlertBase {
  source: "dependabot";
  /** As published: GitHub's advisory severity, with moderate read as medium, else unknown. */
  severity: Severity;
  dependency: DependencyFacts;
}

/**
 * What OSV says about a locked package. The lockfile names the package, so it is always known, and OSV publishes no
 * scope, relationship, range, exploit prediction, score or weakness for it.
 */
export interface OsvDependencyFacts extends DependencyFacts {
  ecosystem: LockedEcosystem;
  name: string;
  /** The lockfile the package is locked in. */
  manifestPath: string;
  lockedVersion: string;
  advisoryId: string;
  scope: null;
  relationship: null;
  vulnerableRange: null;
  epss: null;
  cvssScore: null;
}

export interface OsvAlert extends AlertBase {
  source: "osv";
  /** As published: the worst `database_specific.severity` among the advisory's records, else unknown. */
  severity: Severity;
  dependency: OsvDependencyFacts;
}

/** An alert about a vulnerable dependency, from either source; both share `DependencyFacts`. */
export type DependencyAlert = DependabotAlert | OsvAlert;

export interface CodeAlert extends AlertBase {
  source: "code_scanning";
  code: {
    /** Null when the host named no rule, so the alert gets an action of its own rather than one shared with others. */
    ruleId: string | null;
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

/** The alerts one source yields, such as `AlertOf<"osv">` for `OsvAlert`. */
export type AlertOf<S extends AlertSource> = Extract<SecurityAlert, { source: S }>;

/** Whether a source was read, and why not when it was not. */
export const SOURCE_STATUSES = ["ok", "off", "no_access", "not_used", "error", "not_read"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Why the host says a source is switched off. */
export const OFF_REASONS = ["disabled", "not_set_up", "needs_advanced_security"] as const;
export type OffReason = (typeof OFF_REASONS)[number];

/** Why the credential cannot read a source. */
export const NO_ACCESS_REASONS = ["forbidden", "admin_only_or_off"] as const;
export type NoAccessReason = (typeof NO_ACCESS_REASONS)[number];

/**
 * Why the OSV lookup was not used, each a reason for it never to be read rather than a failure: the lookup is switched
 * off, Dependabot's alerts could be used instead, or no lockfile held a package to look up.
 */
export const NOT_USED_REASONS = ["lookup_off", "dependabot_ok", "no_inventory"] as const;
export type NotUsedReason = (typeof NOT_USED_REASONS)[number];

export type SourceReason = OffReason | NoAccessReason | NotUsedReason;

/** A read of a source that finished, whose alerts the report can use. */
export interface SourceRead {
  readAt: string;
  /** True when the host held more alerts than were read. */
  truncated: boolean;
  /** Alerts the host listed that could not be mapped, so they were left out of the read. */
  skipped: number;
}

export interface SourceOk extends SourceRead {
  status: "ok";
  attemptedAt: string;
}

export interface SourceOff {
  status: "off";
  reason: OffReason;
  attemptedAt: string;
}

/**
 * The credential cannot see the list. Alerts a more privileged credential stored are kept but not used, so no read time
 * is carried and a later failure has no earlier read to fall back on.
 */
export interface SourceNoAccess {
  status: "no_access";
  reason: NoAccessReason;
  attemptedAt: string;
}

/** The OSV lookup was not needed or not possible this time; this is never a failure. */
export interface SourceNotUsed {
  status: "not_used";
  reason: NotUsedReason;
  attemptedAt: string;
}

export interface SourceError {
  status: "error";
  /**
   * The failure's own message, or a neutral one when it was unexpected. It never carries the token or a query string.
   * The alerts from the previous read are kept.
   */
  error: string;
  attemptedAt: string;
  /**
   * The last read that succeeded, carried over from an `ok` state or an earlier `error` state, so its alerts can still
   * be used; null when the state before the failure had none, such as `no_access`.
   */
  lastGood: SourceRead | null;
}

export interface SourceNotRead {
  status: "not_read";
}

/** What the last attempt at a source found, with each reason tied to its status. */
export type SourceState = SourceOk | SourceOff | SourceNoAccess | SourceNotUsed | SourceError | SourceNotRead;

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
  /**
   * True when the lockfile held more public packages than `MAX_LOCKED_PACKAGES`, so only the first were kept. The rest
   * are never looked up, so a capped lockfile says nothing about their alerts and cannot close them.
   */
  capped: boolean;
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

/**
 * Raised when what the clone is read for changes, so every repository's facts are read again (ADR 0032). Version 2
 * added `LockfileSummary.capped` and stores script injection evidence with its string literals blanked.
 */
export const SUPPLY_CHAIN_VERSION = 2;

export interface ActionUse {
  file: string;
  line: number;
  /** `owner/repo[/path]`, `./local/path` or `docker://image`. */
  action: string;
  ref: string | null;
  pinned: boolean;
  /**
   * `github` for actions owned by `actions` or `github`; `other` is split into own organisation and third party at
   * report time.
   */
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
  manifestsByEcosystem: Record<string, number>;
  /**
   * Manifests with no lockfile of their ecosystem in their directory or a parent, at most 200. Empty when the listing
   * of the clone stopped short, since the lockfile may sit in a directory that was not listed.
   */
  missingLockfiles: string[];
  lockfiles: LockfileSummary[];
  keyFiles: KeyFile[];
  dockerfiles: DockerfileFacts[];
  /** Dependabot `package-ecosystem` names the repository needs, for a ready `.github/dependabot.yml`. */
  ecosystems: string[];
  /**
   * False when the listing of the clone stopped short, so a lockfile missing from `lockfiles` may still exist and its
   * OSV alerts must not be closed as deleted. A row stored before this field was added has none, which
   * `presentLockfiles` reads as false.
   */
  listingComplete: boolean;
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
    /**
     * `full` when classic protection was read, or when the branch is known to have none and the rulesets were read.
     * `rulesets_only` when the rulesets were read but classic protection could not be. `none` when the rulesets could
     * not be read, so nothing shows whether a ruleset protects the branch, even one known to have no classic protection.
     */
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

/**
 * What the OpenSSF Scorecard lookup holds. `off` is the lookup switched off, `not_public` a repository that is not
 * public, `not_scanned` one the service has no result for, and `not_read` one that has not been asked yet, such as just
 * after the lookup was switched on. A failed lookup keeps the last result that was read, if any.
 */
export type ScorecardState =
  | { status: "ok"; result: ScorecardResult }
  | { status: "error"; message: string; attemptedAt: string; lastGood: ScorecardResult | null }
  | { status: "off" | "not_public" | "not_scanned" | "not_read" };

export type ScorecardStatus = ScorecardState["status"];

// --- Failed reads ---------------------------------------------------------------------------------------------------

/** Why the last attempt at a read failed: its own scrubbed message or a neutral one, never a token or query string. */
export interface ReadFailure {
  message: string;
  attemptedAt: string;
}

/** The posture last read successfully, with when. */
export interface HeldPosture {
  value: RepoPosture;
  readAt: string;
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
  changeControl: ["branchUnprotected", "forcePushAllowed", "all"],
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

/** A grade, or why there is none: exactly one of the two is set. */
export type SecurityGradeOutcome =
  { grade: SecurityGrade; gradeMissing: null } | { grade: null; gradeMissing: SecurityGradeMissing };

// --- What to fix ----------------------------------------------------------------------------------------------------

/**
 * In tie order. Whether an action moves the grade is set by its `band`, not its kind: the kinds from `pin_own_actions`
 * on are always advice, and an earlier kind is advice when its band is null, such as `enable_dependabot` while OSV
 * watches the dependencies, or `upgrade_dependency` for medium alerts that are not yet past their fix-by date.
 */
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
  "protect_branch",
  "block_force_push",
  "enable_dependabot",
  // advice only
  "pin_own_actions",
  "add_update_config",
  "add_lockfile",
  "add_security_policy",
  "review_weak_key_files",
  "enable_code_scanning",
  "check_secret_scanning",
  "grant_alert_access",
  "turn_on_code_analysis",
  "fix_low_alerts",
  "require_status_checks",
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

/** The two kinds that are about one package, and so carry `package`. */
export const DEPENDENCY_ACTION_KINDS = ["upgrade_dependency", "replace_dependency"] as const;
export type DependencyActionKind = (typeof DEPENDENCY_ACTION_KINDS)[number];

/** The package a dependency action is about, from its dependency group. */
export interface ActionPackage {
  /** Null when the host named no package; the action then covers that one alert. */
  ecosystem: string | null;
  name: string | null;
  manifestPath: string | null;
  /** How the package comes in: `mixed` when some alerts say direct and some transitive, null when none say. */
  relationship: "direct" | "transitive" | "mixed" | null;
  /** The version to upgrade to, or null when none is known or the fixes do not compare. */
  upgradeTo: string | null;
}

interface SecurityActionFacts {
  severity: Severity | null;
  count: number;
  /**
   * What to act on: `ecosystem:name` for a dependency, a rule id, a workflow path, a secret type, a branch or a source
   * name. Null when there is no one thing, or when the host did not name the package or rule.
   */
  target: string | null;
  likelyExploited: boolean;
  /** At most 10, never a person: alert links, "path:line" labels with a null url, action references. */
  refs: { label: string; url: string | null }[];
}

/**
 * An action the grade waits for carries the band of the check it clears, and `onPath` when that band is the overall
 * band, so the grade cannot rise until it is done. Advice has no band and is never on the path.
 */
export type ActionWeight = { band: Band; onPath: boolean } | { band: null; onPath: false };

export type SecurityAction = SecurityActionFacts &
  ActionWeight &
  ({ kind: DependencyActionKind; package: ActionPackage } | { kind: Exclude<SecurityActionKind, DependencyActionKind> });

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

/** Where an alert is. A package or rule the host did not name is null. */
export type AlertWhere =
  | { kind: "package"; ecosystem: string | null; name: string | null; version: string | null; manifestPath: string | null }
  | { kind: "code"; path: string | null; line: number | null; ruleId: string | null }
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

/**
 * Open alerts for one package in one manifest; the same package in another manifest is another group. An alert whose
 * host named no ecosystem, package or manifest is a group of its own, with those fields null.
 */
export interface DependencyGroup {
  ecosystem: string | null;
  name: string | null;
  manifestPath: string | null;
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
  /** Days an open alert of each severity may stay open; an unknown severity is held to medium's. */
  fixWithinDays: typeof FIX_WITHIN_DAYS;
  /** An open update pull request older than this many days is advice to merge or close it. */
  staleUpdateDays: number;
  /** The exploit prediction share, from 0 to 1, at or above which an alert is likely to be exploited. */
  likelyExploitedEpss: number;
  /** A low alert becomes advice once it is older than this many days. */
  lowAlertAdviceDays: number;
}

interface SecurityReportFields {
  repo: Pick<Repo, "id" | "owner" | "name" | "lastCrawledAt">;
  range: { from: string; to: string };
  gradedAt: string;
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
  /**
   * Set when the latest inspection of the clone failed. The supply chain facts above, if any, are from an earlier
   * inspection and are kept.
   */
  supplyChainFailure: ReadFailure | null;
  /** Dependabot ecosystems the repository needs, for a ready `.github/dependabot.yml`. Empty without supply chain facts. */
  ecosystems: string[];
  /** The posture last read successfully, or null when none has been. */
  posture: HeldPosture | null;
  /** Set when the latest posture read failed; the posture above, if any, is from an earlier read and is kept. */
  postureFailure: ReadFailure | null;
  /**
   * The update configuration path (Dependabot or Renovate) when Dependabot alerts are off and such a file exists, so
   * the page can say that version updates run although alerts do not. Null otherwise.
   */
  dependabotVersionUpdates: string | null;
  checks: SecurityCheck[];
  /** The band reached if every action on the path were done, and how many actions that is (those with `onPath` set). */
  raiseGrade: { to: Band; actions: number } | null;
  /** Open alerts that count now; `openAlertTotal` is their number. */
  open: {
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
  /** `unspecified` counts dismissals the host gave no known reason for. */
  dismissed: { total: number; byReason: { reason: CloseReason | "unspecified"; count: number }[] };
  pushProtectionBypassedInRange: number;
  /** Top 10 weakness ids by open alerts, then fixed in the range. */
  weaknesses: { cwe: string; open: number; fixedInRange: number }[];
  /** Worst first: severity, past fix-by, likely exploited, then age. At most 100. */
  openAlerts: SecurityAlertRef[];
  /** Every open alert that counts, of which `openAlerts` lists the worst. */
  openAlertTotal: number;
  dependencyGroups: DependencyGroup[];
  dependencyUpdates: DependencyUpdates;
  /** Null when the repository has no stored issues. */
  securityIssues: SecurityIssues | null;
  scorecard: ScorecardState;
  actions: SecurityAction[];
}

/** One repository's security report: its facts, and a grade or why there is none. */
export type SecurityReport = SecurityReportFields & SecurityGradeOutcome;

interface SecuritySummaryFields {
  repo: Pick<Repo, "id" | "owner" | "name" | "lastCrawledAt" | "crawlStatus">;
  open: Record<Severity, number>;
  pastFix: number;
  likelyExploited: number;
  /** Actions that move the grade: every action with a band. Doing them all reaches elite; `raiseGrade` is the next step. */
  actions: number;
  /** The band reached by the actions on the path, and how many they are; null when elite or ungraded. */
  raiseGrade: { to: Band; actions: number } | null;
  /**
   * True when the alerts of any source are in use, so a row of zeros is a finding and not an absence of data. A source
   * that was attempted but cannot be used, such as one without access, does not count.
   */
  read: boolean;
  /** As `SecurityReport.dependabotVersionUpdates`. */
  dependabotVersionUpdates: string | null;
  unmeasured: SecurityMeasure[];
  sources: Record<AlertSource, SourceStatus>;
  /**
   * Whether each source's alerts are in use, as the grade uses them: read now, or failed after an earlier read. OSV is
   * in use only when Dependabot is not.
   */
  used: Record<AlertSource, boolean>;
  supplyChain: "ok" | "analysis_off" | "not_read";
  /** The latest successful read among the sources in use; null when none is. */
  readAt: string | null;
  /** True when any alert source, the posture read or the inspection of the clone failed on its last attempt. */
  failed: boolean;
  /** The Scorecard score, or the last one read when the latest lookup failed. */
  scorecard: number | null;
  /** The limits the grade and the advice use, so a row's top action can name the real numbers. */
  thresholds: SecurityThresholds;
  topAction: SecurityAction | null;
}

/** One row of the list page, projected from the full report so the two can never disagree. */
export type SecuritySummary = SecuritySummaryFields &
  (
    | { band: Band; limitedBy: { part: SecurityPartName; check: SecurityCheckName | "all" }; gradeMissing: null }
    | { band: null; limitedBy: null; gradeMissing: SecurityGradeMissing }
  );
