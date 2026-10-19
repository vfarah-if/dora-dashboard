import type { Band } from "./dora.js";
import { instant, rangeOf, sinceCreated, type RangeOptions } from "./delivery.js";
import { classifyIssue } from "./issueLabels.js";
import { isUpdateBot } from "./pullRequests.js";
import { cwesOf, epssOf, isLikelyExploited, lastGoodRead, severityOf, usedSources } from "./securityAlerts.js";
import { ABSENT, acceptanceViews, fingerprintOf, type Subject } from "./securityAcceptance.js";
import { STALE_UPDATE_DAYS, compareAlerts, groupDependencies, securityPlan, type FileLink } from "./securityAdvice.js";
import {
  fixWithinDays,
  gradeSecurity,
  gradedAlerts,
  raisedBand,
  supplyChainFound,
  unmeasuredOf,
  usedAlerts,
  type AbsenceCheck,
  type SecurityFacts,
  type SupplyChainOutcome,
} from "./securityGrade.js";
import {
  ALERT_SOURCES,
  FIX_WITHIN_DAYS,
  GRADED_SUPPLY_CHAIN_CHECKS,
  LIKELY_EXPLOITED_EPSS,
  SEVERITIES,
  type AlertSource,
  type AlertWhere,
  type CloseReason,
  type DependencyUpdates,
  type FindingAcceptance,
  type HeldPosture,
  type ReadFailure,
  type RepoPosture,
  type ScorecardState,
  type SecurityAlert,
  type ActionUse,
  type DockerfileFacts,
  type KeyFile,
  type SecurityAlertRef,
  type SecurityIssues,
  type SecurityReport,
  type SecuritySummary,
  type SecurityThresholds,
  type Severity,
  type SourceState,
  type SupplyChainCheckId,
  type SupplyChainItem,
  type SupplyChainLine,
  type SupplyChainRecord,
  type WorkflowFinding,
} from "./securityTypes.js";
import { DAY_MS, WEEK_MS, compareText, summarise, weekRange, weekStart } from "./stats.js";
import type { CrawlStatus, IssueLabelRules, PullRequest, Repo, RepoIssue } from "./types.js";

/**
 * One repository's security report (ADR 0033), built from what the crawl stored. The grade, the open alerts, the
 * dependency groups, the checks and the actions describe now; the range sets the weekly rows, the times to fix and
 * the counts of what closed. Nothing here reads a clock, and no login appears in anything it returns.
 */

/** Most items a supply chain line lists; its `total` counts them all. */
export const LINE_ITEM_LIMIT = 50;
/** Most open alerts listed; `openAlertTotal` counts them all. */
export const OPEN_ALERT_LIMIT = 100;
/** Most weaknesses listed. */
export const WEAKNESS_LIMIT = 10;

/** The limits the grade and the advice use, gathered so the page never repeats a number. */
export const SECURITY_THRESHOLDS: SecurityThresholds = {
  fixWithinDays: FIX_WITHIN_DAYS,
  staleUpdateDays: STALE_UPDATE_DAYS,
  likelyExploitedEpss: LIKELY_EXPLOITED_EPSS,
  lowAlertAdviceDays: FIX_WITHIN_DAYS.low,
};

interface SecurityInputFields {
  repo: Pick<Repo, "id" | "owner" | "name" | "deployBranch" | "lastCrawledAt">;
  alerts: readonly SecurityAlert[];
  sources: Record<AlertSource, SourceState>;
  /** Set when the latest inspection of the clone failed; `supplyChain`, if any, is from an earlier one. */
  supplyChainFailure: ReadFailure | null;
  pullRequests: readonly PullRequest[];
  settingsUrl: string;
  /** The posture last read successfully, with when; null until one has been. */
  posture: HeldPosture | null;
  /**
   * Set when the latest posture read failed, with the failure's own scrubbed message or a neutral one; `posture`, if
   * any, is from an earlier read.
   */
  postureFailure: ReadFailure | null;
  scorecard: ScorecardState;
  /** The repository's stored issues, or null when it has none stored (the issue crawl is off or has not run). */
  issues: readonly RepoIssue[] | null;
  /** The repository's own label rules, which decide which issues are security issues. */
  issueLabels?: IssueLabelRules | null;
  /**
   * Builds the link to a file of the clone at the commit it was read from, which the host knows how to spell and core
   * does not. Without it no finding is linked.
   */
  fileUrl?: (commitSha: string, path: string, line: number | null) => string | null;
  /** The findings of the clone a person has accepted. They leave the grade and the advice, and are listed in the report. */
  acceptances?: readonly FindingAcceptance[];
  /** Stored acceptance rows the store could not read and left out of `acceptances`. Defaults to 0. */
  unreadableAcceptances?: number;
}

/** What the report is built from, the stored facts with the supply chain record or the reason there is none. */
export type SecurityInput = SecurityInputFields & SupplyChainOutcome;

/**
 * When an alert is due and the whole days left. The last day reads 0, and a day past reads -1 or lower, so a negative
 * count means exactly what `isPastFix` means: an alert exactly at its limit is not past it.
 */
function fixBy(alert: SecurityAlert, severity: Severity, now: number): Pick<SecurityAlertRef, "fixByAt" | "daysLeft"> {
  const due = instant(alert.createdAt) + fixWithinDays(severity) * DAY_MS;
  return {
    fixByAt: new Date(due).toISOString(),
    daysLeft: now <= due ? Math.floor((due - now) / DAY_MS) : -Math.ceil((now - due) / DAY_MS),
  };
}

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const whereOf = (alert: SecurityAlert): AlertWhere => {
  if (alert.source === "code_scanning")
    return { kind: "code", path: alert.code.path, line: alert.code.line, ruleId: alert.code.ruleId, tool: alert.code.tool };
  if (alert.source === "secret_scanning") return { kind: "secret", type: alert.exposure.type };
  const { ecosystem, name, lockedVersion, manifestPath } = alert.dependency;
  return { kind: "package", ecosystem, name, version: lockedVersion, manifestPath };
};

type Found = ReturnType<typeof supplyChainFound>;

/** The place a subject points at under a check, linked at the commit the clone was read from. */
function itemOf(check: SupplyChainCheckId, subject: Subject, link: FileLink): SupplyChainItem {
  const place = (
    path: string,
    line: number | null,
    detail: string | null,
    risk: SupplyChainItem["risk"] = null,
  ): SupplyChainItem => ({
    path,
    line,
    detail,
    url: link(path, line),
    risk,
    fingerprint: fingerprintOf(subject),
    routes: [],
    routesDropped: 0,
    conditions: [],
    conditionsDropped: 0,
  });
  switch (subject.kind) {
    case "finding": {
      const f = subject.finding;
      return {
        ...place(f.file, f.line, f.evidence, f.risk),
        routes: f.routes ?? [],
        routesDropped: f.routesDropped ?? 0,
        conditions: f.conditions ?? [],
        conditionsDropped: f.conditionsDropped ?? 0,
      };
    }
    case "use": {
      const u = subject.use;
      return place(u.file, u.line, u.ref === null ? u.action : `${u.action}@${u.ref}`);
    }
    case "key":
      return place(subject.key.path, null, null);
    case "image": {
      const d = subject.dockerfile;
      const count = check === "baseImagesPinned" ? d.unpinnedImages : check === "latestImages" ? d.latestImages : null;
      return place(d.path, null, count === null ? null : `${count} of ${d.images}`);
    }
    case "lockfile":
      return place(subject.path, null, null);
    case "absence":
      // An absence has no place; the line carries it, and no view lists it.
      return place("", null, null);
  }
}

function supplyChainLines(
  record: SupplyChainRecord,
  found: Found,
  posture: RepoPosture | null,
  link: FileLink,
): SupplyChainLine[] {
  const { facts } = record;
  type Item = SupplyChainItem;
  const line = (check: SupplyChainCheckId, met: boolean, items: Item[], absence = false): SupplyChainLine => ({
    check,
    met,
    graded: GRADED_SUPPLY_CHAIN_CHECKS.includes(check),
    items: items.slice(0, LINE_ITEM_LIMIT),
    total: items.length,
    accepted: found.acceptedByCheck[check] ?? 0,
    absence: absence ? { fingerprint: ABSENT } : null,
  });
  // A line for something that should not be there is met when it is empty; a line for something that should be
  // there is met when it is, and lists what was found.
  const bad = (check: SupplyChainCheckId, items: Item[]) => line(check, items.length === 0, items);
  const good = (check: AbsenceCheck, items: Item[]) => line(check, items.length > 0, items, found.absence[check] === "open");
  const finding = (check: SupplyChainCheckId, f: WorkflowFinding) => itemOf(check, { kind: "finding", finding: f }, link);
  const use = (check: SupplyChainCheckId, u: ActionUse) => itemOf(check, { kind: "use", use: u }, link);
  const key = (check: SupplyChainCheckId, k: KeyFile) => itemOf(check, { kind: "key", key: k }, link);
  const image = (check: SupplyChainCheckId, d: DockerfileFacts) => itemOf(check, { kind: "image", dockerfile: d }, link);
  const present = (path: string, detail: string | null = null): Item => ({
    path,
    line: null,
    detail,
    url: link(path, null),
    risk: null,
    fingerprint: null,
    routes: [],
    routesDropped: 0,
    conditions: [],
    conditionsDropped: 0,
  });
  const tool = (category: string) =>
    facts.securityTools.filter((t) => t.category === category).map((t) => present(t.file, t.tool));
  return [
    bad(
      "prHeadCheckout",
      found.prHeadCheckout.map((f) => finding("prHeadCheckout", f)),
    ),
    bad(
      "scriptInjection",
      found.scriptInjection.map((f) => finding("scriptInjection", f)),
    ),
    // Left out when the repository's visibility is not known, as the check that grades it is unmeasured.
    ...(found.selfHostedPublic === null
      ? []
      : [
          bad(
            "selfHostedPublic",
            found.selfHostedPublic.map((f) => finding("selfHostedPublic", f)),
          ),
        ]),
    bad(
      "unpinnedActions",
      found.thirdPartyUnpinned.map((u) => use("unpinnedActions", u)),
    ),
    bad(
      "ownActionsUnpinned",
      found.ownUnpinned.map((u) => use("ownActionsUnpinned", u)),
    ),
    bad(
      "workflowPermissions",
      found.permissions.map((f) => finding("workflowPermissions", f)),
    ),
    bad(
      "unsecureCommands",
      found.unsecureCommands.map((f) => finding("unsecureCommands", f)),
    ),
    bad(
      "keyFiles",
      found.strongKeys.map((k) => key("keyFiles", k)),
    ),
    bad(
      "weakKeyFiles",
      found.weakKeys.map((k) => key("weakKeyFiles", k)),
    ),
    bad("curlPipeShell", [
      ...found.curlPipeShell.map((f) => finding("curlPipeShell", f)),
      ...found.images.curlPipeShell.map((d) => image("curlPipeShell", d)),
    ]),
    bad(
      "secretsInherit",
      found.secretsInherit.map((f) => finding("secretsInherit", f)),
    ),
    bad(
      "persistCredentials",
      found.persistCredentials.map((f) => finding("persistCredentials", f)),
    ),
    good("updateConfig", facts.updateConfig === null ? [] : [present(facts.updateConfig)]),
    bad(
      "lockfiles",
      found.missingLockfiles.map((p) => itemOf("lockfiles", { kind: "lockfile", path: p }, link)),
    ),
    // Only a public repository has outside reporters to tell where to send a vulnerability.
    ...(posture?.visibility === "public"
      ? [good("securityPolicy", facts.securityPolicy === null ? [] : [present(facts.securityPolicy)])]
      : []),
    good("dependencyReview", tool("dependency_review")),
    good("secretScanInCi", tool("secret_scan")),
    good("staticAnalysis", tool("sast")),
    bad(
      "baseImagesPinned",
      found.images.unpinned.map((d) => image("baseImagesPinned", d)),
    ),
    bad(
      "latestImages",
      found.images.latest.map((d) => image("latestImages", d)),
    ),
    bad(
      "nonRootImages",
      found.images.root.map((d) => image("nonRootImages", d)),
    ),
    bad(
      "remoteAdd",
      found.images.remoteAdd.map((d) => image("remoteAdd", d)),
    ),
  ];
}

/** The report's supply chain part: what the clone's record shows, or why there is no record. */
function supplyChainOf(
  outcome: SupplyChainOutcome,
  found: Found | null,
  posture: RepoPosture | null,
  link: FileLink,
): SecurityReport["supplyChain"] {
  if (outcome.supplyChain === null || found === null) {
    return { status: "none", reason: outcome.supplyChain === null ? outcome.supplyChainMissing : "not_read" };
  }
  const record = outcome.supplyChain;
  const { facts } = record;
  return {
    status: "ok",
    commitSha: record.commitSha,
    readAt: record.readAt,
    workflowsRead: facts.workflowsRead,
    workflowsUnread: facts.workflowsUnread,
    dockerfilesUnread: facts.dockerfilesUnread,
    dockerfilesUnreadTotal: facts.dockerfilesUnreadTotal,
    findingsDropped: facts.findingsDropped,
    actionsDropped: facts.actionsDropped,
    lines: supplyChainLines(record, found, posture, link),
  };
}

function dependencyUpdates(
  prs: readonly PullRequest[],
  inRange: (iso: string | null) => boolean,
  now: number,
): DependencyUpdates {
  const updates = prs.filter((pr) => isUpdateBot(pr.author));
  const open = updates.filter((pr) => pr.state === "OPEN");
  const merged = updates.filter((pr) => pr.state === "MERGED" && inRange(pr.mergedAt));
  const oldest =
    open.length === 0 ? null : Math.floor(open.reduce((most, pr) => Math.max(most, now - instant(pr.createdAt)), 0) / DAY_MS);
  return {
    openedInRange: updates.filter((pr) => inRange(pr.createdAt)).length,
    mergedInRange: merged.length,
    closedUnmergedInRange: updates.filter((pr) => pr.state === "CLOSED" && pr.mergedAt === null && inRange(pr.closedAt)).length,
    openNow: open.length,
    timeToMerge: summarise(merged.map((pr) => sinceCreated(pr, pr.mergedAt!))),
    oldestOpenDays: oldest === null ? null : Math.max(0, oldest),
  };
}

function securityIssues(
  issues: readonly RepoIssue[] | null,
  rules: IssueLabelRules | null | undefined,
  inRange: (iso: string | null) => boolean,
  now: number,
): SecurityIssues | null {
  if (issues === null || issues.length === 0) return null;
  const security = issues.filter((issue) => classifyIssue(issue, rules).kind === "security");
  const open = security.filter((issue) => issue.state === "open");
  const closed = security.filter(
    (issue) => issue.state === "closed" && issue.closeReason === "completed" && inRange(issue.closedAt),
  );
  return {
    open: open.length,
    oldestOpenDays:
      open.length === 0
        ? null
        : Math.max(0, Math.floor(open.reduce((most, i) => Math.max(most, now - instant(i.createdAt)), 0) / DAY_MS)),
    closedInRange: closed.length,
    timeToClose: summarise(closed.map((issue) => sinceCreated(issue, issue.closedAt!))),
  };
}

/** How many findings acceptances take out of the graded checks and out of the advice. */
function acceptedOf(found: Found | null): { graded: number; advice: number } {
  let graded = 0;
  let advice = 0;
  for (const [check, count] of Object.entries(found?.acceptedByCheck ?? {})) {
    if (GRADED_SUPPLY_CHAIN_CHECKS.includes(check as SupplyChainCheckId)) graded += count;
    else advice += count;
  }
  return { graded, advice };
}

/** The bands as they would be with no acceptance, worked out only when an acceptance matched something. */
function beforeOf(facts: SecurityFacts, found: Found | null): { bandBefore: Band | null; supplyChainBefore: Band | null } {
  if (found === null || found.accepted.length === 0) return { bandBefore: null, supplyChainBefore: null };
  const { grade } = gradeSecurity({ ...facts, acceptances: [] });
  return { bandBefore: grade?.overall.band ?? null, supplyChainBefore: grade?.parts.supplyChain?.band ?? null };
}

export function securityReport(input: SecurityInput, options: RangeOptions): SecurityReport {
  const { repo, sources } = input;
  const posture = input.posture?.value ?? null;
  const now = instant(options.now);
  const graded = gradedAlerts(input.alerts, sources);
  // All time starts at the earliest graded alert or pull request, because dependency updates read
  // pull requests too, so a repository with no alerts still gets its real history rather than a single day.
  const range = rangeOf([...graded, ...input.pullRequests], options);
  const inRange = (iso: string | null) => iso !== null && instant(iso) >= range.start && instant(iso) <= range.end;

  const acceptances = input.acceptances ?? [];
  const facts: SecurityFacts = {
    owner: repo.owner,
    now: options.now,
    crawled: repo.lastCrawledAt !== null,
    alerts: input.alerts,
    sources,
    posture,
    acceptances,
    ...(input.supplyChain === null
      ? { supplyChain: null, supplyChainMissing: input.supplyChainMissing }
      : { supplyChain: input.supplyChain, supplyChainMissing: null }),
  };
  const link: FileLink = (path, line) =>
    input.supplyChain === null || input.fileUrl === undefined ? null : input.fileUrl(input.supplyChain.commitSha, path, line);
  const result = gradeSecurity(facts);
  const found = input.supplyChain === null ? null : supplyChainFound(input.supplyChain, repo.owner, posture, acceptances);
  const staleUpdates = input.pullRequests.filter(
    (pr) => pr.state === "OPEN" && isUpdateBot(pr.author) && now - instant(pr.createdAt) > STALE_UPDATE_DAYS * DAY_MS,
  ).length;
  const { actions, onPathAlerts } = securityPlan({ facts, overall: result.grade?.overall.band ?? null, staleUpdates, link });
  const to = raisedBand(facts, result, onPathAlerts);

  // What is open now.
  const used = usedAlerts(facts);
  const bySeverity = zeroes<Severity>(SEVERITIES);
  const pastFix = zeroes<Severity>(SEVERITIES);
  const bySource = zeroes<AlertSource>(ALERT_SOURCES);
  for (const u of used) {
    bySeverity[u.severity]++;
    bySource[u.alert.source]++;
    if (u.pastFix) pastFix[u.severity]++;
  }
  const openAlerts = [...used]
    .sort(compareAlerts)
    .slice(0, OPEN_ALERT_LIMIT)
    .map(({ alert, severity, ageHours, pastFix: past }): SecurityAlertRef => ({
      ...fixBy(alert, severity, now),
      source: alert.source,
      key: alert.key,
      severity,
      title: alert.title,
      url: alert.url,
      createdAt: alert.createdAt,
      ageHours,
      pastFix: past,
      likelyExploited: isLikelyExploited(alert),
      epss: epssOf(alert),
      cvssScore: alert.source === "dependabot" || alert.source === "osv" ? alert.dependency.cvssScore : null,
      cwes: cwesOf(alert),
      where: whereOf(alert),
    }));

  // What happened in the range. A reopened alert reads as open from its creation, since GitHub keeps no history of it.
  const closedBy = (state: SecurityAlert["state"]) => graded.filter((a) => a.state === state && inRange(a.closedAt));
  const fixed = closedBy("fixed");
  const dismissed = closedBy("dismissed");
  const openAt = (alert: SecurityAlert, ms: number) =>
    instant(alert.createdAt) <= ms && (alert.state === "open" || instant(alert.closedAt) > ms);
  const weeks = weekRange(weekStart(new Date(range.start).toISOString()), weekStart(new Date(range.end).toISOString()));
  const weekly = weeks.map((week) => {
    const weekMs = instant(`${week}T00:00:00Z`);
    const cutoff = Math.min(weekMs + WEEK_MS - 1, range.end);
    const thisWeek = (iso: string | null) => inRange(iso) && weekStart(iso!) === week;
    const openAtEnd = zeroes<Severity>(SEVERITIES);
    let pastFixAtEnd = 0;
    for (const alert of graded) {
      if (!openAt(alert, cutoff)) continue;
      const severity = severityOf(alert)!;
      openAtEnd[severity]++;
      if (cutoff - instant(alert.createdAt) > fixWithinDays(severity) * DAY_MS) pastFixAtEnd++;
    }
    return {
      week,
      partial: weekMs + WEEK_MS > range.end + 1,
      opened: graded.filter((a) => thisWeek(a.createdAt)).length,
      fixed: fixed.filter((a) => thisWeek(a.closedAt)).length,
      dismissed: dismissed.filter((a) => thisWeek(a.closedAt)).length,
      openAtEnd,
      pastFixAtEnd,
    };
  });
  const hours = (alerts: readonly SecurityAlert[]) => alerts.map((a) => sinceCreated(a, a.closedAt!));
  const reasons = new Map<CloseReason | "unspecified", number>();
  for (const alert of dismissed) {
    const reason = alert.closeReason ?? "unspecified";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  const weaknesses = new Map<string, { open: number; fixedInRange: number }>();
  for (const alert of graded) {
    const counts = alert.state === "open" ? "open" : alert.state === "fixed" && inRange(alert.closedAt) ? "fixedInRange" : null;
    if (counts === null) continue;
    for (const cwe of new Set(cwesOf(alert))) {
      const row = weaknesses.get(cwe) ?? { open: 0, fixedInRange: 0 };
      row[counts]++;
      weaknesses.set(cwe, row);
    }
  }

  const onPath = actions.filter((a) => a.onPath).length;
  const record = input.supplyChain;
  return {
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      deployBranch: repo.deployBranch,
      lastCrawledAt: repo.lastCrawledAt,
    },
    range: { from: range.from, to: range.to },
    gradedAt: options.now,
    thresholds: SECURITY_THRESHOLDS,
    settingsUrl: input.settingsUrl,
    sources,
    used: usedSources(sources),
    lastGoodAt: Object.fromEntries(
      ALERT_SOURCES.map((source) => [source, lastGoodRead(sources[source])?.readAt ?? null]),
    ) as SecurityReport["lastGoodAt"],
    supplyChain: supplyChainOf(input, found, posture, link),
    supplyChainFailure: input.supplyChainFailure,
    ecosystems: record?.facts.ecosystems ?? [],
    posture: input.posture,
    postureFailure: input.postureFailure,
    dependabotVersionUpdates: sources.dependabot.status === "off" ? (record?.facts.updateConfig ?? null) : null,
    ...(result.grade === null ? { grade: null, gradeMissing: result.gradeMissing } : { grade: result.grade, gradeMissing: null }),
    checks: result.checks,
    acceptances: acceptanceViews(acceptances, found, (check, subject) => itemOf(check, subject, link)),
    acceptancesUnreadable: input.unreadableAcceptances ?? 0,
    accepted: { ...acceptedOf(found), ...beforeOf(facts, found) },
    raiseGrade: to === null ? null : { to, actions: onPath },
    open: { bySeverity, bySource, pastFix },
    likelyExploitedOpen: used.filter((u) => isLikelyExploited(u.alert)).length,
    weekly,
    timeToFix: summarise(hours(fixed)),
    timeToFixBySeverity: SEVERITIES.map((severity) => ({
      severity,
      summary: summarise(hours(fixed.filter((a) => severityOf(a) === severity))),
    })),
    fixedInRange: fixed.length,
    dismissed: {
      total: dismissed.length,
      byReason: [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || compareText(a.reason, b.reason)),
    },
    pushProtectionBypassedInRange: graded.filter(
      (a) => a.source === "secret_scanning" && a.exposure.pushProtectionBypassed && inRange(a.createdAt),
    ).length,
    weaknesses: [...weaknesses]
      .map(([cwe, counts]) => ({ cwe, ...counts }))
      .sort((a, b) => b.open - a.open || b.fixedInRange - a.fixedInRange || compareText(a.cwe, b.cwe))
      .slice(0, WEAKNESS_LIMIT),
    openAlerts,
    openAlertTotal: used.length,
    dependencyGroups: groupDependencies(used).map(({ members: _members, ...group }) => group),
    dependencyUpdates: dependencyUpdates(input.pullRequests, inRange, now),
    securityIssues: securityIssues(input.issues, input.issueLabels, inRange, now),
    scorecard: input.scorecard,
    actions,
  };
}

/** The list page's row, projected from the report so the two can never disagree. */
export function securitySummary(report: SecurityReport, crawlStatus: CrawlStatus): SecuritySummary {
  const { used, lastGoodAt } = report;
  // Only a source whose alerts are in use can say when the figures were read.
  const readAts = ALERT_SOURCES.flatMap((source) => {
    const at = used[source] ? lastGoodAt[source] : null;
    return at === null ? [] : [at];
  });
  const { scorecard } = report;
  const { id, owner, name, lastCrawledAt } = report.repo;
  const fields: Omit<SecuritySummary, "band" | "limitedBy" | "gradeMissing"> = {
    repo: { id, owner, name, lastCrawledAt, crawlStatus },
    open: report.open.bySeverity,
    pastFix: Object.values(report.open.pastFix).reduce((total, n) => total + n, 0),
    likelyExploited: report.likelyExploitedOpen,
    actions: report.actions.filter((a) => a.band !== null).length,
    raiseGrade: report.raiseGrade,
    accepted: { graded: report.accepted.graded, bandBefore: report.accepted.bandBefore },
    read: ALERT_SOURCES.some((source) => used[source]),
    dependabotVersionUpdates: report.dependabotVersionUpdates,
    unmeasured: unmeasuredOf({
      sources: report.sources,
      hasSupplyChain: report.supplyChain.status === "ok",
      posture: report.posture?.value ?? null,
    }),
    sources: Object.fromEntries(
      ALERT_SOURCES.map((source) => [source, report.sources[source].status]),
    ) as SecuritySummary["sources"],
    used,
    supplyChain: report.supplyChain.status === "ok" ? "ok" : report.supplyChain.reason,
    readAt: readAts.length === 0 ? null : readAts.reduce((latest, at) => (instant(at) > instant(latest) ? at : latest)),
    failed:
      ALERT_SOURCES.some((source) => report.sources[source].status === "error") ||
      report.postureFailure !== null ||
      report.supplyChainFailure !== null,
    scorecard:
      scorecard.status === "ok"
        ? scorecard.result.score
        : scorecard.status === "error"
          ? (scorecard.lastGood?.score ?? null)
          : null,
    thresholds: report.thresholds,
    topAction: report.actions[0] ?? null,
  };
  if (report.grade === null) return { ...fields, band: null, limitedBy: null, gradeMissing: report.gradeMissing };
  const { overall } = report.grade;
  return { ...fields, band: overall.band, limitedBy: { part: overall.part, check: overall.check }, gradeMissing: null };
}
