import type { CandidateFile } from "../src/codeTooling.js";
import type { SecurityFacts, SupplyChainOutcome } from "../src/securityGrade.js";
import type { SecurityInput } from "../src/securityReport.js";
import type {
  AlertSource,
  BranchRules,
  CodeAlert,
  DependabotAlert,
  HeldPosture,
  LockedPackage,
  NoAccessReason,
  NotUsedReason,
  OffReason,
  OsvAlert,
  RepoPosture,
  SecretAlert,
  SourceError,
  SourceNoAccess,
  SourceNotRead,
  SourceNotUsed,
  SourceOff,
  SourceOk,
  SourceRead,
  SourceState,
  SupplyChainFacts,
  SupplyChainRecord,
  Vulnerability,
} from "../src/securityTypes.js";
import { DAY_MS } from "../src/stats.js";
import { supplyChainFacts, type SupplyChainInput } from "../src/supplyChain.js";

/** Builders for the security tests, shared by every file. Names are public packages or `acme/widgets`. */

/** A Wednesday; every age in a test is counted back from here. */
export const NOW = "2026-10-07T12:00:00Z";

/** The instant this many days (or fractions of a day) before `NOW`. */
export const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

export const ok = (readAt = "2026-10-07T08:00:00Z", overrides: Partial<SourceRead> = {}): SourceOk => ({
  status: "ok",
  readAt,
  attemptedAt: readAt,
  truncated: false,
  skipped: 0,
  ...overrides,
});

export const off = (reason: OffReason = "disabled"): SourceOff => ({
  status: "off",
  reason,
  attemptedAt: "2026-10-07T08:00:00Z",
});

export const noAccess = (reason: NoAccessReason = "forbidden"): SourceNoAccess => ({
  status: "no_access",
  reason,
  attemptedAt: "2026-10-07T08:00:00Z",
});

/** The OSV lookup was not needed this time. */
export const notUsed = (reason: NotUsedReason = "lookup_off"): SourceNotUsed => ({
  status: "not_used",
  reason,
  attemptedAt: "2026-10-07T08:00:00Z",
});

export const notRead = (): SourceNotRead => ({ status: "not_read" });

/** Failed this time; usable only when `readAt` is given, as an earlier read stands. */
export const failed = (readAt: string | null = null): SourceError => ({
  status: "error",
  error: "GitHub did not answer",
  attemptedAt: "2026-10-07T09:00:00Z",
  lastGood: readAt === null ? null : { readAt, truncated: false, skipped: 0 },
});

export const allOk = (): Record<AlertSource, SourceState> => ({
  dependabot: ok(),
  code_scanning: ok(),
  secret_scanning: ok(),
  osv: notUsed("lookup_off"),
});

let counter = 0;
const nextKey = () => String(++counter);

// The alert builders below take overrides that may close an alert, which the type only accepts with its close time,
// so each result is cast; a test that closes an alert gives its `closedAt` too.

export function depAlert(
  overrides: Partial<Omit<DependabotAlert, "dependency">> & { dependency?: Partial<DependabotAlert["dependency"]> } = {},
): DependabotAlert {
  const { dependency, ...rest } = overrides;
  const key = rest.key ?? nextKey();
  return {
    source: "dependabot",
    key,
    state: "open",
    createdAt: daysAgo(1),
    closedAt: null,
    closeReason: null,
    title: `Advisory ${key}`,
    url: `https://github.com/acme/widgets/security/dependabot/${key}`,
    severity: "medium",
    dependency: {
      ecosystem: "npm",
      name: "lodash",
      manifestPath: "package-lock.json",
      scope: "runtime",
      relationship: "direct",
      lockedVersion: "4.17.0",
      patchedVersion: "4.17.21",
      vulnerableRange: "< 4.17.21",
      advisoryId: `GHSA-${key}`,
      cveId: null,
      epss: null,
      cvssScore: null,
      cwes: [],
      ...dependency,
    },
    ...rest,
  } as DependabotAlert;
}

/** An OSV finding for lodash in the root lockfile, as `osvFindings` makes one. */
export function osvAlert(
  overrides: Partial<Omit<OsvAlert, "dependency">> & { dependency?: Partial<OsvAlert["dependency"]> } = {},
): OsvAlert {
  const { dependency, ...rest } = overrides;
  const key = rest.key ?? `GHSA-${nextKey()}|npm|lodash|package-lock.json`;
  return {
    source: "osv",
    key,
    state: "open",
    createdAt: daysAgo(1),
    closedAt: null,
    closeReason: null,
    title: "Command injection in lodash",
    url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
    severity: "medium",
    dependency: {
      ecosystem: "npm",
      name: "lodash",
      manifestPath: "package-lock.json",
      scope: null,
      relationship: null,
      lockedVersion: "4.17.0",
      patchedVersion: "4.17.21",
      vulnerableRange: null,
      advisoryId: "GHSA-35jh-r3h4-6jhm",
      cveId: null,
      epss: null,
      cvssScore: null,
      cwes: [],
      ...dependency,
    },
    ...rest,
  } as OsvAlert;
}

export function codeAlert(overrides: Partial<Omit<CodeAlert, "code">> & { code?: Partial<CodeAlert["code"]> } = {}): CodeAlert {
  const { code, ...rest } = overrides;
  const key = rest.key ?? nextKey();
  return {
    source: "code_scanning",
    key,
    state: "open",
    createdAt: daysAgo(1),
    closedAt: null,
    closeReason: null,
    title: `Rule ${key}`,
    url: `https://github.com/acme/widgets/security/code-scanning/${key}`,
    code: {
      ruleId: "js/sql-injection",
      tool: "CodeQL",
      ruleSeverity: "error",
      securitySeverity: "high",
      securityTagged: true,
      path: "src/db.ts",
      line: 12,
      cwes: [],
      ...code,
    },
    ...rest,
  } as CodeAlert;
}

export function secretAlert(
  overrides: Partial<Omit<SecretAlert, "exposure">> & { exposure?: Partial<SecretAlert["exposure"]> } = {},
): SecretAlert {
  const { exposure, ...rest } = overrides;
  const key = rest.key ?? nextKey();
  return {
    source: "secret_scanning",
    key,
    state: "open",
    createdAt: daysAgo(1),
    closedAt: null,
    closeReason: null,
    title: "GitHub Personal Access Token",
    url: `https://github.com/acme/widgets/security/secret-scanning/${key}`,
    exposure: {
      type: "github_personal_access_token",
      validity: "active",
      publiclyLeaked: false,
      pushProtectionBypassed: false,
      ...exposure,
    },
    ...rest,
  } as SecretAlert;
}

export function emptyFacts(overrides: Partial<SupplyChainFacts> = {}): SupplyChainFacts {
  return {
    version: 1,
    workflowsRead: 1,
    workflowsUnread: [],
    dockerfilesUnread: [],
    dockerfilesUnreadTotal: 0,
    actions: [],
    findings: [],
    findingsDropped: 0,
    actionsDropped: 0,
    securityTools: [],
    updateConfig: ".github/dependabot.yml",
    securityPolicy: "SECURITY.md",
    manifestsByEcosystem: { npm: 1 },
    missingLockfiles: [],
    lockfiles: [],
    keyFiles: [],
    dockerfiles: [],
    ecosystems: ["npm"],
    listingComplete: true,
    ...overrides,
  };
}

/** A supply chain record in which nothing is wrong and every advice item is already done. */
export function record(overrides: Partial<SupplyChainFacts> = {}): SupplyChainRecord {
  return {
    commitSha: "a".repeat(40),
    readAt: "2026-10-07T08:30:00Z",
    facts: emptyFacts({
      securityTools: [
        { tool: "actions/dependency-review-action", category: "dependency_review", file: ".github/workflows/ci.yml" },
        { tool: "gitleaks/gitleaks-action", category: "secret_scan", file: ".github/workflows/ci.yml" },
        { tool: "github/codeql-action/analyze", category: "sast", file: ".github/workflows/ci.yml" },
      ],
      ...overrides,
    }),
  };
}

/** A posture whose branch is protected with every rule on, in a private repository with every setting on. */
export function posture(
  overrides: Partial<Omit<RepoPosture, "branch">> & {
    branch?: Partial<Omit<RepoPosture["branch"], "rules">> & { rules?: Partial<BranchRules> };
  } = {},
): RepoPosture {
  const { branch, ...rest } = overrides;
  return {
    visibility: "private",
    isAdmin: true,
    branch: {
      name: "main",
      protected: true,
      detail: "full",
      ...branch,
      rules: {
        requirePullRequest: true,
        requiredApprovals: 1,
        dismissStaleReviews: true,
        requireCodeOwnerReview: true,
        requireStatusChecks: true,
        blockForcePushes: true,
        blockDeletion: true,
        requireSignedCommits: true,
        requireLinearHistory: true,
        ...branch?.rules,
      },
    },
    settings: {
      dependabotSecurityUpdates: true,
      secretScanning: true,
      pushProtection: true,
      validityChecks: true,
      privateVulnerabilityReporting: true,
    },
    advisories: { draft: 0, triage: 0, published: 0, closed: 0 },
    ...rest,
  };
}

/** A posture as the report's input holds it: the value with the time it was read. */
export const held = (value: RepoPosture = posture(), readAt = "2026-10-07T08:00:00Z"): HeldPosture => ({ value, readAt });

/** A supply chain record and the reason it is missing, given apart and settled together as `SupplyChainOutcome` holds them. */
interface OutcomeOverrides {
  supplyChain?: SupplyChainRecord | null;
  supplyChainMissing?: SupplyChainOutcome["supplyChainMissing"];
}

/** The record, a clean one by default. A test that gives a record and a reason, or neither, is refused, as the type would. */
function outcomeOf({ supplyChain = record(), supplyChainMissing = null }: OutcomeOverrides): SupplyChainOutcome {
  if (supplyChain !== null) {
    if (supplyChainMissing !== null) throw new Error("A supply chain record has no reason to be missing");
    return { supplyChain, supplyChainMissing: null };
  }
  if (supplyChainMissing === null) throw new Error("A missing supply chain record needs its reason");
  return { supplyChain: null, supplyChainMissing };
}

export type FactsOverrides = Partial<Omit<SecurityFacts, "supplyChain" | "supplyChainMissing">> & OutcomeOverrides;

/** Facts for an elite repository: every source read, a clean clone and a protected branch. */
export function facts(overrides: FactsOverrides = {}): SecurityFacts {
  const { supplyChain, supplyChainMissing, ...rest } = overrides;
  return {
    owner: "acme",
    now: NOW,
    crawled: true,
    alerts: [],
    sources: allOk(),
    posture: posture(),
    ...rest,
    ...outcomeOf({ supplyChain, supplyChainMissing }),
  };
}

export type InputOverrides = Partial<Omit<SecurityInput, "supplyChain" | "supplyChainMissing">> & OutcomeOverrides;

/** The same as `facts`, shaped as the report's input. */
export function input(overrides: InputOverrides = {}): SecurityInput {
  const { supplyChain, supplyChainMissing, ...rest } = overrides;
  return {
    repo: { id: 7, owner: "acme", name: "widgets", deployBranch: "main", lastCrawledAt: "2026-10-07T08:00:00Z" },
    alerts: [],
    sources: allOk(),
    pullRequests: [],
    supplyChainFailure: null,
    settingsUrl: "https://github.com/acme/widgets/settings/security_analysis",
    posture: held(),
    postureFailure: null,
    scorecard: { status: "off" },
    issues: null,
    ...rest,
    ...outcomeOf({ supplyChain, supplyChainMissing }),
  };
}

/** The instant this many milliseconds before `NOW`, for the edges of a limit. */
export const msAgo = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

export const file = (path: string, content: string): CandidateFile => ({ path, content });

export const lockedPackage = (overrides: Partial<LockedPackage> = {}): LockedPackage => ({
  ecosystem: "npm",
  name: "lodash",
  version: "4.17.15",
  lockfile: "package-lock.json",
  ...overrides,
});

export const vulnerability = (overrides: Partial<Vulnerability> = {}): Vulnerability => ({
  id: "GHSA-35jh-r3h4-6jhm",
  modified: "2026-01-01T00:00:00Z",
  aliases: ["CVE-2021-23337"],
  summary: "Command injection in lodash",
  severity: "high",
  fixedVersions: ["4.17.21"],
  url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
  ...overrides,
});

export const WORKFLOW_PATH = ".github/workflows/ci.yml";

/** The supply chain facts of a repository holding only the given paths and files; everything else is empty. */
export function chainFacts(input: Partial<SupplyChainInput> = {}): SupplyChainFacts {
  return supplyChainFacts({ paths: [], listingComplete: true, workflows: [], lockfiles: [], unread: [], ...input });
}

/** The facts of one workflow file with the given contents. */
export const workflowFacts = (yaml: string, path = WORKFLOW_PATH): SupplyChainFacts =>
  chainFacts({ paths: [path], workflows: [file(path, yaml)] });

/** A workflow whose only jobs set permissions, so `noPermissions` stays out of the way of other rules. */
export const withPermissions = (on: string, steps: string): string =>
  `${on}\npermissions: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
