import type { GradePart } from "./codeGrade.js";
import { instant } from "./delivery.js";
import { BAND_RANK, type Band } from "./dora.js";
import { isUsable, severityOf, usedSources } from "./securityAlerts.js";
import {
  AcceptanceIndex,
  fingerprintOf,
  subjectLine,
  subjectPath,
  type AcceptedHit,
  type Subject,
} from "./securityAcceptance.js";
import { DAY_MS, HOUR_MS } from "./stats.js";
import {
  CURRENT_FINGERPRINT,
  FIX_WITHIN_DAYS,
  SECURITY_PARTS,
  type AcceptanceRequest,
  type ActionUse,
  type AlertSource,
  type DockerfileFacts,
  type FindingAcceptance,
  type KeyFile,
  type RepoPosture,
  type SecurityAlert,
  type SecurityCheck,
  type SecurityCheckName,
  type SecurityGrade,
  type SecurityGradeOutcome,
  type SecurityMeasure,
  type SecurityPartName,
  type Severity,
  type SourceState,
  type SupplyChainCheckId,
  type SupplyChainRecord,
  type WorkflowFinding,
} from "./securityTypes.js";

/**
 * Grades a repository's security in four bands from what was found (ADR 0033). Three parts are graded and the lowest
 * sets the grade. Every limit is a convention of this project, not a standard, and is exported through
 * `FIX_WITHIN_DAYS` and `CHECK_BAND` so the tests and the documentation point at the same numbers. A part that could
 * not be measured is left out and named in `unmeasured`, so an elite band reads as "nothing found in what was measured".
 */

/** The highest band each check allows while it finds something. */
export const CHECK_BAND: Record<SecurityCheckName, Band> = {
  secretExposed: "low",
  criticalPastFix: "low",
  criticalOpen: "medium",
  highPastFix: "medium",
  dependenciesUnwatched: "medium",
  highOpen: "high",
  mediumPastFix: "high",
  prHeadCheckout: "low",
  scriptInjection: "low",
  selfHostedPublic: "low",
  unpinnedActions: "high",
  workflowPermissions: "high",
  unsecureCommands: "high",
  keyFiles: "high",
  branchUnprotected: "high",
  forcePushAllowed: "high",
};

/**
 * The supply chain record, or why there is none, which is that code analysis is off or that the clone has not been read
 * yet. Exactly one of the two is set, so every reader takes the same view of a missing record.
 */
export type SupplyChainOutcome =
  | { supplyChain: SupplyChainRecord; supplyChainMissing: null }
  | { supplyChain: null; supplyChainMissing: "analysis_off" | "not_read" };

interface SecurityFactsFields {
  owner: string;
  /** ISO. */
  now: string;
  /** False until the repository has been crawled once. */
  crawled: boolean;
  alerts: readonly SecurityAlert[];
  sources: Record<AlertSource, SourceState>;
  posture: RepoPosture | null;
  /** Findings of the clone a person has accepted (ADR 0040). They leave the grade and the advice. */
  acceptances?: readonly FindingAcceptance[];
}

/** Everything the grade reads, gathered by the caller. Nothing here is a clock or a store. */
export type SecurityFacts = SecurityFactsFields & SupplyChainOutcome;

// ---- alerts ---------------------------------------------------------------------------------------------------

/** An alert that counts, with its severity and age worked out once. */
export interface UsedAlert {
  alert: SecurityAlert;
  severity: Severity;
  ageHours: number;
  /** True when it has been open longer than its severity allows. Exactly at the limit is still within it. */
  pastFix: boolean;
}

/** Days an alert of this severity may stay open; an unrated alert is held to the medium limit. */
export const fixWithinDays = (severity: Severity): number => FIX_WITHIN_DAYS[severity === "unknown" ? "medium" : severity];

/** True when the alert has been open for longer than the days its severity allows. */
export const isPastFix = (severity: Severity, createdAt: string, now: string): boolean =>
  instant(now) - instant(createdAt) > fixWithinDays(severity) * DAY_MS;

/**
 * The alerts a grade and a report use, in every state. Dependency alerts come from Dependabot when it is usable and
 * otherwise from OSV; code scanning and secret scanning are used when usable. A code quality alert has no severity and
 * is left out everywhere.
 */
export function gradedAlerts(alerts: readonly SecurityAlert[], sources: Record<AlertSource, SourceState>): SecurityAlert[] {
  const used = usedSources(sources);
  return alerts.filter((alert) => severityOf(alert) !== null && used[alert.source]);
}

/** The graded alerts that are open now. */
export function usedAlerts(facts: Pick<SecurityFacts, "alerts" | "sources" | "now">): UsedAlert[] {
  return gradedAlerts(facts.alerts, facts.sources)
    .filter((alert) => alert.state === "open")
    .map((alert) => {
      const severity = severityOf(alert)!;
      return {
        alert,
        severity,
        ageHours: Math.max(0, instant(facts.now) - instant(alert.createdAt)) / HOUR_MS,
        pastFix: isPastFix(severity, alert.createdAt, facts.now),
      };
    });
}

const isExposed = (alert: SecurityAlert) =>
  alert.source === "secret_scanning" && (alert.exposure.validity === "active" || alert.exposure.publiclyLeaked);

/** The alert checks an open alert feeds. A low alert feeds none, so it never caps a grade. */
export function checksOfAlert({ alert, severity, pastFix }: UsedAlert): SecurityCheckName[] {
  const names: SecurityCheckName[] = [];
  if (isExposed(alert)) names.push("secretExposed");
  if (severity === "critical") names.push(pastFix ? "criticalPastFix" : "criticalOpen");
  else if (severity === "high") names.push(pastFix ? "highPastFix" : "highOpen");
  else if (pastFix && (severity === "medium" || severity === "unknown")) names.push("mediumPastFix");
  return names;
}

/** The lowest band among the checks an alert feeds, or null when it feeds none. */
export function bandOfAlert(used: UsedAlert): Band | null {
  return lowest(checksOfAlert(used).map((name) => CHECK_BAND[name as keyof typeof CHECK_BAND]));
}

/** The lowest of the bands, or null for none. */
export function lowest(bands: readonly (Band | null)[]): Band | null {
  let worst: Band | null = null;
  for (const band of bands) if (band !== null && (worst === null || BAND_RANK[band] < BAND_RANK[worst])) worst = band;
  return worst;
}

// ---- supply chain ---------------------------------------------------------------------------------------------

const sameOwner = (use: ActionUse, owner: string) => use.action.split("/")[0]!.toLowerCase() === owner.toLowerCase();

/** The files and tools a presence line asks for, whose absence can be accepted. */
export type AbsenceCheck = "updateConfig" | "securityPolicy" | "dependencyReview" | "secretScanInCi" | "staticAnalysis";

/** `none` when nothing is missing, or the check does not apply; `open` when it is missing; `accepted` when its absence is accepted. */
export type Absence = "none" | "open" | "accepted";

/**
 * What the clone's workflow and file facts found, split by the check each finding belongs to. Every list holds the
 * findings that are still open: those an acceptance covers are in `accepted` and counted in `acceptedByCheck`.
 */
export interface SupplyChainFound {
  prHeadCheckout: WorkflowFinding[];
  scriptInjection: WorkflowFinding[];
  /**
   * Only in a public repository, where anyone can open a pull request that runs on the machine. Null when pull requests
   * run on a self-hosted runner but the repository's visibility is not known, so the check cannot be measured.
   */
  selfHostedPublic: WorkflowFinding[] | null;
  permissions: WorkflowFinding[];
  unsecureCommands: WorkflowFinding[];
  curlPipeShell: WorkflowFinding[];
  secretsInherit: WorkflowFinding[];
  persistCredentials: WorkflowFinding[];
  /** Another organisation's actions and Docker actions that are not pinned to a commit or digest. */
  thirdPartyUnpinned: ActionUse[];
  /** Actions of the repository's own organisation that are not pinned; advice only. */
  ownUnpinned: ActionUse[];
  /** Actions of every kind but local, accepted or not: the base for the share of unpinned third party actions. */
  remoteActions: number;
  strongKeys: KeyFile[];
  weakKeys: KeyFile[];
  /** The Dockerfiles with each problem, one list per check. */
  images: {
    unpinned: DockerfileFacts[];
    latest: DockerfileFacts[];
    root: DockerfileFacts[];
    remoteAdd: DockerfileFacts[];
    curlPipeShell: DockerfileFacts[];
  };
  missingLockfiles: string[];
  absence: Record<AbsenceCheck, Absence>;
  /** What the acceptances cover, in the order the facts list it. */
  accepted: AcceptedHit[];
  acceptedByCheck: Partial<Record<SupplyChainCheckId, number>>;
  /** The files that still hold an open finding of each check, so an acceptance there that matches nothing is reopened. */
  openPaths: Map<SupplyChainCheckId, Set<string>>;
  /**
   * The key files and Dockerfiles among `openPaths` that could not be compared with an acceptance, because their own blob
   * id was not read or the lookup of blob ids failed, so an acceptance there that matches nothing is unchecked rather than
   * reopened.
   */
  uncheckedPaths: Map<SupplyChainCheckId, Set<string>>;
  /**
   * True when the repository is known to be public, the only case in which a self-hosted finding or the absence of a
   * security policy is matched at all.
   */
  knownPublic: boolean;
}

/** `SupplyChainFound.selfHostedPublic` from the open self-hosted findings that pull requests reach and the repository's visibility. */
function selfHostedPublicOf(onPullRequest: WorkflowFinding[], visibility: RepoPosture["visibility"]): WorkflowFinding[] | null {
  if (onPullRequest.length === 0 || visibility === "public") return onPullRequest;
  return visibility === null ? null : [];
}

/**
 * Splits the clone's facts by check and takes out what `acceptances` cover (ADR 0040). This is the one place acceptance
 * is applied, so the grade, the advice and the report agree. `remoteActions` still counts every remote use, so the share
 * of unpinned actions keeps its base.
 */
export function supplyChainFound(
  record: SupplyChainRecord,
  owner: string,
  posture: RepoPosture | null,
  acceptances: readonly FindingAcceptance[] = [],
): SupplyChainFound {
  const { facts } = record;
  const index = new AcceptanceIndex(acceptances);
  const accepted: AcceptedHit[] = [];
  const acceptedByCheck: SupplyChainFound["acceptedByCheck"] = {};
  const openPaths = new Map<SupplyChainCheckId, Set<string>>();
  const uncheckedPaths = new Map<SupplyChainCheckId, Set<string>>();
  const mark = (places: Map<SupplyChainCheckId, Set<string>>, check: SupplyChainCheckId, path: string) => {
    const paths = places.get(check) ?? new Set<string>();
    paths.add(path);
    places.set(check, paths);
  };
  const take = (check: SupplyChainCheckId, subject: Subject): boolean => {
    const acceptance = index.find(check, subject);
    if (acceptance === null) {
      const path = subjectPath(subject);
      if (path !== null) {
        mark(openPaths, check, path);
        // Only a key file or a Dockerfile is matched on its blob id, and one that was not read has no fingerprint.
        const blob = subject.kind === "key" || subject.kind === "image";
        if (blob && (!facts.blobsRead || fingerprintOf(subject) === null)) mark(uncheckedPaths, check, path);
      }
      return false;
    }
    accepted.push({ acceptance, check, subject });
    acceptedByCheck[check] = (acceptedByCheck[check] ?? 0) + 1;
    return true;
  };
  /** The items of the list no acceptance covers. */
  const open = <T>(check: SupplyChainCheckId, list: readonly T[], subject: (item: T) => Subject): T[] =>
    index.empty ? [...list] : list.filter((item) => !take(check, subject(item)));
  const finding = (f: WorkflowFinding): Subject => ({ kind: "finding", finding: f });
  const use = (u: ActionUse): Subject => ({ kind: "use", use: u });
  const key = (k: KeyFile): Subject => ({ kind: "key", key: k });
  const image = (d: DockerfileFacts): Subject => ({ kind: "image", dockerfile: d });
  const risk = (check: SupplyChainCheckId, ...risks: WorkflowFinding["risk"][]) =>
    open(
      check,
      facts.findings.filter((f) => risks.includes(f.risk)),
      finding,
    );
  const absence = (check: AbsenceCheck, missing: boolean): Absence => {
    if (!missing) return "none";
    return index.empty || !take(check, { kind: "absence" }) ? "open" : "accepted";
  };
  const hasTool = (category: string) => facts.securityTools.some((t) => t.category === category);
  const remote = facts.actions.filter((u) => u.kind !== "local");
  // A pull request from a fork reaches only the self-hosted findings that say so. In a private repository there is no
  // one outside to open one, so nothing there is a finding and nothing is accepted. With the visibility unknown the check
  // is unmeasured, so it is not split either, and an acceptance cannot be counted as having applied to it.
  const visibility = posture?.visibility ?? null;
  const reached = facts.findings.filter((f) => f.risk === "selfHosted" && f.onPullRequest === true);
  const selfHosted = visibility === "public" ? open("selfHostedPublic", reached, finding) : reached;
  return {
    prHeadCheckout: risk("prHeadCheckout", "prHeadCheckout"),
    scriptInjection: risk("scriptInjection", "scriptInjection"),
    selfHostedPublic: selfHostedPublicOf(selfHosted, visibility),
    permissions: risk("workflowPermissions", "writeAll", "noPermissions"),
    unsecureCommands: risk("unsecureCommands", "unsecureCommands"),
    curlPipeShell: risk("curlPipeShell", "curlPipeShell"),
    secretsInherit: risk("secretsInherit", "secretsInherit"),
    persistCredentials: risk("persistCredentials", "persistCredentials"),
    thirdPartyUnpinned: open(
      "unpinnedActions",
      remote.filter((u) => !u.pinned && (u.kind === "docker" || (u.kind === "other" && !sameOwner(u, owner)))),
      use,
    ),
    ownUnpinned: open(
      "ownActionsUnpinned",
      remote.filter((u) => !u.pinned && u.kind === "other" && sameOwner(u, owner)),
      use,
    ),
    remoteActions: remote.length,
    strongKeys: open(
      "keyFiles",
      facts.keyFiles.filter((k) => k.strength === "strong"),
      key,
    ),
    weakKeys: open(
      "weakKeyFiles",
      facts.keyFiles.filter((k) => k.strength === "weak"),
      key,
    ),
    images: {
      unpinned: open(
        "baseImagesPinned",
        facts.dockerfiles.filter((d) => d.unpinnedImages > 0),
        image,
      ),
      latest: open(
        "latestImages",
        facts.dockerfiles.filter((d) => d.latestImages > 0),
        image,
      ),
      root: open(
        "nonRootImages",
        facts.dockerfiles.filter((d) => d.runsAsRoot),
        image,
      ),
      remoteAdd: open(
        "remoteAdd",
        facts.dockerfiles.filter((d) => d.addsRemote),
        image,
      ),
      curlPipeShell: open(
        "curlPipeShell",
        facts.dockerfiles.filter((d) => d.curlPipeShell),
        image,
      ),
    },
    missingLockfiles: open("lockfiles", facts.missingLockfiles, (path): Subject => ({ kind: "lockfile", path })),
    absence: {
      updateConfig: absence("updateConfig", facts.updateConfig === null),
      // Only a public repository has outside reporters to tell where to send a vulnerability.
      securityPolicy: absence("securityPolicy", facts.securityPolicy === null && visibility === "public"),
      dependencyReview: absence("dependencyReview", !hasTool("dependency_review")),
      secretScanInCi: absence("secretScanInCi", !hasTool("secret_scan")),
      staticAnalysis: absence("staticAnalysis", !hasTool("sast")),
    },
    accepted,
    acceptedByCheck,
    openPaths,
    uncheckedPaths,
    knownPublic: visibility === "public",
  };
}

/**
 * Whether the request names something the latest read reports and that can be accepted, and the line it is on. It runs
 * the same matching the grade does with the request as the only acceptance, so what can be accepted is exactly what the
 * grade would then leave out. The line comes from the finding and never from the request. A fingerprint of a retired
 * kind is refused before any matching, so nothing new is ever accepted under it.
 */
export function findAcceptable(
  record: SupplyChainRecord,
  owner: string,
  posture: RepoPosture | null,
  request: AcceptanceRequest,
): { line: number | null } | null {
  if (!CURRENT_FINGERPRINT.test(request.fingerprint)) return null;
  const probe: FindingAcceptance = { ...request, id: 0, line: null, acceptedAt: "" };
  // A check the report leaves out because visibility is unknown shows nothing to accept.
  if (request.check === "selfHostedPublic" && supplyChainFound(record, owner, posture).selfHostedPublic === null) return null;
  const hit = supplyChainFound(record, owner, posture, [probe]).accepted.find((h) => h.acceptance === probe);
  return hit ? { line: subjectLine(hit.subject) } : null;
}

// ---- change control -------------------------------------------------------------------------------------------

export interface BranchState {
  /**
   * True when it is known whether anything protects the deploy branch: some protection or rule is in force, or the
   * branch's own protected flag was read and so were the rulesets (`detail` is not `none`). A branch whose flag says
   * unprotected is not read while the rulesets are unknown, since a ruleset could still protect it; nor is one whose
   * flag could not be read and whose rulesets hold nothing, since an empty answer from rulesets alone cannot show that
   * nothing protects it.
   */
  read: boolean;
  /** Read, and protected by neither classic protection nor a ruleset. */
  unprotected: boolean;
  /** Force pushes are allowed on a branch that has other protection. */
  forcePushAllowed: boolean;
  /** Some protection or rule is in force. */
  enforced: boolean;
}

export function branchState(posture: RepoPosture | null): BranchState {
  if (posture === null) return { read: false, unprotected: false, forcePushAllowed: false, enforced: false };
  const { branch } = posture;
  const { requiredApprovals, ...flags } = branch.rules;
  const enforced = branch.protected === true || (requiredApprovals ?? 0) > 0 || Object.values(flags).some((v) => v === true);
  const read = enforced || (branch.protected !== null && branch.detail !== "none");
  return {
    read,
    unprotected: read && !enforced,
    forcePushAllowed: read && enforced && branch.rules.blockForcePushes === false,
    enforced,
  };
}

// ---- checks ---------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Found {
  count: number;
  /** Findings of the check an acceptance covers, which are not in `count`. */
  accepted?: number;
  total?: number;
  oldestDays?: number;
  detail?: string[];
}

const files = (found: readonly { file: string }[]) => [...new Set(found.map((f) => f.file))].sort().slice(0, 10);

function check(
  part: SecurityPartName,
  name: SecurityCheckName,
  band: Band,
  found: Found,
  cleared: ReadonlySet<SecurityCheckName>,
): SecurityCheck {
  const count = cleared.has(name) ? 0 : found.count;
  return {
    part,
    check: name,
    value: count,
    band: count > 0 ? band : "elite",
    met: count === 0,
    count,
    ...(found.accepted ? { accepted: found.accepted } : {}),
    ...(found.total === undefined ? {} : { total: found.total }),
    ...(count > 0 && found.oldestDays !== undefined ? { oldestDays: found.oldestDays } : {}),
    ...(count > 0 && found.detail && found.detail.length > 0 ? { detail: found.detail } : {}),
    limits: false,
  };
}

/** Parts that could not be measured are null; checks that could not be measured carry no band. */
function vulnerabilityChecks(facts: SecurityFacts, cleared: ReadonlySet<SecurityCheckName>): SecurityCheck[] | null {
  const { sources } = facts;
  const dependabotDisabled = sources.dependabot.status === "off" && sources.dependabot.reason === "disabled";
  if (!Object.values(sources).some(isUsable) && !dependabotDisabled) return null;
  const used = usedAlerts(facts);
  const oldest = (list: UsedAlert[]) =>
    list.length === 0 ? undefined : Math.floor(list.reduce((most, u) => Math.max(most, u.ageHours), 0) / 24);
  const named = (name: SecurityCheckName): Found => {
    const list = used.filter((u) => checksOfAlert(u).includes(name));
    return { count: list.length, oldestDays: oldest(list) };
  };
  const manifests = facts.supplyChain
    ? Object.values(facts.supplyChain.facts.manifestsByEcosystem).reduce((total, n) => total + n, 0)
    : 0;
  const unwatched = dependabotDisabled && !isUsable(sources.osv) && (facts.supplyChain === null || manifests > 0);
  const make = (name: SecurityCheckName, found: Found) => check("vulnerabilities", name, CHECK_BAND[name], found, cleared);
  const secrets = make("secretExposed", named("secretExposed"));
  return [
    isUsable(sources.secret_scanning) ? secrets : { part: "vulnerabilities", check: "secretExposed", value: null, limits: false },
    make("criticalPastFix", named("criticalPastFix")),
    make("criticalOpen", named("criticalOpen")),
    make("highPastFix", named("highPastFix")),
    { ...make("dependenciesUnwatched", { count: unwatched ? 1 : 0 }), value: unwatched && !cleared.has("dependenciesUnwatched") },
    make("highOpen", named("highOpen")),
    make("mediumPastFix", named("mediumPastFix")),
  ];
}

function supplyChainChecks(facts: SecurityFacts, cleared: ReadonlySet<SecurityCheckName>): SecurityCheck[] | null {
  if (facts.supplyChain === null) return null;
  const found = supplyChainFound(facts.supplyChain, facts.owner, facts.posture, facts.acceptances);
  const make = (name: SecurityCheckName, count: number, detail: string[], total?: number) =>
    check(
      "supplyChain",
      name,
      CHECK_BAND[name],
      {
        count,
        detail,
        accepted: found.acceptedByCheck[name as SupplyChainCheckId] ?? 0,
        ...(total === undefined ? {} : { total }),
      },
      cleared,
    );
  return [
    make("prHeadCheckout", found.prHeadCheckout.length, files(found.prHeadCheckout)),
    make("scriptInjection", found.scriptInjection.length, files(found.scriptInjection)),
    // A visibility that was not read leaves the check unmeasured rather than passed, as a secret source that cannot be
    // used leaves `secretExposed`.
    found.selfHostedPublic === null
      ? { part: "supplyChain", check: "selfHostedPublic", value: null, limits: false }
      : make("selfHostedPublic", found.selfHostedPublic.length, files(found.selfHostedPublic)),
    make("unpinnedActions", found.thirdPartyUnpinned.length, files(found.thirdPartyUnpinned), found.remoteActions),
    make("workflowPermissions", found.permissions.length, files(found.permissions)),
    make("unsecureCommands", found.unsecureCommands.length, files(found.unsecureCommands)),
    make(
      "keyFiles",
      found.strongKeys.length,
      found.strongKeys
        .map((k) => k.path)
        .sort()
        .slice(0, 10),
    ),
  ];
}

/** Change control is measured when the branch was read (ADR 0033); review habits are a delivery figure (ADR 0036). */
function changeControlChecks(facts: SecurityFacts, cleared: ReadonlySet<SecurityCheckName>): SecurityCheck[] | null {
  const branch = branchState(facts.posture);
  if (!branch.read) return null;
  const flag = (name: "branchUnprotected" | "forcePushAllowed", on: boolean): SecurityCheck => ({
    ...check("changeControl", name, CHECK_BAND[name], { count: on ? 1 : 0 }, cleared),
    value: on && !cleared.has(name),
  });
  return [flag("branchUnprotected", branch.unprotected), flag("forcePushAllowed", branch.forcePushAllowed)];
}

// ---- reasons --------------------------------------------------------------------------------------------------

const REASON: Record<SecurityCheckName, (c: SecurityCheck) => string> = {
  secretExposed: (c) =>
    `${plural(c.count ?? 0, "open secret alert")} still work or ${c.count === 1 ? "was" : "were"} leaked publicly`,
  criticalPastFix: (c) =>
    `${plural(c.count ?? 0, "critical alert")} ${c.count === 1 ? "has" : "have"} been open for more than ${FIX_WITHIN_DAYS.critical} days`,
  criticalOpen: (c) => `${plural(c.count ?? 0, "critical alert")} ${c.count === 1 ? "is" : "are"} open`,
  highPastFix: (c) =>
    `${plural(c.count ?? 0, "high alert")} ${c.count === 1 ? "has" : "have"} been open for more than ${FIX_WITHIN_DAYS.high} days`,
  dependenciesUnwatched: () => "Dependabot is switched off and nothing else watches the dependencies",
  highOpen: (c) => `${plural(c.count ?? 0, "high alert")} ${c.count === 1 ? "is" : "are"} open`,
  mediumPastFix: (c) =>
    `${plural(c.count ?? 0, "medium alert")} ${c.count === 1 ? "has" : "have"} been open for more than ${FIX_WITHIN_DAYS.medium} days`,
  prHeadCheckout: (c) =>
    `${plural(c.count ?? 0, "privileged workflow step")} check${c.count === 1 ? "s" : ""} out code from a pull request`,
  scriptInjection: (c) =>
    `${plural(c.count ?? 0, "privileged workflow step")} put${c.count === 1 ? "s" : ""} untrusted text in a script`,
  selfHostedPublic: () => "A public repository runs pull requests on a self-hosted runner",
  unpinnedActions: (c) => `${plural(c.count ?? 0, "third party action")} ${c.count === 1 ? "is" : "are"} not pinned to a commit`,
  workflowPermissions: (c) =>
    `${plural(c.count ?? 0, "workflow")} grant${c.count === 1 ? "s" : ""} more token access than needed or set none`,
  unsecureCommands: () => "A workflow switches on the deprecated unsecure commands",
  keyFiles: (c) =>
    `${plural(c.count ?? 0, "file")} that look${c.count === 1 ? "s" : ""} like keys or secrets ${c.count === 1 ? "is" : "are"} committed`,
  branchUnprotected: () => "The deploy branch has no protection and no rules",
  forcePushAllowed: () => "Force pushes are allowed on the deploy branch",
};

const PART_LABEL: Record<SecurityPartName, string> = {
  vulnerabilities: "Vulnerabilities",
  supplyChain: "Supply chain",
  changeControl: "Change control",
};

const ALL_TEXT: Record<SecurityPartName, string> = {
  vulnerabilities: "No alert holds the repository back",
  supplyChain: "No workflow or file holds the repository back",
  changeControl: "The deploy branch is protected",
};

/** The lowest band among the checks that have one, naming the first check at it; `all` when that band is elite. */
function partGrade(part: SecurityPartName, checks: SecurityCheck[]): GradePart<SecurityCheckName | "all"> {
  let worst: SecurityCheck | null = null;
  for (const c of checks) if (c.band && (worst === null || BAND_RANK[c.band] < BAND_RANK[worst.band!])) worst = c;
  if (worst === null || worst.band === "elite") return { band: "elite", check: "all", reason: ALL_TEXT[part] };
  return { band: worst.band!, check: worst.check, reason: REASON[worst.check](worst) };
}

/** What could not be measured, for a grade that reads "nothing found in what was measured". */
export function unmeasuredOf(input: {
  sources: Record<AlertSource, SourceState>;
  hasSupplyChain: boolean;
  posture: RepoPosture | null;
}): SecurityMeasure[] {
  const { sources } = input;
  const unmeasured: SecurityMeasure[] = [];
  if (!isUsable(sources.dependabot) && !isUsable(sources.osv)) unmeasured.push("dependencies");
  if (!isUsable(sources.code_scanning)) unmeasured.push("code");
  if (!isUsable(sources.secret_scanning)) unmeasured.push("secrets");
  if (!input.hasSupplyChain) unmeasured.push("supplyChain");
  if (!branchState(input.posture).read) unmeasured.push("changeControl");
  return unmeasured;
}

/** A grade or why there is none, and the evidence behind it, with `limits` set on the check behind each part. */
export type GradedSecurity = SecurityGradeOutcome & { checks: SecurityCheck[] };

/**
 * Grades the facts. `cleared` names checks to treat as found nothing, which is how `raisedBand` asks what the grade
 * would be once the work on the path was done.
 */
export function gradeSecurity(facts: SecurityFacts, cleared: ReadonlySet<SecurityCheckName> = new Set()): GradedSecurity {
  if (!facts.crawled) return { grade: null, checks: [], gradeMissing: "not_crawled" };
  const measured: Record<SecurityPartName, SecurityCheck[] | null> = {
    vulnerabilities: vulnerabilityChecks(facts, cleared),
    supplyChain: supplyChainChecks(facts, cleared),
    changeControl: changeControlChecks(facts, cleared),
  };
  const parts = Object.fromEntries(
    SECURITY_PARTS.map((name) => [name, measured[name] === null ? null : partGrade(name, measured[name])]),
  ) as SecurityGrade["parts"];
  const checks = SECURITY_PARTS.flatMap((name) =>
    (measured[name] ?? []).map((c) => ({ ...c, limits: c.band !== undefined && parts[name]!.check === c.check })),
  );

  const unmeasured = unmeasuredOf({
    sources: facts.sources,
    hasSupplyChain: facts.supplyChain !== null,
    posture: facts.posture,
  });

  // Change control alone is not enough to grade: it says nothing about what the code and its dependencies hold.
  if (parts.vulnerabilities === null && parts.supplyChain === null)
    return { grade: null, checks, gradeMissing: "nothing_measured" };
  let lowestPart: SecurityPartName = SECURITY_PARTS.find((name) => parts[name] !== null)!;
  for (const name of SECURITY_PARTS) {
    if (parts[name] !== null && BAND_RANK[parts[name].band] < BAND_RANK[parts[lowestPart]!.band]) lowestPart = name;
  }
  const part = parts[lowestPart]!;
  const overall = {
    part: lowestPart,
    band: part.band,
    check: part.check,
    reason:
      part.band === "elite"
        ? "Nothing was found in what was measured"
        : `${PART_LABEL[lowestPart]} is the lowest part. ${part.reason}`,
  };
  return { grade: { overall, parts, unmeasured }, checks, gradeMissing: null };
}

/**
 * The band the repository would reach if every check at the overall band were cleared, or null when it is already
 * elite or has no grade. Raising the band means clearing all of them, since each one alone leaves the band where it is.
 * A check that counts alerts is cleared by taking away the alerts behind it, together with every other check those
 * alerts feed, because rotating one secret ends both its `secretExposed` and its `criticalOpen`. `done` names further
 * alerts that the work on the path would also clear, such as the other members of a package's upgrade.
 */
export function raisedBand(
  facts: SecurityFacts,
  graded: GradedSecurity = gradeSecurity(facts),
  done: readonly SecurityAlert[] = [],
): Band | null {
  if (graded.grade === null || graded.grade.overall.band === "elite") return null;
  const level = graded.grade.overall.band;
  const cleared = new Set(graded.checks.filter((c) => c.band === level && c.met === false).map((c) => c.check));
  const removed = new Set<SecurityAlert>(done);
  for (const used of usedAlerts(facts)) if (checksOfAlert(used).some((name) => cleared.has(name))) removed.add(used.alert);
  const remaining: SecurityFacts = { ...facts, alerts: facts.alerts.filter((alert) => !removed.has(alert)) };
  return gradeSecurity(remaining, cleared).grade!.overall.band;
}
