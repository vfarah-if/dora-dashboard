import { instant, rangeOf, sinceCreated, type RangeOptions } from "./delivery.js";
import { classifyIssue } from "./issueLabels.js";
import { isUpdateBot } from "./pullRequests.js";
import { cwesOf, epssOf, isLikelyExploited, severityOf } from "./securityAlerts.js";
import { STALE_UPDATE_DAYS, compareAlerts, groupDependencies, securityPlan } from "./securityAdvice.js";
import {
  UNAPPROVED_LIMITS,
  fixWithinDays,
  gradeSecurity,
  gradedAlerts,
  raisedBand,
  supplyChainFound,
  unmeasuredOf,
  usedAlerts,
  type SecurityFacts,
} from "./securityGrade.js";
import { reviewControls } from "./reviewControls.js";
import {
  ALERT_SOURCES,
  FIX_WITHIN_DAYS,
  LIKELY_EXPLOITED_EPSS,
  REVIEW_MIN_MERGED,
  REVIEW_WINDOW_DAYS,
  SEVERITIES,
  type AlertSource,
  type AlertWhere,
  type DependencyUpdates,
  type RepoPosture,
  type ScorecardResult,
  type ScorecardStatus,
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
  reviewWindowDays: REVIEW_WINDOW_DAYS,
  reviewMinMerged: REVIEW_MIN_MERGED,
  staleUpdateDays: STALE_UPDATE_DAYS,
  likelyExploitedEpss: LIKELY_EXPLOITED_EPSS,
  unapprovedLimits: { elite: UNAPPROVED_LIMITS.elite, high: UNAPPROVED_LIMITS.high },
  lowAlertAdviceDays: FIX_WITHIN_DAYS.low,
};

export interface SecurityInput {
  repo: Pick<Repo, "id" | "owner" | "name" | "deployBranch" | "lastCrawledAt">;
  alerts: readonly SecurityAlert[];
  sources: Record<AlertSource, SourceState>;
  supplyChain: SupplyChainRecord | null;
  /** Why there is no supply chain record: code analysis is off, or it has not been read yet. */
  supplyChainMissing: "analysis_off" | "not_read" | null;
  pullRequests: readonly PullRequest[];
  settingsUrl: string;
  /** Null until the repository's posture has been read. */
  posture: RepoPosture | null;
  postureReadAt: string | null;
  /** A neutral message when the last posture read failed, else null. */
  postureError: string | null;
  scorecard: ScorecardResult | null;
  scorecardStatus: ScorecardStatus;
  /** The repository's stored issues, or null when it has none stored (the issue crawl is off or has not run). */
  issues: readonly RepoIssue[] | null;
  /** The repository's own label rules, which decide which issues are security issues. */
  issueLabels?: IssueLabelRules | null;
}

const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const whereOf = (alert: SecurityAlert): AlertWhere => {
  if (alert.source === "code_scanning")
    return { kind: "code", path: alert.code.path, line: alert.code.line, ruleId: alert.code.ruleId };
  if (alert.source === "secret_scanning") return { kind: "secret", type: alert.exposure.type };
  const { ecosystem, name, lockedVersion, manifestPath } = alert.dependency;
  return { kind: "package", ecosystem, name, version: lockedVersion, manifestPath };
};

type Item = SupplyChainLine["items"][number];

function supplyChainLines(record: SupplyChainRecord, found: ReturnType<typeof supplyChainFound>): SupplyChainLine[] {
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
    bad("selfHostedPublic", true, found.selfHostedPublic.map(finding)),
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
    good("securityPolicy", facts.securityPolicy === null ? [] : [path(facts.securityPolicy)]),
    good("codeowners", facts.codeowners === null ? [] : [path(facts.codeowners)]),
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
  const now = instant(options.now);
  const graded = gradedAlerts(input.alerts, sources);
  // All time starts at the earliest graded alert or pull request, because review controls and dependency updates read
  // pull requests too, so a repository with no alerts still gets its real history rather than a single day.
  const range = rangeOf([...graded, ...input.pullRequests], options);
  const inRange = (iso: string | null) => iso !== null && instant(iso) >= range.start && instant(iso) <= range.end;

  const review = reviewControls(input.pullRequests, {
    from: new Date(now - REVIEW_WINDOW_DAYS * DAY_MS).toISOString(),
    to: options.now,
    deployBranch: repo.deployBranch,
    now: options.now,
  });
  const reviewInRange = reviewControls(input.pullRequests, {
    from: `${range.from}T00:00:00.000Z`,
    to: new Date(range.end).toISOString(),
    deployBranch: repo.deployBranch,
    now: options.now,
  });

  const facts: SecurityFacts = {
    owner: repo.owner,
    now: options.now,
    crawled: repo.lastCrawledAt !== null,
    alerts: input.alerts,
    sources,
    supplyChain: input.supplyChain,
    supplyChainMissing: input.supplyChainMissing,
    review,
    posture: input.posture,
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
    instant(alert.createdAt) <= ms && !(alert.state !== "open" && alert.closedAt !== null && instant(alert.closedAt) <= ms);
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
  const reasons = new Map<string, number>();
  for (const alert of dismissed)
    reasons.set(alert.closeReason ?? "unspecified", (reasons.get(alert.closeReason ?? "unspecified") ?? 0) + 1);

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
    repo: { id: repo.id, owner: repo.owner, name: repo.name, lastCrawledAt: repo.lastCrawledAt },
    range: { from: range.from, to: range.to },
    gradedAt: options.now,
    fixWithinDays: FIX_WITHIN_DAYS,
    reviewMinMerged: REVIEW_MIN_MERGED,
    likelyExploitedEpss: LIKELY_EXPLOITED_EPSS,
    thresholds: SECURITY_THRESHOLDS,
    settingsUrl: input.settingsUrl,
    sources,
    supplyChain: record
      ? {
          status: "ok",
          commitSha: record.commitSha,
          readAt: record.readAt,
          workflowsRead: record.facts.workflowsRead,
          workflowsUnread: record.facts.workflowsUnread,
          dockerfilesUnread: record.facts.dockerfilesUnread,
          dockerfilesUnreadTotal: record.facts.dockerfilesUnreadTotal,
          lines: supplyChainLines(record, supplyChainFound(record, repo.owner, input.posture)),
        }
      : { status: "none", reason: input.supplyChainMissing ?? "not_read" },
    ecosystems: record?.facts.ecosystems ?? [],
    posture: input.posture,
    postureReadAt: input.postureReadAt,
    postureError: input.postureError,
    dependabotVersionUpdates: sources.dependabot.status === "off" ? (record?.facts.updateConfig ?? null) : null,
    grade: result.grade,
    gradeMissing: result.gradeMissing,
    checks: result.checks,
    raiseGrade: to === null ? null : { to, actions: onPath },
    open: { total: used.length, bySeverity, bySource, pastFix },
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
    review,
    reviewInRange,
    dependencyUpdates: dependencyUpdates(input.pullRequests, inRange, now),
    securityIssues: securityIssues(input.issues, input.issueLabels, inRange, now),
    scorecard: input.scorecard,
    scorecardStatus: input.scorecardStatus,
    actions,
  };
}

/** The list page's row, projected from the report so the two can never disagree. */
export function securitySummary(report: SecurityReport, crawlStatus: CrawlStatus): SecuritySummary {
  const readAts = ALERT_SOURCES.flatMap((source) =>
    report.sources[source].readAt === null ? [] : [report.sources[source].readAt],
  );
  return {
    repo: { ...report.repo, crawlStatus },
    band: report.grade?.overall.band ?? null,
    limitedBy: report.grade ? { part: report.grade.overall.part, check: report.grade.overall.check } : null,
    gradeMissing: report.gradeMissing,
    open: report.open.bySeverity,
    pastFix: Object.values(report.open.pastFix).reduce((total, n) => total + n, 0),
    likelyExploited: report.likelyExploitedOpen,
    actions: report.actions.filter((a) => a.band !== null).length,
    raiseGrade: report.raiseGrade,
    read: ALERT_SOURCES.some((source) => report.sources[source].status !== "not_read"),
    dependabotVersionUpdates: report.dependabotVersionUpdates,
    unmeasured: unmeasuredOf({
      sources: report.sources,
      hasSupplyChain: report.supplyChain.status === "ok",
      review: report.review,
      posture: report.posture,
    }),
    sources: Object.fromEntries(
      ALERT_SOURCES.map((source) => [source, report.sources[source].status]),
    ) as SecuritySummary["sources"],
    supplyChain: report.supplyChain.status === "ok" ? "ok" : report.supplyChain.reason,
    readAt: readAts.length === 0 ? null : readAts.reduce((latest, at) => (instant(at) > instant(latest) ? at : latest)),
    failed: ALERT_SOURCES.some((source) => report.sources[source].status === "error"),
    scorecard: report.scorecard?.score ?? null,
    thresholds: report.thresholds,
    topAction: report.actions[0] ?? null,
  };
}
