import { BAND_RANK, type Band } from "./dora.js";
import { SEVERITY_RANK, isLikelyExploited, isUsable, worseSeverity } from "./securityAlerts.js";
import { compareText } from "./stats.js";
import {
  bandOfAlert,
  branchState,
  lowest,
  supplyChainFound,
  usedAlerts,
  type SecurityFacts,
  type UsedAlert,
} from "./securityGrade.js";
import { compareVersions, highestVersion } from "./versions.js";
import {
  ALERT_SOURCES,
  DEPENDENCY_ACTION_KINDS,
  SECURITY_ACTION_KINDS,
  type ActionPackage,
  type ActionUse,
  type DependencyActionKind,
  type DependencyFacts,
  type DockerfileFacts,
  type DependencyGroup,
  type SecurityAction,
  type SecurityAlert,
  type SecurityActionKind,
  type WorkflowFinding,
} from "./securityTypes.js";

/**
 * What to do about each finding, one action per thing to fix, worst first (ADR 0033). An action with a band is one
 * the grade is waiting for; one without is advice that never moves the grade. The list names things to act on and
 * never a person.
 */

/** Most references an action carries. */
export const MAX_REFS = 10;

/** An update pull request open for longer than this many days is worth merging or closing. */
export const STALE_UPDATE_DAYS = 30;

export interface AdviceInput {
  facts: SecurityFacts;
  /** The grade's overall band, or null when there is no grade; the actions at that band are the ones on the path. */
  overall: Band | null;
  /** Dependency update pull requests that have been open for more than `STALE_UPDATE_DAYS`. */
  staleUpdates: number;
  /** Builds the link to a file in the clone's commit, or null when the host builds none. Defaults to none. */
  link?: FileLink;
}

/** A link to a file, and a line of it, at the commit the clone was read from. */
export type FileLink = (path: string, line: number | null) => string | null;

const noLink: FileLink = () => null;

/** A dependency group with the open alerts behind it, so advice can list them. */
export interface DependencyGroupDetail extends DependencyGroup {
  members: UsedAlert[];
}

const KIND_RANK = Object.fromEntries(SECURITY_ACTION_KINDS.map((k, i) => [k, i])) as Record<SecurityActionKind, number>;

/** Worst first: severity, then past its fix-by date, then likely to be exploited, then oldest. */
export function compareAlerts(a: UsedAlert, b: UsedAlert): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    Number(b.pastFix) - Number(a.pastFix) ||
    Number(isLikelyExploited(b.alert)) - Number(isLikelyExploited(a.alert)) ||
    b.ageHours - a.ageHours ||
    compareText(a.alert.key, b.alert.key)
  );
}

const byVersion = (a: string, b: string) => compareVersions(a, b) ?? compareText(a, b);

/** The version that fixes a dependency alert, or null when there is none yet. */
const fixOf = ({ alert }: UsedAlert): string | null =>
  alert.source === "dependabot" || alert.source === "osv" ? alert.dependency.patchedVersion : null;

/**
 * Open dependency alerts grouped by package and manifest, worst first. One package in two manifests is two groups,
 * because each manifest is upgraded on its own. Versions locked within one manifest share a group and are listed in
 * `lockedVersions`. An alert whose host named no ecosystem, package or manifest is a group of its own, so unrelated
 * unnamed packages never share one upgrade.
 */
export function groupDependencies(usedList: readonly UsedAlert[]): DependencyGroupDetail[] {
  const groups = new Map<string, { used: UsedAlert; dependency: DependencyFacts }[]>();
  for (const used of usedList) {
    if (used.alert.source !== "dependabot" && used.alert.source !== "osv") continue;
    const { dependency } = used.alert;
    const { ecosystem, name, manifestPath } = dependency;
    const key =
      ecosystem === null || name === null || manifestPath === null
        ? JSON.stringify(["alert", used.alert.source, used.alert.key])
        : JSON.stringify(["package", ecosystem, name, manifestPath]);
    const entries = groups.get(key) ?? [];
    entries.push({ used, dependency });
    groups.set(key, entries);
  }
  return [...groups.values()]
    .map((entries): DependencyGroupDetail => {
      const members = entries.map((e) => e.used);
      const dependencies = entries.map((e) => e.dependency);
      const patched = [...new Set(dependencies.flatMap((d) => (d.patchedVersion === null ? [] : [d.patchedVersion])))].sort(
        byVersion,
      );
      const relationships = new Set(dependencies.flatMap((d) => (d.relationship === null ? [] : [d.relationship])));
      return {
        ecosystem: dependencies[0]!.ecosystem,
        name: dependencies[0]!.name,
        manifestPath: dependencies[0]!.manifestPath,
        relationship: relationships.size === 0 ? null : relationships.size > 1 ? "mixed" : [...relationships][0]!,
        lockedVersions: [...new Set(dependencies.flatMap((d) => (d.lockedVersion === null ? [] : [d.lockedVersion])))].sort(
          byVersion,
        ),
        alerts: members.length,
        worstSeverity: members.map((m) => m.severity).reduce(worseSeverity),
        upgradeTo: highestVersion(patched),
        patchedVersions: patched,
        pastFix: members.filter((m) => m.pastFix).length,
        likelyExploited: members.some((m) => isLikelyExploited(m.alert)),
        members: [...members].sort(compareAlerts),
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity] ||
        b.pastFix - a.pastFix ||
        b.alerts - a.alerts ||
        compareText(a.name ?? "", b.name ?? "") ||
        compareText(a.ecosystem ?? "", b.ecosystem ?? "") ||
        compareText(a.manifestPath ?? "", b.manifestPath ?? "") ||
        compareText(a.members[0]!.alert.key, b.members[0]!.alert.key),
    );
}

type Ref = SecurityAction["refs"][number];

/**
 * A reference to one alert. A code alert reads as its place, else its rule, else its title; a dependency alert as its
 * package and version with the advisory, or as the advisory, else its title, when the package is not named.
 */
const refOfAlert = ({ alert }: UsedAlert): Ref => {
  if (alert.source === "code_scanning") {
    const { path, line, ruleId } = alert.code;
    return { label: path === null ? (ruleId ?? alert.title) : line === null ? path : `${path}:${line}`, url: alert.url };
  }
  if (alert.source === "secret_scanning") return { label: alert.title, url: alert.url };
  const { name, lockedVersion, advisoryId } = alert.dependency;
  if (name === null) return { label: advisoryId ?? alert.title, url: alert.url };
  const advisory = advisoryId === null ? "" : ` (${advisoryId})`;
  return { label: `${name}${lockedVersion === null ? "" : `@${lockedVersion}`}${advisory}`, url: alert.url };
};

const alertRefs = (members: readonly UsedAlert[]): Ref[] => [...members].sort(compareAlerts).slice(0, MAX_REFS).map(refOfAlert);

const findingRef = (f: WorkflowFinding, link: FileLink): Ref => ({
  label: f.line === null ? f.file : `${f.file}:${f.line}`,
  url: link(f.file, f.line),
});
const useRef = (u: ActionUse, link: FileLink): Ref => ({
  label: `${u.action}${u.ref === null ? "" : `@${u.ref}`}`,
  url: link(u.file, u.line),
});
const pathRef = (path: string, link: FileLink): Ref => ({ label: path, url: link(path, null) });

/** Groups by workflow file, in path order. */
function byFile<T extends { file: string }>(list: readonly T[]): [string, T[]][] {
  const files = new Map<string, T[]>();
  for (const item of list) {
    const items = files.get(item.file) ?? [];
    items.push(item);
    files.set(item.file, items);
  }
  return [...files].sort(([a], [b]) => compareText(a, b));
}

/** An action before it is ranked: its band is known, whether it is on the path is not yet. */
interface Draft {
  kind: SecurityActionKind;
  band: Band | null;
  severity: SecurityAction["severity"];
  count: number;
  target: string | null;
  likelyExploited: boolean;
  refs: Ref[];
  package: ActionPackage | null;
}

const blank = (kind: SecurityActionKind): Draft => ({
  kind,
  band: null,
  severity: null,
  count: 0,
  target: null,
  likelyExploited: false,
  refs: [],
  package: null,
});

const isDependencyKind = (kind: SecurityActionKind): kind is DependencyActionKind =>
  (DEPENDENCY_ACTION_KINDS as readonly string[]).includes(kind);

/** The finished action: on the path when its band is the overall band, and `package` only on a dependency kind. */
function finish({ kind, band, package: pkg, ...facts }: Draft, overall: Band | null): SecurityAction {
  const weight = band === null ? { band, onPath: false as const } : { band, onPath: band === overall };
  if (isDependencyKind(kind)) return { ...facts, ...weight, kind, package: pkg! };
  return { ...facts, ...weight, kind };
}

/**
 * Every action for the facts, ranked: those on the path first, then the worst band, the worst severity, likely to be
 * exploited, the most findings, the kind's own order and finally the target. Low alerts become advice only once one is
 * older than its limit.
 */
export function securityActions(input: AdviceInput): SecurityAction[] {
  return securityPlan(input).actions;
}

/**
 * The actions, and the open alerts that doing the ones on the path would clear: every member of each on-path action,
 * which can be more than the alerts that feed the limiting checks, since upgrading a package fixes all of its alerts
 * that have a fix.
 */
export function securityPlan({ facts, overall, staleUpdates, link = noLink }: AdviceInput): {
  actions: SecurityAction[];
  onPathAlerts: SecurityAlert[];
} {
  const entries: { action: Draft; members: readonly UsedAlert[] }[] = [];
  const add = (kind: SecurityActionKind, fields: Partial<Omit<Draft, "kind">>, members: readonly UsedAlert[] = []) => {
    entries.push({ action: { ...blank(kind), ...fields }, members });
  };
  const { sources, posture, supplyChain } = facts;
  const used = usedAlerts(facts);
  const open = used.filter((u) => u.severity !== "low");

  // Secrets, dependencies and code alerts.
  const secrets = new Map<string, UsedAlert[]>();
  for (const u of open) {
    if (u.alert.source !== "secret_scanning") continue;
    const { type, validity, publiclyLeaked } = u.alert.exposure;
    if (validity === "inactive" && !publiclyLeaked) continue;
    secrets.set(type, [...(secrets.get(type) ?? []), u]);
  }
  for (const [type, members] of secrets) {
    add(
      "rotate_secret",
      {
        band: lowest(members.map(bandOfAlert)),
        severity: "critical",
        count: members.length,
        target: type,
        refs: alertRefs(members),
      },
      members,
    );
  }
  for (const group of groupDependencies(open)) {
    const { ecosystem, name, manifestPath, relationship, upgradeTo } = group;
    // An upgrade clears only the alerts that have a fix, so an advisory with none yet stays as an action of its own and
    // is never counted as cleared by the upgrade.
    const patched = group.members.filter((m) => fixOf(m) !== null);
    const unpatched = group.members.filter((m) => fixOf(m) === null);
    const parts: [DependencyActionKind, UsedAlert[], string | null][] = [
      ["upgrade_dependency", patched, upgradeTo],
      ["replace_dependency", unpatched, null],
    ];
    for (const [kind, members, to] of parts) {
      if (members.length === 0) continue;
      add(
        kind,
        {
          band: lowest(members.map(bandOfAlert)),
          severity: members.map((m) => m.severity).reduce(worseSeverity),
          count: members.length,
          target: ecosystem === null || name === null ? null : `${ecosystem}:${name}`,
          package: { ecosystem, name, manifestPath, relationship, upgradeTo: to },
          likelyExploited: members.some((m) => isLikelyExploited(m.alert)),
          refs: alertRefs(members),
        },
        members,
      );
    }
  }
  // One action per rule; an alert whose host named no rule is an action of its own.
  const rules = new Map<string, { ruleId: string | null; members: UsedAlert[] }>();
  for (const u of open) {
    if (u.alert.source !== "code_scanning") continue;
    const { ruleId } = u.alert.code;
    const key = ruleId === null ? JSON.stringify(["alert", u.alert.key]) : JSON.stringify(["rule", ruleId]);
    const rule = rules.get(key) ?? { ruleId, members: [] };
    rule.members.push(u);
    rules.set(key, rule);
  }
  for (const { ruleId, members } of rules.values()) {
    add(
      "fix_code_alert",
      {
        band: lowest(members.map(bandOfAlert)),
        severity: members.map((m) => m.severity).reduce(worseSeverity),
        count: members.length,
        target: ruleId,
        refs: alertRefs(members),
      },
      members,
    );
  }
  const oldLow = used.filter((u) => u.severity === "low" && u.pastFix);
  if (oldLow.length > 0) add("fix_low_alerts", { severity: "low", count: oldLow.length, refs: alertRefs(oldLow) });

  // Dependabot and the sources themselves.
  const unwatched = sources.dependabot.status === "off" && sources.dependabot.reason === "disabled";
  const manifests = supplyChain ? Object.values(supplyChain.facts.manifestsByEcosystem).reduce((t, n) => t + n, 0) : 0;
  if (sources.dependabot.status === "off" && (supplyChain === null || manifests > 0)) {
    const graded = unwatched && !isUsable(sources.osv);
    add("enable_dependabot", { band: graded ? "medium" : null, count: 1, target: "dependabot" });
  }
  if (sources.code_scanning.status === "off") add("enable_code_scanning", { count: 1, target: "code_scanning" });
  if (
    sources.secret_scanning.status === "off" ||
    (sources.secret_scanning.status === "no_access" && sources.secret_scanning.reason === "admin_only_or_off")
  ) {
    add("check_secret_scanning", { count: 1, target: "secret_scanning" });
  }
  for (const source of ALERT_SOURCES) {
    const state = sources[source];
    if (state.status === "no_access" && state.reason === "forbidden") add("grant_alert_access", { count: 1, target: source });
  }

  // Workflows and files from the clone.
  if (supplyChain === null) {
    if (facts.supplyChainMissing === "analysis_off") add("turn_on_code_analysis", { count: 1 });
  } else {
    const found = supplyChainFound(supplyChain, facts.owner, posture, facts.acceptances);
    const { facts: clone } = supplyChain;
    const perWorkflow = (kind: SecurityActionKind, band: Band | null, list: readonly WorkflowFinding[]) => {
      for (const [file, findings] of byFile(list)) {
        add(kind, {
          band,
          count: findings.length,
          target: file,
          refs: findings.slice(0, MAX_REFS).map((f) => findingRef(f, link)),
        });
      }
    };
    perWorkflow("fix_pr_head_checkout", "low", found.prHeadCheckout);
    perWorkflow("fix_script_injection", "low", found.scriptInjection);
    perWorkflow("stop_self_hosted_public", "low", found.selfHostedPublic ?? []);
    for (const [file, uses] of byFile(found.thirdPartyUnpinned)) {
      add("pin_actions", {
        band: "high",
        count: uses.length,
        target: file,
        refs: uses.slice(0, MAX_REFS).map((u) => useRef(u, link)),
      });
    }
    perWorkflow("restrict_permissions", "high", found.permissions);
    perWorkflow("remove_unsecure_commands", "high", found.unsecureCommands);
    if (found.strongKeys.length > 0) {
      add("remove_key_files", {
        band: "high",
        count: found.strongKeys.length,
        refs: found.strongKeys.slice(0, MAX_REFS).map((k) => pathRef(k.path, link)),
      });
    }

    const advise = (kind: SecurityActionKind, count: number, refs: Ref[] = [], target: string | null = null) => {
      if (count > 0) add(kind, { count, refs: refs.slice(0, MAX_REFS), target });
    };
    advise(
      "pin_own_actions",
      found.ownUnpinned.length,
      found.ownUnpinned.map((u) => useRef(u, link)),
    );
    if (found.absence.updateConfig === "open" && (manifests > 0 || clone.ecosystems.length > 0)) advise("add_update_config", 1);
    advise(
      "add_lockfile",
      found.missingLockfiles.length,
      found.missingLockfiles.map((path) => pathRef(path, link)),
    );
    if (found.absence.securityPolicy === "open") advise("add_security_policy", 1);
    advise(
      "review_weak_key_files",
      found.weakKeys.length,
      found.weakKeys.map((k) => pathRef(k.path, link)),
    );
    if (found.absence.dependencyReview === "open") advise("add_dependency_review", 1);
    if (found.absence.secretScanInCi === "open" && !isUsable(sources.secret_scanning)) advise("add_secret_scanner_ci", 1);
    if (found.absence.staticAnalysis === "open" && !isUsable(sources.code_scanning)) advise("add_static_analysis", 1);
    advise("avoid_curl_pipe_shell", found.curlPipeShell.length + found.images.curlPipeShell.length, [
      ...found.curlPipeShell.map((f) => findingRef(f, link)),
      ...found.images.curlPipeShell.map((d) => pathRef(d.path, link)),
    ]);
    advise(
      "avoid_secrets_inherit",
      found.secretsInherit.length,
      found.secretsInherit.map((f) => findingRef(f, link)),
    );
    advise(
      "disable_persist_credentials",
      found.persistCredentials.length,
      found.persistCredentials.map((f) => findingRef(f, link)),
    );
    const images = (kind: SecurityActionKind, list: readonly DockerfileFacts[], pick: (d: DockerfileFacts) => number) => {
      advise(
        kind,
        list.reduce((total, d) => total + pick(d), 0),
        list.map((d) => pathRef(d.path, link)),
      );
    };
    images("pin_base_images", found.images.unpinned, (d) => d.unpinnedImages);
    images("avoid_latest_images", found.images.latest, (d) => d.latestImages);
    images("run_as_non_root", found.images.root, (d) => Number(d.runsAsRoot));
    images("avoid_remote_add", found.images.remoteAdd, (d) => Number(d.addsRemote));
  }

  // Change control and settings.
  if (posture !== null) {
    const branch = branchState(posture);
    const name = posture.branch.name;
    if (branch.unprotected) add("protect_branch", { band: "high", count: 1, target: name });
    if (branch.forcePushAllowed) add("block_force_push", { band: "high", count: 1, target: name });
    if (branch.read && branch.enforced) {
      const { rules } = posture.branch;
      const note = (kind: SecurityActionKind, on: boolean) => on && add(kind, { count: 1, target: name });
      note("require_status_checks", rules.requireStatusChecks === false);
      note("require_signed_commits", rules.requireSignedCommits === false);
    }
    const { settings, advisories } = posture;
    if (settings.dependabotSecurityUpdates === false) add("enable_security_updates", { count: 1 });
    if (settings.pushProtection === false) add("enable_push_protection", { count: 1 });
    if (settings.privateVulnerabilityReporting === false) add("enable_private_reporting", { count: 1 });
    if (advisories !== null && advisories.triage + advisories.draft > 0) {
      add("triage_advisories", { count: advisories.triage + advisories.draft });
    }
  }
  if (staleUpdates > 0) add("merge_dependency_updates", { count: staleUpdates });

  const ranked = entries
    .map(({ action, members }) => ({ action: finish(action, overall), members }))
    .sort(
      (x, y) =>
        Number(y.action.onPath) - Number(x.action.onPath) ||
        (x.action.band === null ? 4 : BAND_RANK[x.action.band]) - (y.action.band === null ? 4 : BAND_RANK[y.action.band]) ||
        (x.action.severity === null ? 9 : SEVERITY_RANK[x.action.severity]) -
          (y.action.severity === null ? 9 : SEVERITY_RANK[y.action.severity]) ||
        Number(y.action.likelyExploited) - Number(x.action.likelyExploited) ||
        y.action.count - x.action.count ||
        KIND_RANK[x.action.kind] - KIND_RANK[y.action.kind] ||
        compareText(x.action.target ?? "", y.action.target ?? ""),
    );
  const onPathAlerts: SecurityAlert[] = [];
  for (const { action, members } of ranked) if (action.onPath) for (const used of members) onPathAlerts.push(used.alert);
  return { actions: ranked.map(({ action }) => action), onPathAlerts };
}
