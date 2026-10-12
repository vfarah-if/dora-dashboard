import { instant, rangeOf, sinceCreated, type RangeOptions } from "./delivery.js";
import { classifyIssue } from "./issueLabels.js";
import { isUpdateBot } from "./pullRequests.js";
import { cwesOf, epssOf, isLikelyExploited, lastGoodRead, severityOf, usedSources } from "./securityAlerts.js";
import { STALE_UPDATE_DAYS, compareAlerts, groupDependencies, securityPlan } from "./securityAdvice.js";
import {
  fixWithinDays,
  gradeSecurity,
  gradedAlerts,
  raisedBand,
  supplyChainFound,
  unmeasuredOf,
  usedAlerts,
  type SecurityFacts,
  type SupplyChainOutcome,
} from "./securityGrade.js";
import {
  ALERT_SOURCES,
  FIX_WITHIN_DAYS,
  LIKELY_EXPLOITED_EPSS,
  SEVERITIES,
  type AlertSource,
  type AlertWhere,
  type CloseReason,
  type DependencyUpdates,
  type HeldPosture,
  type ReadFailure,
  type RepoPosture,
  type ScorecardState,
  type SecurityAlert,
  type SecurityAlertRef,
  type SecurityIssues,
  type SecurityReport,
  type SecuritySummary,
  type SecurityThresholds,
  type Severity,
  type SourceState,
  type SupplyChainCheckId,
  type SupplyChainLine,
  type SupplyChainRecord,
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
}

/** What the report is built from, the stored facts with the supply chain record or the reason there is none. */
export type SecurityInput = SecurityInputFields & SupplyChainOutcome;

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const whereOf = (alert: SecurityAlert): AlertWhere => {
  if (alert.source === "code_scanning")
    return { kind: "code", path: alert.code.path, line: alert.code.line, ruleId: alert.code.ruleId };
  if (alert.source === "secret_scanning") return { kind: "secret", type: alert.exposure.type };
  const { ecosystem, name, lockedVersion, manifestPath } = alert.dependency;
  return { kind: "package", ecosystem, name, version: lockedVersion, manifestPath };
};

type Item = SupplyChainLine["items"][number];

function supplyChainLines(
  record: SupplyChainRecord,
  found: ReturnType<typeof supplyChainFound>,
  posture: RepoPosture | null,
): SupplyChainLine[] {
  const { facts } = record;
  const line = (check: SupplyChainCheckId, graded: boolean, met: boolean, items: Item[]): SupplyChainLine => ({
    check,
    met,
    graded,
    items: items.slice(0, LINE_ITEM_LIMIT),
    total: items.length,
  });
  // A line for something that should not be there is met when it is empty; a line for something that should be
  // there is met when it is, and lists what was found.
  const bad = (check: SupplyChainCheckId, graded: boolean, items: Item[]) => line(check, graded, items.length === 0, items);
  const good = (check: SupplyChainCheckId, items: Item[]) => line(check, false, items.length > 0, items);
  const finding = (f: { file: string; line: number | null; evidence: string }): Item => ({
    path: f.file,
    line: f.line,
    detail: f.evidence,
  });
  const use = (u: { file: string; line: number; action: string; ref: string | null }): Item => ({
    path: u.file,
    line: u.line,
    detail: u.ref === null ? u.action : `${u.action}@${u.ref}`,
  });
  const path = (p: string): Item => ({ path: p, line: null, detail: null });
  const tool = (category: string) =>
    facts.securityTools.filter((t) => t.category === category).map((t): Item => ({ path: t.file, line: null, detail: t.tool }));
  const images = (
    pick: (d: (typeof facts.dockerfiles)[number]) => boolean,
    detail: (d: (typeof facts.dockerfiles)[number]) => string | null,
  ) => facts.dockerfiles.filter(pick).map((d): Item => ({ path: d.path, line: null, detail: detail(d) }));
  return [
    bad("prHeadCheckout", true, found.prHeadCheckout.map(finding)),
    bad("scriptInjection", true, found.scriptInjection.map(finding)),
    // Left out when the repository's visibility is not known, as the check that grades it is unmeasured.
    ...(found.selfHostedPublic === null ? [] : [bad("selfHostedPublic", true, found.selfHostedPublic.map(finding))]),
    bad("unpinnedActions", true, found.thirdPartyUnpinned.map(use)),
    bad("ownActionsUnpinned", false, found.ownUnpinned.map(use)),
    bad("workflowPermissions", true, found.permissions.map(finding)),
    bad("unsecureCommands", true, found.unsecureCommands.map(finding)),
    bad(
      "keyFiles",
      true,
      found.strongKeys.map((k) => path(k.path)),
    ),
    bad(
      "weakKeyFiles",
      false,
      found.weakKeys.map((k) => path(k.path)),
    ),
    bad("curlPipeShell", false, [
      ...found.curlPipeShell.map(finding),
      ...images(
        (d) => d.curlPipeShell,
        () => null,
      ),
    ]),
    bad("secretsInherit", false, found.secretsInherit.map(finding)),
    bad("persistCredentials", false, found.persistCredentials.map(finding)),
    good("updateConfig", facts.updateConfig === null ? [] : [path(facts.updateConfig)]),
    bad("lockfiles", false, facts.missingLockfiles.map(path)),
    // Only a public repository has outside reporters to tell where to send a vulnerability.
    ...(posture?.visibility === "public"
      ? [good("securityPolicy", facts.securityPolicy === null ? [] : [path(facts.securityPolicy)])]
      : []),
    good("dependencyReview", tool("dependency_review")),
    good("secretScanInCi", tool("secret_scan")),
    good("staticAnalysis", tool("sast")),
    bad(
      "baseImagesPinned",
      false,
      images(
        (d) => d.unpinnedImages > 0,
        (d) => `${d.unpinnedImages} of ${d.images}`,
      ),
    ),
    bad(
      "latestImages",
      false,
      images(
        (d) => d.latestImages > 0,
        (d) => `${d.latestImages} of ${d.images}`,
      ),
    ),
    bad(
      "nonRootImages",
      false,
      images(
        (d) => d.runsAsRoot,
        () => null,
      ),
    ),
    bad(
      "remoteAdd",
      false,
      images(
        (d) => d.addsRemote,
        () => null,
      ),
    ),
  ];
}

/** The report's supply chain part: what the clone's record shows, or why there is no record. */
function supplyChainOf(outcome: SupplyChainOutcome, owner: string, posture: RepoPosture | null): SecurityReport["supplyChain"] {
  if (outcome.supplyChain === null) return { status: "none", reason: outcome.supplyChainMissing };
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
    lines: supplyChainLines(record, supplyChainFound(record, owner, posture), posture),
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

export function securityReport(input: SecurityInput, options: RangeOptions): SecurityReport {
  const { repo, sources } = input;
  const posture = input.posture?.value ?? null;
  const now = instant(options.now);
  const graded = gradedAlerts(input.alerts, sources);
  // All time starts at the earliest graded alert or pull request, because dependency updates read
  // pull requests too, so a repository with no alerts still gets its real history rather than a single day.
  const range = rangeOf([...graded, ...input.pullRequests], options);
  const inRange = (iso: string | null) => iso !== null && instant(iso) >= range.start && instant(iso) <= range.end;

  const facts: SecurityFacts = {
    owner: repo.owner,
    now: options.now,
    crawled: repo.lastCrawledAt !== null,
    alerts: input.alerts,
    sources,
    posture,
    ...(input.supplyChain === null
      ? { supplyChain: null, supplyChainMissing: input.supplyChainMissing }
      : { supplyChain: input.supplyChain, supplyChainMissing: null }),
  };
  const result = gradeSecurity(facts);
  const staleUpdates = input.pullRequests.filter(
    (pr) => pr.state === "OPEN" && isUpdateBot(pr.author) && now - instant(pr.createdAt) > STALE_UPDATE_DAYS * DAY_MS,
  ).length;
  const { actions, onPathAlerts } = securityPlan({ facts, overall: result.grade?.overall.band ?? null, staleUpdates });
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
    supplyChain: supplyChainOf(input, repo.owner, posture),
    supplyChainFailure: input.supplyChainFailure,
    ecosystems: record?.facts.ecosystems ?? [],
    posture: input.posture,
    postureFailure: input.postureFailure,
    dependabotVersionUpdates: sources.dependabot.status === "off" ? (record?.facts.updateConfig ?? null) : null,
    ...(result.grade === null ? { grade: null, gradeMissing: result.gradeMissing } : { grade: result.grade, gradeMissing: null }),
    checks: result.checks,
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
