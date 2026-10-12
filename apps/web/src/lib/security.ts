import type {
  AlertSource,
  AlertWhere,
  Band,
  BranchRules,
  RepoPosture,
  SecurityAction,
  SecurityActionKind,
  SecurityAlertRef,
  SecurityCheck,
  SecurityCheckName,
  SecurityMeasure,
  SecurityPartName,
  SecurityReport,
  SecuritySummary,
  Severity,
  SourceState,
  SourceStatus,
  SecurityThresholds,
  SupplyChainCheckId,
  SupplyChainLine,
} from "@dora-dashboard/core";
import { copy, type ActionFacts } from "../copy";
import { formatDate, formatDateTime, formatPercent, formatWeek } from "./format";
import { shortSha } from "./codeHealth";
import type { PartWeek } from "./weekly";

/*
 * Core decides every figure, band and ranking. This module chooses which of them to show, in what order, and which
 * sentence from copy.ts describes each one. Each Record below names every member of a union that core owns, so the
 * compiler refuses to build when core adds a kind, a check or a source that has no wording here yet.
 */

/** The keys of a record that names every member of `K`, in the order written. */
const keysOf = <K extends string>(record: Record<K, true>): readonly K[] => Object.keys(record) as K[];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
export const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const listFormat = new Intl.ListFormat("en-GB", { type: "conjunction" });
export const joinWords = (words: readonly string[]) => listFormat.format(words);

// --- Severity ---------------------------------------------------------------------------------------------------

/** Most severe first, as core orders them. */
export const SEVERITIES = keysOf<Severity>({ critical: true, high: true, medium: true, low: true, unknown: true });

export const ALERT_SOURCES = keysOf<AlertSource>({ dependabot: true, code_scanning: true, secret_scanning: true, osv: true });

/**
 * Severities sit on the stage ramp, which runs from the strongest to the palest tone in both themes, and an unrated
 * alert on the neutral column colour. Band colours are reserved for the grade, so a severity never borrows one.
 */
export const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: "var(--stage-1)",
  high: "var(--stage-2)",
  medium: "var(--stage-3)",
  low: "var(--stage-4)",
  unknown: "var(--column-none)",
};

export const severityLabel = (severity: Severity): string => copy.security.severity[severity];
export const severityTileLabel = (severity: Severity): string => copy.security.severityTile[severity];

/** Days an open alert of this severity may wait. An alert without a rating waits as long as a medium one. */
export const fixDays = (severity: Severity, fix: SecurityReport["fixWithinDays"]): number =>
  fix[severity === "unknown" ? "medium" : severity];

export const severityExplanation = (severity: Severity, fix: SecurityReport["fixWithinDays"]): string =>
  copy.security.severityExplain[severity](fixDays(severity, fix));

/** "2 critical, 3 high and 1 not rated", or a sentence saying there is nothing open. */
export function openSummary(open: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((severity) => open[severity] > 0).map(
    (severity) => `${open[severity]} ${severityLabel(severity).toLowerCase()}`,
  );
  return parts.length === 0 ? copy.security.list.noOpen : joinWords(parts);
}

// --- The weekly chart -------------------------------------------------------------------------------------------

export type SeverityWeekRow = {
  week: string;
  partial: boolean;
  opened: number;
  fixed: number;
  dismissed: number;
  pastFixAtEnd: number;
  total: number;
} & Record<Severity, number>;

/** Each week with its open alerts by severity as fields of their own, so a stacked bar can read them. */
export function severityRows(weekly: SecurityReport["weekly"]): SeverityWeekRow[] {
  return weekly.map((w) => ({
    week: w.week,
    partial: w.partial,
    opened: w.opened,
    fixed: w.fixed,
    dismissed: w.dismissed,
    pastFixAtEnd: w.pastFixAtEnd,
    total: SEVERITIES.reduce((sum, severity) => sum + w.openAtEnd[severity], 0),
    ...w.openAtEnd,
  }));
}

export interface SeveritySeries {
  key: Severity;
  label: string;
  colour: string;
}

/** The severities that had an open alert in some week, each with its own fixed colour so a filter never repaints another. */
export function severitySeries(weekly: SecurityReport["weekly"]): SeveritySeries[] {
  return SEVERITIES.filter((severity) => weekly.some((w) => w.openAtEnd[severity] > 0)).map((severity) => ({
    key: severity,
    label: severityLabel(severity),
    colour: SEVERITY_COLOUR[severity],
  }));
}

/** The note above the weekly chart for the week the range ends part way through. */
export function securityPartWeekNote(part: PartWeek): string {
  const week = formatWeek(part.week);
  const text = copy.security.weekly.partWeek;
  return part.current ? text.current(week) : text.cut(week, formatWeek(part.through));
}

// --- Checks and the grade ---------------------------------------------------------------------------------------

const PARTS = keysOf<SecurityPartName>({ vulnerabilities: true, supplyChain: true, changeControl: true });

interface CheckContext {
  check: SecurityCheck;
  good: boolean;
  fix: SecurityReport["fixWithinDays"];
}

const countOf = (c: CheckContext) => c.check.count ?? 0;
const oldestOf = (c: CheckContext) => c.check.oldestDays ?? null;

/** Both wordings of each check, so a check added in core must be given its sentences here before this compiles. */
export const checkSentence: Record<SecurityCheckName, (ctx: CheckContext) => string> = {
  secretExposed: (c) => (c.good ? copy.security.checks.secretExposed.good : copy.security.checks.secretExposed.bad(countOf(c))),
  criticalPastFix: (c) =>
    c.good
      ? copy.security.checks.criticalPastFix.good(c.fix.critical)
      : copy.security.checks.criticalPastFix.bad(countOf(c), c.fix.critical, oldestOf(c)),
  criticalOpen: (c) =>
    c.good ? copy.security.checks.criticalOpen.good : copy.security.checks.criticalOpen.bad(countOf(c), c.fix.critical),
  highPastFix: (c) =>
    c.good
      ? copy.security.checks.highPastFix.good(c.fix.high)
      : copy.security.checks.highPastFix.bad(countOf(c), c.fix.high, oldestOf(c)),
  dependenciesUnwatched: (c) =>
    c.good ? copy.security.checks.dependenciesUnwatched.good : copy.security.checks.dependenciesUnwatched.bad,
  highOpen: (c) => (c.good ? copy.security.checks.highOpen.good : copy.security.checks.highOpen.bad(countOf(c), c.fix.high)),
  mediumPastFix: (c) =>
    c.good
      ? copy.security.checks.mediumPastFix.good(c.fix.medium)
      : copy.security.checks.mediumPastFix.bad(countOf(c), c.fix.medium, oldestOf(c)),
  prHeadCheckout: (c) =>
    c.good ? copy.security.checks.prHeadCheckout.good : copy.security.checks.prHeadCheckout.bad(countOf(c)),
  scriptInjection: (c) =>
    c.good ? copy.security.checks.scriptInjection.good : copy.security.checks.scriptInjection.bad(countOf(c)),
  selfHostedPublic: (c) =>
    c.good ? copy.security.checks.selfHostedPublic.good : copy.security.checks.selfHostedPublic.bad(countOf(c)),
  unpinnedActions: (c) =>
    c.good ? copy.security.checks.unpinnedActions.good : copy.security.checks.unpinnedActions.bad(countOf(c)),
  workflowPermissions: (c) =>
    c.good ? copy.security.checks.workflowPermissions.good : copy.security.checks.workflowPermissions.bad(countOf(c)),
  unsecureCommands: (c) =>
    c.good ? copy.security.checks.unsecureCommands.good : copy.security.checks.unsecureCommands.bad(countOf(c)),
  keyFiles: (c) => (c.good ? copy.security.checks.keyFiles.good : copy.security.checks.keyFiles.bad(countOf(c))),
  branchUnprotected: (c) => (c.good ? copy.security.checks.branchUnprotected.good : copy.security.checks.branchUnprotected.bad),
  forcePushAllowed: (c) => (c.good ? copy.security.checks.forcePushAllowed.good : copy.security.checks.forcePushAllowed.bad),
};

export interface CheckLine {
  check: SecurityCheckName;
  part: SecurityPartName;
  good: boolean;
  /** The highest band the check alone allows. Lower is worse. */
  band: Band;
  /** True for the check that set its part's band. */
  limits: boolean;
  /** "grade" for the one check that sets the overall grade, "part" for another part's limiting check, else null. */
  sets: "grade" | "part" | null;
  text: string;
}

const BAND_ORDER: Record<Band, number> = { low: 0, medium: 1, high: 2, elite: 3 };

/** Every check core could measure, in the order core lists them. A check with no band could not be measured and is left out. */
export function checkLines(report: SecurityReport): CheckLine[] {
  const overall = report.grade?.overall;
  return report.checks
    .filter((c): c is SecurityCheck & { band: Band } => c.band !== undefined)
    .map((c) => {
      const good = c.band === "elite" || c.met === true;
      const setsGrade = c.limits && overall !== undefined && overall.part === c.part && overall.check === c.check;
      return {
        check: c.check,
        part: c.part,
        good,
        band: c.band,
        limits: c.limits,
        sets: setsGrade ? "grade" : c.limits ? "part" : null,
        text: checkSentence[c.check]({ check: c, good, fix: report.fixWithinDays }),
      };
    });
}

export interface GoodAndImprove {
  good: CheckLine[];
  improve: CheckLine[];
}

/** Good is every check at elite or met. To improve is the rest, lowest band first, and the limiting check ahead on a tie. */
export function goodAndImprove(report: SecurityReport): GoodAndImprove {
  const all = checkLines(report);
  return {
    good: all.filter((line) => line.good),
    improve: all
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !line.good)
      .sort(
        (a, b) =>
          BAND_ORDER[a.line.band] - BAND_ORDER[b.line.band] || Number(b.line.limits) - Number(a.line.limits) || a.index - b.index,
      )
      .map(({ line }) => line),
  };
}

/** The sentence for the check that set a part's band, or null when nothing held the part back. */
export function limitingSentence(report: SecurityReport, part: SecurityPartName): string | null {
  const grade = report.grade?.parts[part];
  if (!grade || grade.check === "all") return null;
  return checkLines(report).find((line) => line.part === part && line.check === grade.check)?.text ?? null;
}

/** One sentence naming the lowest part and the check that limited it, or null when there is no grade. */
export function verdictSentence(report: SecurityReport): string | null {
  const grade = report.grade;
  if (!grade) return null;
  const limit = limitingSentence(report, grade.overall.part);
  return limit === null
    ? copy.security.grade.allPass
    : copy.security.grade.lowestPart(copy.security.parts[grade.overall.part], lowerFirst(limit));
}

export interface PartRow {
  part: SecurityPartName;
  name: string;
  definition: string;
  /** Null when the part could not be measured. */
  band: Band | null;
  detail: string;
}

export function partRows(report: SecurityReport): PartRow[] {
  return PARTS.map((part) => {
    const graded = report.grade?.parts[part] ?? null;
    const limit = limitingSentence(report, part);
    return {
      part,
      name: copy.security.parts[part],
      definition: copy.security.partDefinitions[part],
      band: graded?.band ?? null,
      detail:
        graded === null
          ? copy.security.notMeasured
          : limit
            ? copy.security.grade.limitedBy(lowerFirst(limit))
            : copy.security.grade.nothingLimits,
    };
  });
}

/** What the grade could not cover, in words. */
export function unmeasuredSentences(measures: readonly SecurityMeasure[]): string[] {
  return measures.map((measure) => copy.security.unmeasured[measure]);
}

// --- Actions ---------------------------------------------------------------------------------------------------

export type Effort = "minutes" | "hour" | "code";

/** How much work each kind of action is, so a developer can pick the quick wins. Every kind core can send must be listed. */
export const ACTION_EFFORT: Record<SecurityActionKind, Effort> = {
  rotate_secret: "hour",
  upgrade_dependency: "hour",
  replace_dependency: "code",
  fix_code_alert: "code",
  fix_pr_head_checkout: "code",
  fix_script_injection: "code",
  stop_self_hosted_public: "hour",
  pin_actions: "hour",
  restrict_permissions: "minutes",
  remove_unsecure_commands: "minutes",
  remove_key_files: "hour",
  protect_branch: "minutes",
  block_force_push: "minutes",
  enable_dependabot: "minutes",
  pin_own_actions: "hour",
  add_update_config: "minutes",
  add_lockfile: "hour",
  add_security_policy: "minutes",
  review_weak_key_files: "hour",
  enable_code_scanning: "minutes",
  check_secret_scanning: "minutes",
  grant_alert_access: "minutes",
  turn_on_code_analysis: "minutes",
  fix_low_alerts: "hour",
  require_status_checks: "minutes",
  require_signed_commits: "hour",
  enable_security_updates: "minutes",
  enable_push_protection: "minutes",
  enable_private_reporting: "minutes",
  triage_advisories: "hour",
  add_dependency_review: "minutes",
  add_secret_scanner_ci: "minutes",
  add_static_analysis: "minutes",
  avoid_curl_pipe_shell: "hour",
  avoid_secrets_inherit: "hour",
  disable_persist_credentials: "minutes",
  pin_base_images: "hour",
  avoid_latest_images: "hour",
  run_as_non_root: "hour",
  avoid_remote_add: "hour",
  merge_dependency_updates: "hour",
};

export const effortLabel = (effort: Effort): string => copy.security.effort[effort];

/** The thing an action is about in words: a package without its ecosystem prefix, or the path, rule or secret type as given. */
export function targetName(action: Pick<SecurityAction, "target" | "ecosystem">): string {
  const target = action.target ?? "";
  const prefix = action.ecosystem ? `${action.ecosystem}:` : null;
  if (prefix && target.toLowerCase().startsWith(prefix.toLowerCase())) return target.slice(prefix.length);
  return target;
}

export function actionFacts(action: SecurityAction, thresholds: SecurityThresholds | null = null): ActionFacts {
  return {
    thresholds,
    count: action.count,
    name: targetName(action),
    upgradeTo: action.upgradeTo,
    severity: action.severity ? severityLabel(action.severity).toLowerCase() : null,
  };
}

/**
 * The one sentence saying what is wrong, with the numbers. `versionUpdates` is the update configuration path that the
 * report gives when version updates run while Dependabot alerts are off, and `thresholds` are the limits the report
 * used, which a list row does not carry.
 */
export function actionSentence(
  action: SecurityAction,
  versionUpdates: string | null = null,
  thresholds: SecurityThresholds | null = null,
): string {
  if (action.kind === "enable_dependabot" && versionUpdates) return copy.security.dependabotAlerts.what(versionUpdates);
  return copy.security.fix[action.kind].what(actionFacts(action, thresholds));
}

/** True when no alert source has been read yet, as core's `read` says it, so every figure would be a zero that means nothing. */
export const notReadYet = (sources: Record<AlertSource, SourceStatus | SourceState>): boolean =>
  ALERT_SOURCES.every((source) => {
    const value = sources[source];
    return (typeof value === "string" ? value : value.status) === "not_read";
  });

/** An exploit prediction share such as 0.1 as "10%". */
export const likelyShare = (thresholds: Pick<SecurityThresholds, "likelyExploitedEpss">): string =>
  formatPercent(thresholds.likelyExploitedEpss);

export interface TopActions {
  shown: SecurityAction[];
  /** How many more there are than are shown. */
  more: number;
}

/** The first few actions in core's order, which already puts the ones that lift the grade first. */
export function topActions(actions: readonly SecurityAction[], count = 3): TopActions {
  return { shown: actions.slice(0, count), more: Math.max(0, actions.length - count) };
}

export interface StartHere {
  band: Band | null;
  /** What it takes to reach the next band, or null when nothing stands between the repository and it. */
  raise: { count: number; from: Band; to: Band } | null;
  top: TopActions;
  /** Pieces of advice that never move the grade. */
  adviceCount: number;
  nothingToFix: boolean;
}

export function startHere(report: SecurityReport): StartHere {
  const band = report.grade?.overall.band ?? null;
  return {
    band,
    raise: band && report.raiseGrade ? { count: report.raiseGrade.actions, from: band, to: report.raiseGrade.to } : null,
    top: topActions(report.actions),
    adviceCount: report.actions.filter((action) => action.band === null).length,
    nothingToFix: report.actions.length === 0,
  };
}

/** The number of actions that move the grade. */
export const gradedActionCount = (actions: readonly SecurityAction[]): number => actions.filter((a) => a.band !== null).length;

// --- Alerts ----------------------------------------------------------------------------------------------------

/** A source named in the address, or null for anything else so a hand-typed value shows every alert. */
export function parseAlertSource(raw: string | null): AlertSource | null {
  return ALERT_SOURCES.find((source) => source === raw) ?? null;
}

export function filterAlerts(alerts: readonly SecurityAlertRef[], source: AlertSource | null): SecurityAlertRef[] {
  return source === null ? [...alerts] : alerts.filter((alert) => alert.source === source);
}

export const sourceName = (source: AlertSource): string => copy.security.sourceNames[source];

/** Where an alert is, in words. */
export function alertWhere(where: AlertWhere): string {
  const text = copy.security.alerts.whereText;
  switch (where.kind) {
    case "package":
      return text.package(where.name, where.version, where.manifestPath);
    case "code":
      return text.code(where.path, where.line);
    case "secret":
      return text.secret(where.type);
  }
}

// --- Weaknesses and time to fix ---------------------------------------------------------------------------------

/** The plain name and one line of meaning for each weakness id that the page knows, keyed by its id such as "CWE-79". */
export const CWE_NAMES: Record<string, { name: string; meaning: string }> = copy.security.cwe;

/** A weakness id as one spelling, so "CWE-020", "cwe-20" and "CWE-20" are the same one. Anything else is left as it came. */
export function normaliseCwe(cwe: string): string {
  const match = /^cwe-0*(\d+)$/i.exec(cwe.trim());
  return match ? `CWE-${match[1]}` : cwe;
}

export const weaknessName = (cwe: string): string => CWE_NAMES[normaliseCwe(cwe)]?.name ?? normaliseCwe(cwe);
export const weaknessMeaning = (cwe: string): string => CWE_NAMES[normaliseCwe(cwe)]?.meaning ?? copy.security.weaknesses.unnamed;

export interface WeaknessRow {
  cwe: string;
  name: string;
  meaning: string;
  open: number;
  fixed: number;
}

/** One row for each weakness, with ids normalised for display and the counts of any that were the same id added together. */
export function weaknessRows(weaknesses: SecurityReport["weaknesses"]): WeaknessRow[] {
  const rows = new Map<string, WeaknessRow>();
  for (const w of weaknesses) {
    const cwe = normaliseCwe(w.cwe);
    const row = rows.get(cwe);
    if (row) {
      row.open += w.open;
      row.fixed += w.fixedInRange;
    } else {
      rows.set(cwe, { cwe, name: weaknessName(cwe), meaning: weaknessMeaning(cwe), open: w.open, fixed: w.fixedInRange });
    }
  }
  return [...rows.values()];
}

export interface TimeToFixRow {
  severity: Severity;
  label: string;
  count: number;
  median: number | null;
  p75: number | null;
  mean: number | null;
  /** The days an alert of this severity may wait. */
  allowedDays: number;
}

/** Every severity in core's order, with the days each is allowed beside what was achieved. */
export function timeToFixRows(report: SecurityReport): TimeToFixRow[] {
  return report.timeToFixBySeverity.map(({ severity, summary }) => ({
    severity,
    label: severityLabel(severity),
    count: summary.count,
    median: summary.median,
    p75: summary.p75,
    mean: summary.mean,
    allowedDays: fixDays(severity, report.fixWithinDays),
  }));
}

export const dismissReasonLabel = (reason: string): string => {
  const reasons: Record<string, string> = copy.security.fixTime.reasons;
  return reasons[reason] ?? copy.security.fixTime.reasonFallback(reason);
};

/** "3 risk accepted and 1 a false alarm", or an empty text when nothing was dismissed. */
export function dismissedSummary(dismissed: SecurityReport["dismissed"]): string {
  return joinWords(dismissed.byReason.map((r) => `${r.count} ${dismissReasonLabel(r.reason)}`));
}

// --- Sources ---------------------------------------------------------------------------------------------------

/** A source is usable when it was read, or it failed this time but was read successfully before. */
export const sourceUsable = (state: SourceState): boolean =>
  state.status === "ok" || (state.status === "error" && state.readAt !== null);

const coverageName = (source: AlertSource) => copy.security.list.coverage.sources[source];

/**
 * The parts of the page that could not be read, in words. The OSV lookup is optional and stands in for Dependabot,
 * so it is only named when it was read, and Dependabot only counts as missing when OSV did not cover for it.
 */
export function unreadParts(report: SecurityReport): string[] {
  const { sources } = report;
  const missing: string[] = [];
  if (!sourceUsable(sources.dependabot) && !sourceUsable(sources.osv)) missing.push(coverageName("dependabot"));
  if (!sourceUsable(sources.code_scanning)) missing.push(coverageName("code_scanning"));
  if (!sourceUsable(sources.secret_scanning)) missing.push(coverageName("secret_scanning"));
  if (report.supplyChain.status === "none") missing.push(copy.security.list.coverage.supplyChain);
  return missing;
}

export interface SourceLine {
  id: AlertSource | "supplyChain" | "posture";
  name: string;
  status: SourceStatus;
  /** How the state is drawn. A source that is not needed is neutral and not a failure. */
  tone: "met" | "unmet" | "unseen";
  stateLabel: string;
  /** What happened, or why the source was not read. */
  detail: string | null;
  /** How to switch it on, or null when it needs nothing. */
  enable: string | null;
  readAt: string | null;
  /**
   * The line saying when it was read, or that it was not, or null when another line already says it or when it
   * needs no reading at all, so that no row says "Not needed" and "Not read yet" together or gives the time twice.
   */
  readNote: string | null;
}

/** Why the OSV lookup is not used, which are reasons for it never to be read, so "not read yet" would mislead. */
const NOT_USED_REASONS: ReadonlySet<string> = new Set(["lookup_off", "dependabot_ok", "no_inventory"]);

const readNoteFor = (readAt: string | null): string =>
  readAt ? copy.security.sources.readOn(formatDateTime(readAt)) : copy.security.sources.notYet;

function alertSourceLine(source: AlertSource, state: SourceState): SourceLine {
  const text = copy.security.sources;
  let detail: string | null = null;
  if (state.status === "error") detail = state.error ? text.failed(state.error) : text.failedNoMessage;
  else if ((state.status === "off" || state.status === "no_access") && state.reason) detail = text.reasons[state.reason];
  else if (state.status === "ok" && state.truncated) detail = text.truncated;
  const notNeeded = state.reason === "dependabot_ok";
  const needsNothing = state.status === "ok" || notNeeded;
  return {
    id: source,
    name: sourceName(source),
    status: state.status,
    tone: state.status === "ok" ? "met" : state.status === "not_read" || notNeeded ? "unseen" : "unmet",
    stateLabel: notNeeded ? text.notNeeded : text.status[state.status],
    detail,
    enable: needsNothing ? null : text.enable[source],
    readAt: state.readAt,
    readNote: state.reason !== null && NOT_USED_REASONS.has(state.reason) ? null : readNoteFor(state.readAt),
  };
}

/** Every alert source, then the workflow and dependency files and the branch settings, each with how to switch it on. */
export function sourceLines(report: SecurityReport): SourceLine[] {
  const text = copy.security.sources;
  const chain = report.supplyChain;
  const lines = ALERT_SOURCES.map((source) => alertSourceLine(source, report.sources[source]));
  if (report.dependabotVersionUpdates !== null) {
    lines[0]!.detail = copy.security.dependabotAlerts.source(report.dependabotVersionUpdates);
  }
  const chainStatus: SourceStatus = chain.status === "ok" ? "ok" : chain.reason === "analysis_off" ? "off" : "not_read";
  lines.push({
    id: "supplyChain",
    name: text.names.supplyChain,
    status: chainStatus,
    tone: chainStatus === "ok" ? "met" : chainStatus === "not_read" ? "unseen" : "unmet",
    stateLabel: text.status[chainStatus],
    detail:
      chain.status === "ok"
        ? text.supplyChain.ok(shortSha(chain.commitSha), formatDateTime(chain.readAt))
        : text.supplyChain[chain.reason],
    enable: chain.status === "ok" ? null : text.supplyChain.enable,
    readAt: chain.status === "ok" ? chain.readAt : null,
    // The detail of a file set that was read already gives the time.
    readNote: chain.status === "ok" ? null : readNoteFor(null),
  });
  const postureStatus: SourceStatus = report.posture ? "ok" : "not_read";
  lines.push({
    id: "posture",
    name: text.names.posture,
    status: postureStatus,
    tone: postureStatus === "ok" ? "met" : "unseen",
    stateLabel: text.status[postureStatus],
    detail: report.postureReadAt ? text.posture.ok(formatDateTime(report.postureReadAt)) : text.posture.notRead,
    enable: report.posture ? null : text.posture.enable,
    readAt: report.postureReadAt,
    // The detail of settings that were read already gives the time.
    readNote: report.postureReadAt ? null : readNoteFor(null),
  });
  return lines;
}

/** A sentence for a list row saying which sources were read and which were not. */
export function sourceCoverage(summary: Pick<SecuritySummary, "sources" | "supplyChain">): string {
  const text = copy.security.list.coverage;
  const read: string[] = [];
  const missing: string[] = [];
  for (const source of ALERT_SOURCES) {
    const status = summary.sources[source];
    if (status === "ok") read.push(text.sources[source]);
    // The OSV lookup stands in for Dependabot, so Dependabot is only missing when OSV did not cover for it.
    else if (source !== "osv" && !(source === "dependabot" && summary.sources.osv === "ok")) {
      missing.push(text.sources[source]);
    }
  }
  (summary.supplyChain === "ok" ? read : missing).push(text.supplyChain);
  if (read.length === 0) return text.none;
  return missing.length === 0 ? text.read(joinWords(read)) : text.readAndMissing(joinWords(read), joinWords(missing));
}

// --- The list page ---------------------------------------------------------------------------------------------

export interface SplitGraded {
  graded: SecuritySummary[];
  notGraded: SecuritySummary[];
}

/** Graded repositories and the rest, each in the order the API gave, which is worst first. */
export function splitGraded(summaries: readonly SecuritySummary[]): SplitGraded {
  return {
    graded: summaries.filter((s) => s.band !== null),
    notGraded: summaries.filter((s) => s.band === null),
  };
}

export interface ListTotals {
  openCritical: number;
  pastFix: number;
  notGraded: number;
  failed: SecuritySummary[];
  /** The repositories whose alerts have been read, which are the only ones the figures above add up. */
  read: number;
  total: number;
}

/** A repository never read holds zeros that mean nothing, so only the ones that were read are added up. */
export function listTotals(summaries: readonly SecuritySummary[]): ListTotals {
  const read = summaries.filter((s) => s.read);
  return {
    openCritical: read.reduce((sum, s) => sum + s.open.critical, 0),
    pastFix: read.reduce((sum, s) => sum + s.pastFix, 0),
    notGraded: summaries.filter((s) => s.band === null).length,
    failed: summaries.filter((s) => s.failed),
    read: read.length,
    total: summaries.length,
  };
}

export const lastRead = (readAt: string | null): string => (readAt ? formatDateTime(readAt) : copy.security.list.facts.neverRead);

// --- Supply chain lines -----------------------------------------------------------------------------------------

export type SupplyChainGroup = "workflows" | "tools" | "images" | "files" | "updates";

/** Where each check is shown, in the order within its section. */
export const SUPPLY_CHAIN_GROUPS: Record<SupplyChainGroup, readonly SupplyChainCheckId[]> = {
  workflows: [
    "prHeadCheckout",
    "scriptInjection",
    "selfHostedPublic",
    "unpinnedActions",
    "ownActionsUnpinned",
    "workflowPermissions",
    "unsecureCommands",
    "curlPipeShell",
    "secretsInherit",
    "persistCredentials",
    "keyFiles",
    "weakKeyFiles",
  ],
  tools: ["staticAnalysis", "secretScanInCi", "dependencyReview"],
  images: ["baseImagesPinned", "latestImages", "nonRootImages", "remoteAdd"],
  files: ["securityPolicy"],
  updates: ["updateConfig", "lockfiles"],
};

const CHECK_IDS = keysOf<SupplyChainCheckId>({
  prHeadCheckout: true,
  scriptInjection: true,
  selfHostedPublic: true,
  unpinnedActions: true,
  ownActionsUnpinned: true,
  workflowPermissions: true,
  unsecureCommands: true,
  keyFiles: true,
  weakKeyFiles: true,
  curlPipeShell: true,
  secretsInherit: true,
  persistCredentials: true,
  updateConfig: true,
  lockfiles: true,
  securityPolicy: true,
  dependencyReview: true,
  secretScanInCi: true,
  staticAnalysis: true,
  baseImagesPinned: true,
  latestImages: true,
  nonRootImages: true,
  remoteAdd: true,
});

/** The name of each supply chain check. Indexing the copy by every id makes a missing one a compile error. */
export const supplyChainTitle: Record<SupplyChainCheckId, string> = Object.fromEntries(
  CHECK_IDS.map((id) => [id, copy.security.supplyChain[id].title]),
) as Record<SupplyChainCheckId, string>;

/** Every check id core can send, for the tests that prove each has a place. */
export const SUPPLY_CHAIN_CHECK_IDS = CHECK_IDS;

/** The sentence for one line, saying what was found or that it is in order. */
export function supplyChainSentence(line: SupplyChainLine): string {
  const text = copy.security.supplyChain[line.check];
  return line.met ? text.ok : text.found(line.total);
}

/** The lines of one section, in the section's order, leaving out any that the report did not carry. */
export function groupLines(report: SecurityReport, group: SupplyChainGroup): SupplyChainLine[] {
  if (report.supplyChain.status !== "ok") return [];
  const lines = report.supplyChain.lines;
  return SUPPLY_CHAIN_GROUPS[group].flatMap((check) => lines.filter((line) => line.check === check));
}

export function lineItemText(item: SupplyChainLine["items"][number]): string {
  return copy.security.chain.line(item.path, item.line);
}

// --- Branch rules and settings ----------------------------------------------------------------------------------

export type RuleState = "met" | "unmet" | "unseen";

const stateOf = (value: boolean | null): RuleState => (value === null ? "unseen" : value ? "met" : "unmet");

export interface RuleRow {
  key: string;
  label: string;
  hint: string;
  state: RuleState;
  detail: string | null;
  /** Replaces the word for the state, as in "Only for public repositories". Such a row is neutral, never a gap. */
  stateLabel?: string;
}

/** The branch rules the page shows. The approval, stale approval, code owner and linear history rules stay unseen on purpose. */
type ShownRule = Exclude<
  keyof BranchRules,
  "requiredApprovals" | "dismissStaleReviews" | "requireCodeOwnerReview" | "requireLinearHistory"
>;

const RULE_KEYS = keysOf<ShownRule>({
  requirePullRequest: true,
  requireStatusChecks: true,
  blockForcePushes: true,
  blockDeletion: true,
  requireSignedCommits: true,
});

/** Each rule on the deploy branch as met, not met or not visible. Approval rules are not shown (ADR 0033). */
export function ruleRows(posture: RepoPosture): RuleRow[] {
  const text = copy.security.branch;
  return RULE_KEYS.map((key) => {
    return {
      key,
      label: text.rules[key],
      hint: text.ruleHints[key],
      state: stateOf(posture.branch.rules[key]),
      detail: null,
    };
  });
}

const SETTING_KEYS = keysOf<keyof RepoPosture["settings"]>({
  dependabotSecurityUpdates: true,
  secretScanning: true,
  pushProtection: true,
  validityChecks: true,
  privateVulnerabilityReporting: true,
});

/** Private vulnerability reporting and advisories exist only on public repositories, whoever asks. */
export const publicOnlyHere = (posture: RepoPosture): boolean =>
  posture.visibility === "private" || posture.visibility === "internal";

export function settingRows(posture: RepoPosture): RuleRow[] {
  const text = copy.security.branch;
  return SETTING_KEYS.map((key) => {
    const value = posture.settings[key];
    const notOffered = key === "privateVulnerabilityReporting" && value === null && publicOnlyHere(posture);
    return {
      key,
      label: text.settings[key],
      hint: text.settingHints[key],
      state: stateOf(value),
      detail: null,
      ...(notOffered ? { stateLabel: text.publicOnly } : {}),
    };
  });
}

/** True when something on the card could not be seen, which a setting that does not exist here never counts as. */
export function hasNotVisible(posture: RepoPosture, rows: readonly RuleRow[]): boolean {
  const advisoriesHidden = posture.advisories === null && !publicOnlyHere(posture);
  return advisoriesHidden || rows.some((row) => row.state === "unseen" && row.stateLabel === undefined);
}

/** The advisory counts, or why there are none to count. */
export function advisoriesText(posture: RepoPosture): string {
  if (posture.advisories) return advisorySentence(posture.advisories);
  return publicOnlyHere(posture) ? copy.security.branch.publicOnly : copy.security.branch.advisoriesHidden;
}

/**
 * What was readable of the branch's protection. The caveat that only rulesets could be read is left out for an
 * unprotected branch, which has no classic protection to read, and for an administrator, who can read it.
 */
export function branchDetailLine(posture: RepoPosture): string | null {
  const { detail, protected: isProtected } = posture.branch;
  if (detail !== "full" && (isProtected === false || posture.isAdmin === true)) return null;
  return copy.security.branch.detail[detail];
}

export function branchProtectedLine(posture: RepoPosture): string {
  const lines = copy.security.branch.protectedLine;
  const value = posture.branch.protected;
  return value === null ? lines.unseen : value ? lines.yes : lines.no;
}

export function postureAbout(posture: RepoPosture): string {
  const visibility = posture.visibility ? copy.security.branch.visibility[posture.visibility] : null;
  return copy.security.branch.about(posture.branch.name, visibility, posture.isAdmin);
}

export function advisorySentence(advisories: NonNullable<RepoPosture["advisories"]>): string {
  return copy.security.branch.advisories(advisories.draft, advisories.triage, advisories.published, advisories.closed);
}

// --- Scorecard -------------------------------------------------------------------------------------------------

/** A Scorecard check's score in words. Scorecard answers -1 for a check that does not apply. */
export const scorecardCheckValue = (score: number): string =>
  score < 0 ? copy.security.scorecard.notApplicable : copy.security.scorecard.checkValue(score);

export const scannedOn = (date: string): string => copy.security.scorecard.scoreHint(formatDate(date));

// --- Links -----------------------------------------------------------------------------------------------------

/** The address when it is an ordinary web address, else null, so a link from a stored alert can never run script. */
export function safeHttpUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// --- Helpers for the pages --------------------------------------------------------------------------------------

/** Open alerts past their fix-by date, over every severity. */
export const pastFixTotal = (pastFix: Record<Severity, number>): number => SEVERITIES.reduce((sum, s) => sum + pastFix[s], 0);

/** The latest time any alert source was read, or null when none has been. */
export function alertsReadAt(report: Pick<SecurityReport, "sources">): string | null {
  const times = ALERT_SOURCES.map((source) => report.sources[source].readAt).filter((t): t is string => t !== null);
  return times.length === 0 ? null : times.reduce((latest, t) => (t > latest ? t : latest));
}

/** The coverage sentence for a full report, worded as the list page words it for a summary. */
export function reportCoverage(report: Pick<SecurityReport, "sources" | "supplyChain">): string {
  const chain = report.supplyChain;
  // A source that failed this time but was read before still counts as read, as `unreadParts` counts it.
  const status = (source: AlertSource): SourceStatus =>
    sourceUsable(report.sources[source]) ? "ok" : report.sources[source].status;
  return sourceCoverage({
    sources: {
      dependabot: status("dependabot"),
      code_scanning: status("code_scanning"),
      secret_scanning: status("secret_scanning"),
      osv: status("osv"),
    },
    supplyChain: chain.status === "ok" ? "ok" : chain.reason,
  });
}
