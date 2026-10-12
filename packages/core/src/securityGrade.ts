import type { GradePart } from "./codeGrade.js";
import { instant } from "./delivery.js";
import { BAND_RANK, type Band } from "./dora.js";
import { isUsable, severityOf } from "./securityAlerts.js";
import { DAY_MS, HOUR_MS } from "./stats.js";
import {
  FIX_WITHIN_DAYS,
  SECURITY_PARTS,
  type ActionUse,
  type AlertSource,
  type KeyFile,
  type RepoPosture,
  type SecurityAlert,
  type SecurityCheck,
  type SecurityCheckName,
  type SecurityGrade,
  type SecurityGradeMissing,
  type SecurityMeasure,
  type SecurityPartName,
  type Severity,
  type SourceState,
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

/** Everything the grade reads, gathered by the caller. Nothing here is a clock or a store. */
export interface SecurityFacts {
  owner: string;
  /** ISO. */
  now: string;
  /** False until the repository has been crawled once. */
  crawled: boolean;
  alerts: readonly SecurityAlert[];
  sources: Record<AlertSource, SourceState>;
  supplyChain: SupplyChainRecord | null;
  supplyChainMissing: "analysis_off" | "not_read" | null;
  posture: RepoPosture | null;
}

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
  const dependencySource: AlertSource | null = isUsable(sources.dependabot) ? "dependabot" : isUsable(sources.osv) ? "osv" : null;
  return alerts.filter((alert) => {
    if (severityOf(alert) === null) return false;
    if (alert.source === "dependabot" || alert.source === "osv") return alert.source === dependencySource;
    return isUsable(sources[alert.source]);
  });
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

/** What the clone's workflow and file facts found, split by the check each finding belongs to. */
export interface SupplyChainFound {
  prHeadCheckout: WorkflowFinding[];
  scriptInjection: WorkflowFinding[];
  /** Only in a public repository, where anyone can open a pull request that runs on the machine. */
  selfHostedPublic: WorkflowFinding[];
  permissions: WorkflowFinding[];
  unsecureCommands: WorkflowFinding[];
  curlPipeShell: WorkflowFinding[];
  secretsInherit: WorkflowFinding[];
  persistCredentials: WorkflowFinding[];
  /** Another organisation's actions and Docker actions that are not pinned to a commit or digest. */
  thirdPartyUnpinned: ActionUse[];
  /** Actions of the repository's own organisation that are not pinned; advice only. */
  ownUnpinned: ActionUse[];
  /** Actions of every kind but local, the base for the share of unpinned third party actions. */
  remoteActions: number;
  strongKeys: KeyFile[];
  weakKeys: KeyFile[];
}

export function supplyChainFound(record: SupplyChainRecord, owner: string, posture: RepoPosture | null): SupplyChainFound {
  const { facts } = record;
  const risk = (...risks: WorkflowFinding["risk"][]) => facts.findings.filter((f) => risks.includes(f.risk));
  const remote = facts.actions.filter((use) => use.kind !== "local");
  return {
    prHeadCheckout: risk("prHeadCheckout"),
    scriptInjection: risk("scriptInjection"),
    // Only a workflow that pull requests trigger lets someone outside the team run code on the machine.
    selfHostedPublic: posture?.visibility === "public" ? risk("selfHosted").filter((f) => f.onPullRequest === true) : [],
    permissions: risk("writeAll", "noPermissions"),
    unsecureCommands: risk("unsecureCommands"),
    curlPipeShell: risk("curlPipeShell"),
    secretsInherit: risk("secretsInherit"),
    persistCredentials: risk("persistCredentials"),
    thirdPartyUnpinned: remote.filter(
      (use) => !use.pinned && (use.kind === "docker" || (use.kind === "other" && !sameOwner(use, owner))),
    ),
    ownUnpinned: remote.filter((use) => !use.pinned && use.kind === "other" && sameOwner(use, owner)),
    remoteActions: remote.length,
    strongKeys: facts.keyFiles.filter((k) => k.strength === "strong"),
    weakKeys: facts.keyFiles.filter((k) => k.strength === "weak"),
  };
}

// ---- change control -------------------------------------------------------------------------------------------

export interface BranchState {
  /**
   * True when the host answered whether the deploy branch is protected: classic protection was read, or a rule is in
   * force. When the branch endpoint failed and rulesets answered with nothing, the branch is not read, since an empty
   * answer from rulesets alone cannot show that nothing protects it.
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
  const read = branch.protected !== null || enforced;
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
  const found = supplyChainFound(facts.supplyChain, facts.owner, facts.posture);
  const make = (name: SecurityCheckName, count: number, detail: string[], total?: number) =>
    check("supplyChain", name, CHECK_BAND[name], { count, detail, ...(total === undefined ? {} : { total }) }, cleared);
  return [
    make("prHeadCheckout", found.prHeadCheckout.length, files(found.prHeadCheckout)),
    make("scriptInjection", found.scriptInjection.length, files(found.scriptInjection)),
    make("selfHostedPublic", found.selfHostedPublic.length, files(found.selfHostedPublic)),
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

export interface GradedSecurity {
  grade: SecurityGrade | null;
  /** The evidence behind the grade, with `limits` set on the check behind each part. */
  checks: SecurityCheck[];
  gradeMissing: SecurityGradeMissing | null;
}

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
