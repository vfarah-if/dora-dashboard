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
 * Every code an alert can be closed with, never free text. Dependabot's `fixed`, `auto_dismissed` and dismissal reasons
 * and secret scanning's resolutions are kept as published, code scanning's dismissal reasons are mapped to the same
 * snake case, and `not_found` marks an OSV finding the crawl no longer found.
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

/**
 * An alert's state with the facts of its close, held together so that a fixed or dismissed alert always says when it
 * closed. Without that time the weekly replay would count it as open for ever while the open tiles left it out.
 */
export type AlertLifecycle =
  | { state: "open"; closedAt: null; closeReason: null }
  | {
      state: Exclude<AlertState, "open">;
      /** When it was fixed or dismissed, or for OSV the crawl in which it was no longer found. */
      closedAt: string;
      /** Null for a close the host gave no known reason for. */
      closeReason: CloseReason | null;
    };

interface AlertBase {
  /** GitHub's alert number as text, or `${osvId}|${ecosystem}|${name}|${lockfile}` for OSV. Unique per source. */
  key: string;
  /** When GitHub raised it, or for OSV the crawl that first found it, or found it again after it had been fixed. */
  createdAt: string;
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
  /**
   * For Dependabot, the GHSA id, else the CVE id, or null when the advisory carries neither. For OSV, the lowest GHSA id
   * of the alias group, else the group's lowest id of any kind, and never null.
   */
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

interface DependabotFields extends AlertBase {
  source: "dependabot";
  /** As published: GitHub's advisory severity, with moderate read as medium, else unknown. */
  severity: Severity;
  dependency: DependencyFacts;
}

export type DependabotAlert = DependabotFields & AlertLifecycle;

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

interface OsvFields extends AlertBase {
  source: "osv";
  /**
   * As published, the worst `database_specific.severity` among the advisory's records that publish one, else unknown. An
   * alias record that publishes none, such as a PYSEC or RUSTSEC twin, does not raise the severity the others agree on.
   */
  severity: Severity;
  dependency: OsvDependencyFacts;
}

export type OsvAlert = OsvFields & AlertLifecycle;

/** An alert about a vulnerable dependency, from either source; both share `DependencyFacts`. */
export type DependencyAlert = DependabotAlert | OsvAlert;

interface CodeFields extends AlertBase {
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

export type CodeAlert = CodeFields & AlertLifecycle;

interface SecretFields extends AlertBase {
  source: "secret_scanning";
  /** Named so that no stored field is ever called `secret`; the value itself is never read. */
  exposure: {
    type: string;
    validity: "active" | "inactive" | "unknown";
    publiclyLeaked: boolean;
    pushProtectionBypassed: boolean;
  };
}

export type SecretAlert = SecretFields & AlertLifecycle;

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
 * off, Dependabot's alerts could be used instead, no lockfile held a package to look up, or every lockfile was read in
 * full from a complete listing and every public package it named was withheld by a private scope.
 */
export const NOT_USED_REASONS = ["lookup_off", "dependabot_ok", "no_inventory", "all_withheld"] as const;
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

/** Raised when what the clone is read for changes, so every repository's facts are read again (ADR 0032). */
export const SUPPLY_CHAIN_VERSION = 5;

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

/** One call from a workflow or composite action to another by local path: the calling file and its job, null in a composite action. */
export interface WorkflowHop {
  file: string;
  job: string | null;
}

/**
 * One way an event reaches a flagged line: the trigger of the file at the start of the chain (null when its triggers
 * could not be read), and the calls from there to the flagged file. `via` is empty when the file's own trigger starts it,
 * and null for the stand-in that covers routes past the caps (ADR 0039).
 */
export interface WorkflowRoute {
  trigger: string | null;
  via: WorkflowHop[] | null;
}

/** An `if:` that stands between an outsider's event and a flagged line, and did not rule it out. */
export interface WorkflowCondition {
  file: string;
  line: number;
  /** The `if:` with its literals blanked, an unclosed or escaped quote and a `#` comment cut, whitespace collapsed, at most 200 characters. */
  text: string;
  /** holds: true for an outsider's event. unknown: names something not knowable. unreadable: could not be parsed. */
  verdict: "holds" | "unknown" | "unreadable";
}

export interface WorkflowFinding {
  file: string;
  line: number | null;
  risk: WorkflowRisk;
  /** The expression, key or command fragment, at most 200 characters, never a whole run script. */
  evidence: string;
  /**
   * Set on `selfHosted` findings only. True when a pull request from a fork can reach the job: the workflow runs on
   * `pull_request`, `pull_request_target`, `pull_request_review` or `pull_request_review_comment` and no condition rules
   * it out, or its triggers could not be read, which `triggersOf` treats as possibly privileged. A reusable workflow
   * called by such a workflow in the same repository takes it from its caller, through the calling jobs whose conditions
   * leave a pull request open.
   */
  onPullRequest?: boolean;
  /**
   * How an event reaches the line, at most three, the stand-in for routes past the caps first, for display. Set on
   * `prHeadCheckout`, `scriptInjection` and `persistCredentials`, and on `selfHosted` when `onPullRequest` is true.
   */
  routes?: WorkflowRoute[];
  /** How many more routes reached the line than are listed. Present only when above zero. */
  routesDropped?: number;
  /** The conditions on the way that did not rule the event out, nearest first, at most three. Present with `routes`. */
  conditions?: WorkflowCondition[];
  /** How many more such conditions there were. Present only when above zero. */
  conditionsDropped?: number;
  /**
   * A hash of the whole flagged line, quoted text included, with whitespace collapsed, so an edit above the line does not
   * change it and an edit to the line, a literal in it too, does. For a finding with no line it hashes the sorted ids of
   * the jobs concerned. 16 lower-case hex characters, never the text.
   */
  lineHash: string;
  /**
   * A hash of how an event reaches the line: every route that reaches it, as its trigger and its calls, and every
   * condition consulted on the way, as the hash of its text as written and its verdict, all before the caps of three on
   * what is shown and with no line numbers. A caller added or taken away, a guard changed or deleted, or a changed
   * verdict changes it, and an edit above the line does not. A finding that reads no route, such as `curlPipeShell`,
   * has the fixed hash of no reach. 16 lower-case hex characters, never the text.
   */
  reachHash: string;
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
  /**
   * The git blob id of the file at the commit, read from the commit's tree without opening the file (ADR 0032), or null
   * when it was not read. It tells an acceptance whether the Dockerfile has changed since.
   */
  blob: string | null;
  images: number;
  unpinnedImages: number;
  latestImages: number;
  runsAsRoot: boolean;
  addsRemote: boolean;
  curlPipeShell: boolean;
}

export interface KeyFile {
  path: string;
  /** The git blob id at the commit, read from the tree and never from the file; null when it was not read. */
  blob: string | null;
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
  /**
   * At most 10,000 of each `kind`, pinned and unpinned uses counted apart, so pinned uses and actions owned by GitHub
   * cannot crowd out an unpinned use of another owner's action. The split between the repository's own organisation
   * and third parties is made at report time, so those two still share a cap.
   */
  actions: ActionUse[];
  /** At most 2,000 of each risk, so advice can never crowd out a finding that is graded. */
  findings: WorkflowFinding[];
  /** Findings left out by the caps above, so a line can say that it is incomplete. */
  findingsDropped: number;
  /** Action uses left out by the caps above. */
  actionsDropped: number;
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
   * OSV alerts must not be closed as deleted.
   */
  listingComplete: boolean;
  /**
   * False when the blob ids of the key files and Dockerfiles could not be looked up, which leaves every one of them with a
   * null blob that no acceptance can match. True when the lookup worked or nothing needed one, so a listed path that the
   * commit's tree does not hold as a regular file, which has no blob of its own, is not a failure. A record where it is
   * false is read again at the same commit. `supplyChainFacts` sets it from whether its input's `blobs` is null.
   */
  blobsRead: boolean;
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
     * `full` when classic protection was read, or when the branch is known to have none and every ruleset was read.
     * `rulesets_only` when rulesets were read but classic protection could not be, or when the branch has none and a
     * ruleset list cut short still shows a rule in force. `none` when the rulesets could not be read, or were cut short
     * with nothing seen in force, so nothing shows whether a ruleset protects the branch.
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

/**
 * The supply chain checks that count towards the grade, in the order a tie is named. It is written down here only:
 * `SECURITY_CHECKS.supplyChain`, `GRADED_SUPPLY_CHAIN_CHECKS` and the `graded` flag of every report line are built from it,
 * so a check cannot be graded in one place and advice in another.
 */
const GRADED_SUPPLY_CHAIN = [
  "prHeadCheckout",
  "scriptInjection",
  "selfHostedPublic",
  "unpinnedActions",
  "workflowPermissions",
  "unsecureCommands",
  "keyFiles",
] as const satisfies readonly SupplyChainCheckId[];

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
  supplyChain: [...GRADED_SUPPLY_CHAIN, "all"],
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
  /** How many findings of this check an acceptance covers; present only when above zero. They are not in `count`. */
  accepted?: number;
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

export const SUPPLY_CHAIN_CHECK_IDS = [
  "prHeadCheckout",
  "scriptInjection",
  "selfHostedPublic",
  "unpinnedActions",
  "ownActionsUnpinned",
  "workflowPermissions",
  "unsecureCommands",
  "keyFiles",
  "weakKeyFiles",
  "curlPipeShell",
  "secretsInherit",
  "persistCredentials",
  "updateConfig",
  "lockfiles",
  "securityPolicy",
  "dependencyReview",
  "secretScanInCi",
  "staticAnalysis",
  "baseImagesPinned",
  "latestImages",
  "nonRootImages",
  "remoteAdd",
] as const;
export type SupplyChainCheckId = (typeof SUPPLY_CHAIN_CHECK_IDS)[number];

/** The checks that count towards the grade, the same list as `SECURITY_CHECKS.supplyChain`; every other check is advice. */
export const GRADED_SUPPLY_CHAIN_CHECKS: readonly SupplyChainCheckId[] = GRADED_SUPPLY_CHAIN;

/** One place a supply chain line points at. */
export interface SupplyChainItem {
  path: string;
  line: number | null;
  /** An action reference, an expression, an image count or a tool name; null when the path says it all. */
  detail: string | null;
  /** The file at the commit the clone was read from, on the host; null when the host builds none. */
  url: string | null;
  /** The finding's risk for a workflow finding; null for everything else, such as an action use or a key file. */
  risk: WorkflowRisk | null;
  /**
   * What an acceptance of this finding is matched on (ADR 0040), or null when it cannot be accepted, such as a key file
   * whose blob id was not read.
   */
  fingerprint: string | null;
  /** How an event reaches the line, copied from the workflow finding; empty for anything else. */
  routes: WorkflowRoute[];
  routesDropped: number;
  /** The conditions on the way that did not rule the event out, copied from the finding; empty for anything else. */
  conditions: WorkflowCondition[];
  conditionsDropped: number;
}

export interface SupplyChainLine {
  check: SupplyChainCheckId;
  /** For a line about something that should not be there, true when no open item is left; for one about something that should be there, true when it is. */
  met: boolean;
  /** True when the check counts towards the grade; false for advice. */
  graded: boolean;
  /** Up to 50 open items, each a path, its line and a short structured detail such as an action reference or an expression. */
  items: SupplyChainItem[];
  /** The open items, of which `items` lists the first 50. */
  total: number;
  /** Items an acceptance covers now. They are in neither `items` nor `total`. */
  accepted: number;
  /**
   * Set on a line about something that should be there when it is missing and not accepted: what an acceptance of its
   * absence is matched on. Null when it is there, or when its absence is accepted, which `accepted` then says.
   */
  absence: { fingerprint: string } | null;
}

// --- Accepting a finding (ADR 0040) ----------------------------------------------------------------------------------

export const ACCEPTANCE_REASONS = ["false_positive", "guarded_elsewhere", "public_by_design", "risk_accepted"] as const;
export type AcceptanceReason = (typeof ACCEPTANCE_REASONS)[number];

/** The longest note, and the most acceptances one repository may hold. */
export const ACCEPTANCE_LIMITS = { note: 280, perRepository: 500 } as const;

/**
 * The versioned prefixes a fingerprint is made with, so a change to how one kind is made reopens every acceptance of that
 * kind instead of matching nothing quietly: `w2` a workflow finding, `a1` an action use, `b` a git blob id, `p1` a missing
 * lockfile and `n1` the absence of a file or tool.
 */
export const FINGERPRINT_KINDS = ["w2", "a1", "b", "p1", "n1"] as const;
export type FingerprintKind = (typeof FINGERPRINT_KINDS)[number];

/**
 * Prefixes no fingerprint is made with any more. A stored acceptance carrying one still loads, and reads as reopened while
 * its check still finds something in its file, rather than vanishing as unreadable, but nothing new is accepted under it.
 * `w1` hashed only the routes kept for display and no condition.
 */
export const RETIRED_FINGERPRINT_KINDS = ["w1"] as const;
type RetiredFingerprintKind = (typeof RETIRED_FINGERPRINT_KINDS)[number];

/** What follows each prefix: 16 hex digits of a hash, a git blob id of either length, or nothing. */
const FINGERPRINT_BODY: Record<FingerprintKind | RetiredFingerprintKind, string> = {
  w2: "[0-9a-f]{16}",
  a1: "[0-9a-f]{16}",
  b: "(?:[0-9a-f]{40}|[0-9a-f]{64})",
  p1: "",
  n1: "",
  w1: "[0-9a-f]{16}",
};

const fingerprintPattern = (kinds: readonly (FingerprintKind | RetiredFingerprintKind)[]): RegExp =>
  new RegExp(`^(?:${kinds.map((kind) => `${kind}:${FINGERPRINT_BODY[kind]}`).join("|")})$`);

/** A fingerprint a stored acceptance may carry: a current kind, or a retired one so that its row still loads. */
export const ACCEPTANCE_FINGERPRINT = fingerprintPattern([...FINGERPRINT_KINDS, ...RETIRED_FINGERPRINT_KINDS]);

/** A fingerprint something may be accepted under now: a current kind only. */
export const CURRENT_FINGERPRINT = fingerprintPattern(FINGERPRINT_KINDS);

/**
 * A finding a person has accepted. It holds what was accepted, why, a note of at most 280 characters written in the
 * dashboard, and when. It never holds who: no login or session value is stored (ADR 0008, ADR 0031).
 */
export interface FindingAcceptance {
  id: number;
  check: SupplyChainCheckId;
  /** The file the finding is in; null only for the absence of a file or tool. */
  path: string | null;
  /** Where the finding was when accepted, taken from the finding by the server; null when it has no line. */
  line: number | null;
  fingerprint: string;
  reason: AcceptanceReason;
  note: string;
  /** ISO. */
  acceptedAt: string;
}

/** What a person sends to accept a finding; the server adds the id, the line and the time. */
export type AcceptanceRequest = Pick<FindingAcceptance, "check" | "path" | "fingerprint" | "reason" | "note">;

/**
 * Whether an acceptance still holds. `applies` matched a finding of the latest read. `reopened` did not, though an open
 * finding of the same check is in the same file, so what was accepted has changed. `gone` matched nothing because no open
 * finding of that check is left in that file, such as an absence that has since been filled. `unchecked` means the latest
 * read could not check it: there is no supply chain record, the git blob id of its key file or Dockerfile was not read,
 * or it accepts a self-hosted runner or the absence of a security policy while the repository is not known to be public.
 */
export type AcceptanceStatus = "applies" | "reopened" | "gone" | "unchecked";

export interface AcceptanceView {
  acceptance: FindingAcceptance;
  status: AcceptanceStatus;
  /** True when the check counts towards the grade. */
  graded: boolean;
  /** How many places it covers now; identical lines with the same route share one acceptance. 0 unless it applies. */
  covers: number;
  /** Up to 50 of those places, empty unless it applies and for an absence, which has no place. */
  items: SupplyChainItem[];
}

/** Where an alert is. A package or rule the host did not name is null. */
export type AlertWhere =
  | { kind: "package"; ecosystem: string | null; name: string | null; version: string | null; manifestPath: string | null }
  | { kind: "code"; path: string | null; line: number | null; ruleId: string | null; tool: string }
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
  /** When the alert is due, its creation plus the days its severity allows (ISO). */
  fixByAt: string;
  /** Whole days until `fixByAt`, 0 on the last day; -1 or lower exactly when `pastFix` is true. */
  daysLeft: number;
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
  /** `deployBranch` is the branch the dashboard is set up for, which a ready workflow's push trigger names. */
  repo: Pick<Repo, "id" | "owner" | "name" | "deployBranch" | "lastCrawledAt">;
  range: { from: string; to: string };
  gradedAt: string;
  /** The limits the grade and the advice use, so copy never repeats a number. */
  thresholds: SecurityThresholds;
  /** The host's page for the repository's security settings. */
  settingsUrl: string;
  sources: Record<AlertSource, SourceState>;
  /**
   * Whether each source's alerts are in use as the grade uses them, because the source was read now or failed after an
   * earlier read. OSV is in use only when Dependabot is not. `SecuritySummary.used` is the same record.
   */
  used: Record<AlertSource, boolean>;
  /**
   * When each source last read successfully, from this attempt when it succeeded or from the last good read an `error`
   * state carries. Null for every other state, including `no_access`, whose stored alerts are kept but not used.
   */
  lastGoodAt: Record<AlertSource, string | null>;
  supplyChain:
    | {
        status: "ok";
        commitSha: string;
        readAt: string;
        workflowsRead: number;
        workflowsUnread: string[];
        dockerfilesUnread: string[];
        dockerfilesUnreadTotal: number;
        /** Workflow findings and action uses the caps left out, so the lines may count fewer than there are. */
        findingsDropped: number;
        actionsDropped: number;
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
  /** Every acceptance the repository holds, with whether it still holds. */
  acceptances: AcceptanceView[];
  /**
   * Stored acceptance rows the store could not read, which are left out of `acceptances`, so the findings they covered
   * count again. 0 when every row was read.
   */
  acceptancesUnreadable: number;
  /**
   * What acceptances changed: the findings they take out of the graded checks and out of the advice, and the band before
   * them, which is null when nothing matched or there is no grade.
   */
  accepted: { graded: number; advice: number; bandBefore: Band | null; supplyChainBefore: Band | null };
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
  /** Graded findings acceptances take out of the grade, and the band before them (null when nothing matched). */
  accepted: { graded: number; bandBefore: Band | null };
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
