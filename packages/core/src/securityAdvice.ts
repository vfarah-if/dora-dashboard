import { BAND_RANK, type Band } from "./dora.js";
import { SEVERITY_RANK, isLikelyExploited, isUsable, worseSeverity } from "./securityAlerts.js";
import { compareText } from "./stats.js";
import {
  UNAPPROVED_LIMITS,
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
  SECURITY_ACTION_KINDS,
  type ActionUse,
  type DependencyAlert,
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
}

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

/**
 * Open dependency alerts grouped by package and manifest, worst first. One package locked at two versions in two
 * manifests is two groups, because a fix that suits `1.x` is not the fix for `2.x`.
 */
export function groupDependencies(usedList: readonly UsedAlert[]): DependencyGroupDetail[] {
  const groups = new Map<string, { used: UsedAlert; dependency: DependencyAlert["dependency"] }[]>();
  for (const used of usedList) {
    if (used.alert.source !== "dependabot" && used.alert.source !== "osv") continue;
    const { dependency } = used.alert;
    const key = `${dependency.ecosystem}\u0000${dependency.name}\u0000${dependency.manifestPath}`;
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
        compareText(a.name, b.name) ||
        compareText(a.ecosystem, b.ecosystem) ||
        compareText(a.manifestPath, b.manifestPath),
    );
}

type Ref = SecurityAction["refs"][number];

const refOfAlert = ({ alert }: UsedAlert): Ref => {
  if (alert.source === "code_scanning") {
    const { path, line, ruleId } = alert.code;
    return { label: path === null ? ruleId : line === null ? path : `${path}:${line}`, url: alert.url };
  }
  if (alert.source === "secret_scanning") return { label: alert.title, url: alert.url };
  const { name, lockedVersion, advisoryId } = alert.dependency;
  return { label: `${name}${lockedVersion === null ? "" : `@${lockedVersion}`} (${advisoryId})`, url: alert.url };
};

const alertRefs = (members: readonly UsedAlert[]): Ref[] => [...members].sort(compareAlerts).slice(0, MAX_REFS).map(refOfAlert);

const findingRef = (f: WorkflowFinding): Ref => ({ label: f.line === null ? f.file : `${f.file}:${f.line}`, url: null });
const useRef = (u: ActionUse): Ref => ({ label: `${u.action}${u.ref === null ? "" : `@${u.ref}`}`, url: null });

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

const blank = (kind: SecurityActionKind): SecurityAction => ({
  kind,
  band: null,
  onPath: false,
  severity: null,
  count: 0,
  target: null,
  upgradeTo: null,
  ecosystem: null,
  manifestPath: null,
  relationship: null,
  likelyExploited: false,
  refs: [],
});

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
 * which can be more than the alerts that feed the limiting checks, since upgrading a package fixes all its alerts.
 */
export function securityPlan({ facts, overall, staleUpdates }: AdviceInput): {
  actions: SecurityAction[];
  onPathAlerts: SecurityAlert[];
} {
  const entries: { action: SecurityAction; members: readonly UsedAlert[] }[] = [];
  const add = (kind: SecurityActionKind, fields: Partial<SecurityAction>, members: readonly UsedAlert[] = []) => {
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
    add(
      group.patchedVersions.length > 0 ? "upgrade_dependency" : "replace_dependency",
      {
        band: lowest(group.members.map(bandOfAlert)),
        severity: group.worstSeverity,
        count: group.alerts,
        target: `${group.ecosystem}:${group.name}`,
        upgradeTo: group.upgradeTo,
        ecosystem: group.ecosystem,
        manifestPath: group.manifestPath,
        relationship: group.relationship,
        likelyExploited: group.likelyExploited,
        refs: alertRefs(group.members),
      },
      group.members,
    );
  }
  const rules = new Map<string, UsedAlert[]>();
  for (const u of open) {
    if (u.alert.source !== "code_scanning") continue;
    rules.set(u.alert.code.ruleId, [...(rules.get(u.alert.code.ruleId) ?? []), u]);
  }
  for (const [ruleId, members] of rules) {
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
    if (sources[source].status === "no_access" && sources[source].reason === "forbidden")
      add("grant_alert_access", { count: 1, target: source });
  }

  // Workflows and files from the clone.
  if (supplyChain === null) {
    if (facts.supplyChainMissing === "analysis_off") add("turn_on_code_analysis", { count: 1 });
  } else {
    const found = supplyChainFound(supplyChain, facts.owner, posture);
    const { facts: clone } = supplyChain;
    const perWorkflow = (kind: SecurityActionKind, band: Band | null, list: readonly WorkflowFinding[]) => {
      for (const [file, findings] of byFile(list)) {
        add(kind, { band, count: findings.length, target: file, refs: findings.slice(0, MAX_REFS).map(findingRef) });
      }
    };
    perWorkflow("fix_pr_head_checkout", "low", found.prHeadCheckout);
    perWorkflow("fix_script_injection", "low", found.scriptInjection);
    perWorkflow("stop_self_hosted_public", "low", found.selfHostedPublic);
    for (const [file, uses] of byFile(found.thirdPartyUnpinned)) {
      add("pin_actions", { band: "high", count: uses.length, target: file, refs: uses.slice(0, MAX_REFS).map(useRef) });
    }
    perWorkflow("restrict_permissions", "high", found.permissions);
    perWorkflow("remove_unsecure_commands", "high", found.unsecureCommands);
    if (found.strongKeys.length > 0) {
      add("remove_key_files", {
        band: "high",
        count: found.strongKeys.length,
        refs: found.strongKeys.slice(0, MAX_REFS).map((k) => ({ label: k.path, url: null })),
      });
    }

    const advise = (kind: SecurityActionKind, count: number, refs: Ref[] = [], target: string | null = null) => {
      if (count > 0) add(kind, { count, refs: refs.slice(0, MAX_REFS), target });
    };
    advise("pin_own_actions", found.ownUnpinned.length, found.ownUnpinned.map(useRef));
    if (clone.updateConfig === null && (manifests > 0 || clone.ecosystems.length > 0)) advise("add_update_config", 1);
    advise(
      "add_lockfile",
      clone.missingLockfiles.length,
      clone.missingLockfiles.map((path) => ({ label: path, url: null })),
    );
    if (clone.securityPolicy === null) advise("add_security_policy", 1);
    if (clone.codeowners === null) advise("add_codeowners", 1);
    advise(
      "review_weak_key_files",
      found.weakKeys.length,
      found.weakKeys.map((k) => ({ label: k.path, url: null })),
    );
    const hasTool = (category: string) => clone.securityTools.some((t) => t.category === category);
    if (!hasTool("dependency_review")) advise("add_dependency_review", 1);
    if (!hasTool("secret_scan") && !isUsable(sources.secret_scanning)) advise("add_secret_scanner_ci", 1);
    if (!hasTool("sast") && !isUsable(sources.code_scanning)) advise("add_static_analysis", 1);
    const shellDockerfiles = clone.dockerfiles.filter((d) => d.curlPipeShell);
    advise("avoid_curl_pipe_shell", found.curlPipeShell.length + shellDockerfiles.length, [
      ...found.curlPipeShell.map(findingRef),
      ...shellDockerfiles.map((d) => ({ label: d.path, url: null })),
    ]);
    advise("avoid_secrets_inherit", found.secretsInherit.length, found.secretsInherit.map(findingRef));
    advise("disable_persist_credentials", found.persistCredentials.length, found.persistCredentials.map(findingRef));
    const images = (kind: SecurityActionKind, pick: (d: (typeof clone.dockerfiles)[number]) => number) => {
      const list = clone.dockerfiles.filter((d) => pick(d) > 0);
      advise(
        kind,
        list.reduce((total, d) => total + pick(d), 0),
        list.map((d) => ({ label: d.path, url: null })),
      );
    };
    images("pin_base_images", (d) => d.unpinnedImages);
    images("avoid_latest_images", (d) => d.latestImages);
    images("run_as_non_root", (d) => Number(d.runsAsRoot));
    images("avoid_remote_add", (d) => Number(d.addsRemote));
  }

  // Change control and settings.
  const { review } = facts;
  if (review.graded && (review.share ?? 0) > UNAPPROVED_LIMITS.elite) {
    add("require_review", {
      band: (review.share ?? 0) <= UNAPPROVED_LIMITS.high ? "high" : "medium",
      count: review.unapproved,
    });
  }
  if (posture !== null) {
    const branch = branchState(posture);
    const name = posture.branch.name;
    if (branch.unprotected) add("protect_branch", { band: "high", count: 1, target: name });
    if (branch.forcePushAllowed) add("block_force_push", { band: "high", count: 1, target: name });
    if (branch.read && branch.enforced) {
      const { rules } = posture.branch;
      const note = (kind: SecurityActionKind, on: boolean) => on && add(kind, { count: 1, target: name });
      note("require_approvals", rules.requirePullRequest === false || rules.requiredApprovals === 0);
      note("require_status_checks", rules.requireStatusChecks === false);
      note("dismiss_stale_reviews", rules.dismissStaleReviews === false && rules.requirePullRequest !== false);
      note("require_code_owner_review", rules.requireCodeOwnerReview === false && supplyChain?.facts.codeowners != null);
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
    .map(({ action, members }) => ({ action: { ...action, onPath: overall !== null && action.band === overall }, members }))
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
