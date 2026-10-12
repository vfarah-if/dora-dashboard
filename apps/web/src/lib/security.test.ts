import { describe, expect, it } from "vitest";
import type { SecurityActionKind, SecurityCheck, SecurityCheckName, SourceState } from "@dora-dashboard/core";
import { copy } from "../copy";
import { noSecurity, securityAction, securityAlert, securityReport, securitySummary } from "../test/fixtures";
import {
  actionFacts,
  likelyShare,
  ACTION_EFFORT,
  ALERT_SOURCES,
  CWE_NAMES,
  SEVERITIES,
  SEVERITY_COLOUR,
  SUPPLY_CHAIN_CHECK_IDS,
  SUPPLY_CHAIN_GROUPS,
  actionSentence,
  advisorySentence,
  alertWhere,
  alertsReadAt,
  branchProtectedLine,
  checkLines,
  checkSentence,
  dismissReasonLabel,
  dismissedSummary,
  effortLabel,
  filterAlerts,
  fixDays,
  goodAndImprove,
  gradedActionCount,
  groupLines,
  limitingSentence,
  lastRead,
  lineItemText,
  listTotals,
  notReadYet,
  openSummary,
  parseAlertSource,
  partRows,
  pastFixTotal,
  postureAbout,
  reportCoverage,
  reviewNotGraded,
  ruleRows,
  safeHttpUrl,
  scannedOn,
  scorecardCheckValue,
  securityPartWeekNote,
  settingRows,
  severityExplanation,
  severityLabel,
  severityRows,
  severitySeries,
  severityTileLabel,
  sourceCoverage,
  sourceLines,
  sourceUsable,
  splitGraded,
  startHere,
  supplyChainSentence,
  supplyChainTitle,
  targetName,
  timeToFixRows,
  topActions,
  unmeasuredSentences,
  unreadParts,
  verdictSentence,
  weaknessMeaning,
  weaknessName,
  weaknessRows,
} from "./security";

const NO_DASH = /[–—]/;

/** Every kind of action, taken from the record that must name them all. */
const KINDS = Object.keys(ACTION_EFFORT) as SecurityActionKind[];

const state = (overrides: Partial<SourceState>): SourceState => ({
  status: "ok",
  reason: null,
  readAt: "2026-03-01T10:00:00Z",
  attemptedAt: "2026-03-01T10:00:00Z",
  truncated: false,
  error: null,
  ...overrides,
});

describe("severity", () => {
  it("lists the severities most severe first", () => {
    expect(SEVERITIES).toEqual(["critical", "high", "medium", "low", "unknown"]);
  });

  it("colours severities on the stage ramp and an unrated alert on the neutral colour, never on a band", () => {
    expect(SEVERITY_COLOUR).toEqual({
      critical: "var(--stage-1)",
      high: "var(--stage-2)",
      medium: "var(--stage-3)",
      low: "var(--stage-4)",
      unknown: "var(--column-none)",
    });
    expect(Object.values(SEVERITY_COLOUR).some((colour) => colour.includes("band"))).toBe(false);
  });

  it("says Critical alerts for the tile and never a bare High", () => {
    expect(severityTileLabel("critical")).toBe("Critical alerts");
    expect(severityTileLabel("high")).toBe("High severity alerts");
    expect(severityLabel("unknown")).toBe("Not rated");
  });

  it("gives an alert without a rating the days of a medium one", () => {
    const fix = { critical: 7, high: 30, medium: 90, low: 180 } as const;
    expect(fixDays("critical", fix)).toBe(7);
    expect(fixDays("low", fix)).toBe(180);
    expect(fixDays("unknown", fix)).toBe(90);
  });

  it("explains each severity in plain words with its fix-by days", () => {
    const fix = { critical: 7, high: 30, medium: 90, low: 180 } as const;
    expect(severityExplanation("critical", fix)).toBe(
      "Critical means someone could take over the system or read private data with little effort. Fix within 7 days.",
    );
    expect(severityExplanation("unknown", fix)).toMatch(/treated like medium\. Fix within 90 days\.$/);
  });

  it("summarises open alerts in words, leaving out severities with none", () => {
    expect(openSummary({ critical: 2, high: 3, medium: 0, low: 0, unknown: 1 })).toBe("2 critical, 3 high and 1 not rated");
    expect(openSummary({ critical: 0, high: 1, medium: 0, low: 0, unknown: 0 })).toBe("1 high");
    expect(openSummary({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 })).toBe("No open alerts");
  });
});

describe("the weekly series", () => {
  const { weekly } = securityReport();

  it("totals each week's open alerts and keeps the part week flag", () => {
    const rows = severityRows(weekly);
    // 0 critical + 1 high + 1 medium = 2, then 1 + 2 + 2 + 1 = 6.
    expect(rows.map((r) => [r.week, r.total, r.partial])).toEqual([
      ["2026-02-16", 2, false],
      ["2026-02-23", 6, false],
      ["2026-03-02", 6, true],
    ]);
    expect(rows[1]).toMatchObject({
      critical: 1,
      high: 2,
      medium: 2,
      low: 1,
      unknown: 0,
      opened: 3,
      dismissed: 1,
      pastFixAtEnd: 1,
    });
  });

  it("charts only the severities that had an open alert, each in its own fixed colour", () => {
    expect(severitySeries(weekly).map((s) => [s.key, s.label, s.colour])).toEqual([
      ["critical", "Critical", "var(--stage-1)"],
      ["high", "High", "var(--stage-2)"],
      ["medium", "Medium", "var(--stage-3)"],
      ["low", "Low", "var(--stage-4)"],
    ]);
    expect(severitySeries([])).toEqual([]);
  });

  it("keeps a severity's colour when another has none", () => {
    const onlyHigh = weekly.map((w) => ({ ...w, openAtEnd: { ...w.openAtEnd, critical: 0 } }));
    expect(severitySeries(onlyHigh).find((s) => s.key === "high")?.colour).toBe("var(--stage-2)");
  });

  it("words the part week note for a week under way and for one the range cut", () => {
    expect(securityPartWeekNote({ week: "2026-03-02", through: "2026-03-04", current: true })).toBe(
      "The week starting 2 Mar is not over yet, so its figures are marked so far. Its bars are drawn lighter inside an outline, because the week has not finished.",
    );
    expect(securityPartWeekNote({ week: "2026-03-02", through: "2026-03-04", current: false })).toBe(
      "The range ends on 4 Mar, part way through the week starting 2 Mar, so that week's figures stop there. Its bars are drawn lighter inside an outline.",
    );
  });
});

describe("check sentences", () => {
  const names = Object.keys(checkSentence) as SecurityCheckName[];
  const fix = { critical: 7, high: 30, medium: 90, low: 180 } as const;

  it("has wording for all seventeen checks core can send", () => {
    expect(names).toHaveLength(17);
  });

  it.each(names)("writes a good and a bad sentence for %s without a dash or a missing value", (name) => {
    for (const good of [true, false]) {
      const check: SecurityCheck = {
        part: "vulnerabilities",
        check: name,
        value: 0.25,
        band: good ? "elite" : "medium",
        count: 3,
        total: 12,
        oldestDays: 40,
        limits: false,
      };
      const text = checkSentence[name]({ check, good, fix });
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(NO_DASH);
      expect(text).not.toMatch(/undefined|NaN|null/);
    }
  });

  it("states the counts and the oldest age for a bad check", () => {
    const check: SecurityCheck = {
      part: "vulnerabilities",
      check: "highPastFix",
      value: 1,
      band: "medium",
      count: 1,
      oldestDays: 45,
      limits: false,
    };
    expect(checkSentence.highPastFix({ check, good: false, fix })).toBe(
      "1 high severity alert has waited longer than the 30 day fix-by date, the oldest for 45 days.",
    );
    const two: SecurityCheck = { ...check, check: "criticalOpen", count: 2 };
    expect(checkSentence.criticalOpen({ check: two, good: false, fix })).toBe(
      "2 critical alerts are open, still inside the 7 day fix-by date.",
    );
  });

  it("writes the share of unapproved merges from the check's own figures", () => {
    const check: SecurityCheck = {
      part: "changeControl",
      check: "unapprovedMerges",
      value: 0.15,
      band: "high",
      count: 3,
      total: 20,
      limits: true,
    };
    expect(checkSentence.unapprovedMerges({ check, good: false, fix })).toBe(
      "15% of recent merges, 3 of 20, went in without another person's approval.",
    );
    expect(checkSentence.unapprovedMerges({ check: { ...check, value: 0.04, band: "elite" }, good: true, fix })).toBe(
      "Only 4% of recent merges went in without another person's approval.",
    );
  });
});

describe("check lines and the grade", () => {
  const report = securityReport();

  it("lists the checks that were measured and leaves out one with no band", () => {
    expect(checkLines(report).map((l) => l.check)).toEqual([
      "criticalPastFix",
      "criticalOpen",
      "highPastFix",
      "highOpen",
      "prHeadCheckout",
      "unpinnedActions",
    ]);
  });

  it("counts a check at elite as good and one below it as not", () => {
    expect(checkLines(report).map((l) => [l.check, l.good])).toEqual([
      ["criticalPastFix", true],
      ["criticalOpen", false],
      ["highPastFix", false],
      ["highOpen", false],
      ["prHeadCheckout", true],
      ["unpinnedActions", false],
    ]);
  });

  it("puts failures worst first and the limiting check ahead of an equal band, whatever the order core gave", () => {
    const { good, improve } = goodAndImprove(report);
    expect(good.map((l) => l.check)).toEqual(["criticalPastFix", "prHeadCheckout"]);
    // Medium: criticalOpen limits, then highPastFix. High: unpinnedActions limits and so precedes highOpen.
    expect(improve.map((l) => l.check)).toEqual(["criticalOpen", "highPastFix", "unpinnedActions", "highOpen"]);
  });

  it("names the check that set a part, and nothing for a part that was not measured or held back by nothing", () => {
    expect(limitingSentence(report, "vulnerabilities")).toBe("1 critical alert is open, still inside the 7 day fix-by date.");
    expect(limitingSentence(report, "changeControl")).toBeNull();
    const clear = securityReport({
      grade: {
        overall: { band: "elite", check: "all", reason: "all", part: "vulnerabilities" },
        parts: { vulnerabilities: { band: "elite", check: "all", reason: "all" }, supplyChain: null, changeControl: null },
        unmeasured: [],
      },
    });
    expect(limitingSentence(clear, "vulnerabilities")).toBeNull();
  });

  it("writes the verdict from the lowest part and its limiting check", () => {
    expect(verdictSentence(report)).toBe(
      "The lowest part is Known vulnerabilities and secrets, which is held back because 1 critical alert is open, still inside the 7 day fix-by date.",
    );
  });

  it("says nothing holds the grade back when no check limits it, and answers null without a grade", () => {
    const clear = securityReport({
      grade: {
        overall: { band: "elite", check: "all", reason: "all", part: "vulnerabilities" },
        parts: { vulnerabilities: { band: "elite", check: "all", reason: "all" }, supplyChain: null, changeControl: null },
        unmeasured: [],
      },
    });
    expect(verdictSentence(clear)).toBe(copy.security.grade.allPass);
    expect(verdictSentence(noSecurity())).toBeNull();
  });

  it("describes each part, with not measured for one without a band", () => {
    expect(partRows(report).map((p) => [p.part, p.name, p.band, p.detail])).toEqual([
      [
        "vulnerabilities",
        "Known vulnerabilities and secrets",
        "medium",
        "Held back because 1 critical alert is open, still inside the 7 day fix-by date.",
      ],
      [
        "supplyChain",
        "Workflows and supply chain",
        "high",
        "Held back because 1 action from another organisation is not pinned to a commit.",
      ],
      ["changeControl", "Change control", null, "Not measured"],
    ]);
  });

  it("describes every part as not measured when there is no grade", () => {
    expect(partRows(noSecurity()).map((p) => p.band)).toEqual([null, null, null]);
  });

  it("writes a sentence for each thing the grade could not cover", () => {
    expect(unmeasuredSentences(["code", "secrets"])).toEqual([
      "Code scanning alerts could not be read, so they are not part of the grade.",
      "Secret scanning alerts could not be read, so exposed secrets are not part of the grade.",
    ]);
    expect(unmeasuredSentences([])).toEqual([]);
  });
});

describe("actions", () => {
  it("rates the effort of every kind as minutes, an hour or a code change", () => {
    expect(KINDS).toHaveLength(46);
    for (const kind of KINDS) expect(["minutes", "hour", "code"]).toContain(ACTION_EFFORT[kind]);
  });

  it("rates a settings change as minutes, a package upgrade as under an hour and a code fix as a code change", () => {
    expect(ACTION_EFFORT.enable_dependabot).toBe("minutes");
    expect(ACTION_EFFORT.upgrade_dependency).toBe("hour");
    expect(ACTION_EFFORT.fix_code_alert).toBe("code");
    expect(effortLabel("minutes")).toBe("A few minutes");
    expect(effortLabel("hour")).toBe("Under an hour");
    expect(effortLabel("code")).toBe("Needs a code change");
  });

  it("drops the ecosystem prefix from a package target and leaves other targets as they are", () => {
    expect(targetName({ target: "npm:left-pad", ecosystem: "npm" })).toBe("left-pad");
    expect(targetName({ target: "npm:@acme/ui", ecosystem: "npm" })).toBe("@acme/ui");
    expect(targetName({ target: ".github/workflows/ci.yml", ecosystem: null })).toBe(".github/workflows/ci.yml");
    expect(targetName({ target: "js/sql-injection", ecosystem: "npm" })).toBe("js/sql-injection");
    expect(targetName({ target: null, ecosystem: null })).toBe("");
  });

  it("writes what is wrong with the numbers for an upgrade", () => {
    expect(actionSentence(securityAction())).toBe("left-pad has 2 open critical alerts, and version 1.3.1 fixes them.");
    expect(actionSentence(securityAction({ count: 1, severity: null }))).toBe(
      "left-pad has 1 open alert, and version 1.3.1 fixes it.",
    );
  });

  it("writes singular and plural forms", () => {
    const secret = (count: number) =>
      securityAction({ kind: "rotate_secret", target: "GitHub Personal Access Token", count, ecosystem: null });
    expect(actionSentence(secret(1))).toBe(
      "GitHub found one exposed GitHub Personal Access Token in this repository, and it may still work.",
    );
    expect(actionSentence(secret(3))).toBe(
      "GitHub found 3 exposed GitHub Personal Access Token in this repository, and they may still work.",
    );
    expect(
      actionSentence(securityAction({ kind: "pin_actions", target: ".github/workflows/ci.yml", count: 2, ecosystem: null })),
    ).toBe("The workflow .github/workflows/ci.yml uses 2 actions from other organisations that are not pinned to a commit.");
  });

  it.each(KINDS)("gives %s a what, a why and steps in plain words, with no dash", (kind) => {
    const action = securityAction({ kind, target: "thing", count: 2 });
    const sentence = actionSentence(action);
    const fix = copy.security.fix[kind];
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toMatch(/undefined|NaN|null/);
    expect(fix.why.length).toBeGreaterThan(40);
    expect(fix.steps.length).toBeGreaterThanOrEqual(3);
    for (const text of [sentence, fix.why, ...fix.steps]) expect(text).not.toMatch(NO_DASH);
  });

  it("takes the first three actions and counts the rest", () => {
    const actions = [1, 2, 3, 4, 5].map((n) => securityAction({ target: `npm:p${n}` }));
    expect(topActions(actions).shown).toHaveLength(3);
    expect(topActions(actions).more).toBe(2);
    expect(topActions(actions.slice(0, 2))).toEqual({ shown: actions.slice(0, 2), more: 0 });
    expect(topActions([])).toEqual({ shown: [], more: 0 });
  });

  it("works out the start here card from the grade, what raises it and the advice that does not", () => {
    const start = startHere(securityReport());
    expect(start.band).toBe("medium");
    expect(start.raise).toEqual({ count: 2, from: "medium", to: "high" });
    expect(start.top.shown).toHaveLength(3);
    expect(start.top.more).toBe(1);
    expect(start.adviceCount).toBe(2);
    expect(start.nothingToFix).toBe(false);
  });

  it("has nothing to raise without a raise figure, and nothing to fix without actions", () => {
    expect(startHere(securityReport({ raiseGrade: null })).raise).toBeNull();
    const clear = startHere(securityReport({ actions: [], raiseGrade: null }));
    expect(clear.nothingToFix).toBe(true);
    expect(startHere(noSecurity()).band).toBeNull();
    expect(startHere(noSecurity()).raise).toBeNull();
  });

  it("counts the actions that move the grade", () => {
    expect(gradedActionCount(securityReport().actions)).toBe(2);
  });
});

describe("alerts", () => {
  const alerts = [
    securityAlert({ source: "dependabot", key: "1" }),
    securityAlert({ source: "code_scanning", key: "2" }),
    securityAlert({ source: "dependabot", key: "3" }),
  ];

  it("accepts only a known source from the address", () => {
    expect(ALERT_SOURCES).toEqual(["dependabot", "code_scanning", "secret_scanning", "osv"]);
    expect(parseAlertSource("code_scanning")).toBe("code_scanning");
    expect(parseAlertSource("nonsense")).toBeNull();
    expect(parseAlertSource("")).toBeNull();
    expect(parseAlertSource(null)).toBeNull();
  });

  it("filters by source, keeping the API order, and returns every alert for no source", () => {
    expect(filterAlerts(alerts, "dependabot").map((a) => a.key)).toEqual(["1", "3"]);
    expect(filterAlerts(alerts, "secret_scanning")).toEqual([]);
    const all = filterAlerts(alerts, null);
    expect(all).toEqual(alerts);
    expect(all).not.toBe(alerts);
  });

  it("says where each kind of alert is", () => {
    expect(
      alertWhere({ kind: "package", ecosystem: "npm", name: "left-pad", version: "1.3.0", manifestPath: "package-lock.json" }),
    ).toBe("left-pad 1.3.0 in package-lock.json");
    expect(alertWhere({ kind: "package", ecosystem: "npm", name: "left-pad", version: null, manifestPath: "package.json" })).toBe(
      "left-pad in package.json",
    );
    expect(alertWhere({ kind: "code", path: "src/a.ts", line: 12, ruleId: "r" })).toBe("src/a.ts line 12");
    expect(alertWhere({ kind: "code", path: "src/a.ts", line: null, ruleId: "r" })).toBe("src/a.ts");
    expect(alertWhere({ kind: "code", path: null, line: null, ruleId: "r" })).toBe("A location GitHub did not report");
    expect(alertWhere({ kind: "secret", type: "Stripe API key" })).toBe("A secret of the kind Stripe API key");
  });
});

describe("weaknesses and time to fix", () => {
  it("names the thirty common weaknesses in plain words, each with a one line meaning", () => {
    const ids = [
      79, 89, 22, 78, 94, 77, 352, 798, 400, 770, 1321, 918, 502, 611, 601, 327, 20, 200, 287, 862, 863, 307, 1333, 116, 312, 319,
      434, 532, 59, 285,
    ];
    expect(ids).toHaveLength(30);
    for (const id of ids) {
      const entry = CWE_NAMES[`CWE-${id}`];
      expect(entry, `CWE-${id}`).toBeDefined();
      expect(entry!.name.length).toBeGreaterThan(3);
      expect(entry!.meaning.length).toBeGreaterThan(20);
      expect(`${entry!.name} ${entry!.meaning}`).not.toMatch(NO_DASH);
    }
    expect(CWE_NAMES["CWE-79"]!.name).toBe("Cross-site scripting");
  });

  it("shows an unknown weakness as its id and says it has no plain name yet", () => {
    expect(weaknessName("CWE-89")).toBe("SQL injection");
    expect(weaknessName("CWE-9999")).toBe("CWE-9999");
    expect(weaknessMeaning("CWE-9999")).toBe("No plain name yet");
  });

  it("builds a row for each weakness with open and fixed counts", () => {
    expect(weaknessRows(securityReport().weaknesses).map((r) => [r.cwe, r.name, r.open, r.fixed])).toEqual([
      ["CWE-1321", "Prototype pollution", 2, 1],
      ["CWE-79", "Cross-site scripting", 1, 0],
      ["CWE-9999", "CWE-9999", 1, 2],
    ]);
  });

  it("lists every severity with its allowed days beside what was achieved", () => {
    const rows = timeToFixRows(securityReport());
    expect(rows.map((r) => [r.severity, r.label, r.count, r.median, r.p75, r.allowedDays])).toEqual([
      ["critical", "Critical", 4, 24, 48, 7],
      ["high", "High", 4, 96, 192, 30],
      ["medium", "Medium", 0, null, null, 90],
      ["low", "Low", 0, null, null, 180],
      ["unknown", "Not rated", 0, null, null, 90],
    ]);
  });

  it("words dismissal reasons, falling back to the code without underscores", () => {
    expect(dismissReasonLabel("tolerable_risk")).toBe("risk accepted");
    expect(dismissReasonLabel("some_new_reason")).toBe("some new reason");
    expect(dismissedSummary(securityReport().dismissed)).toBe("2 risk accepted and 1 a false alarm");
    expect(dismissedSummary({ total: 0, byReason: [] })).toBe("");
  });
});

describe("sources", () => {
  it("treats a source as usable when it was read, or failed after an earlier read", () => {
    expect(sourceUsable(state({ status: "ok" }))).toBe(true);
    expect(sourceUsable(state({ status: "error", readAt: "2026-02-01T00:00:00Z" }))).toBe(true);
    expect(sourceUsable(state({ status: "error", readAt: null }))).toBe(false);
    expect(sourceUsable(state({ status: "off", readAt: null }))).toBe(false);
    expect(sourceUsable(state({ status: "not_read", readAt: null }))).toBe(false);
  });

  it("names nothing as unread when everything that matters was read", () => {
    expect(unreadParts(securityReport())).toEqual([]);
  });

  it("names the sources that could not be read, and workflow files that have not been", () => {
    const report = securityReport({
      sources: {
        ...securityReport().sources,
        secret_scanning: state({ status: "no_access", reason: "admin_only_or_off", readAt: null }),
        code_scanning: state({ status: "off", reason: "not_set_up", readAt: null }),
      },
      supplyChain: { status: "none", reason: "analysis_off" },
    });
    expect(unreadParts(report)).toEqual(["code scanning", "secret scanning", "workflow and dependency files"]);
  });

  it("leaves Dependabot out when the OSV lookup covered for it, and names it when nothing did", () => {
    const base = securityReport().sources;
    const off = state({ status: "off", reason: "disabled", readAt: null });
    expect(unreadParts(securityReport({ sources: { ...base, dependabot: off, osv: state({ status: "ok" }) } }))).toEqual([]);
    expect(unreadParts(securityReport({ sources: { ...base, dependabot: off } }))).toEqual(["Dependabot alerts"]);
  });

  it("describes each source, the files and the branch settings, with how to switch each one on", () => {
    const lines = sourceLines(securityReport());
    expect(lines.map((l) => [l.id, l.status])).toEqual([
      ["dependabot", "ok"],
      ["code_scanning", "ok"],
      ["secret_scanning", "ok"],
      ["osv", "off"],
      ["supplyChain", "ok"],
      ["posture", "ok"],
    ]);
    const osv = lines.find((l) => l.id === "osv")!;
    expect(osv.stateLabel).toBe("Switched off");
    expect(osv.detail).toBe("The lookup is switched off on this dashboard.");
    expect(osv.enable).toMatch(/^Set OSV_LOOKUP=on/);
    expect(lines.find((l) => l.id === "dependabot")!.enable).toBeNull();
    expect(lines.find((l) => l.id === "supplyChain")!.detail).toBe("Read from commit abcdef1 on 1 Mar 2026, 10:05.");
  });

  it("explains a refusal, a failure with its message, a truncated read and one OSV does not need", () => {
    const base = securityReport().sources;
    const report = securityReport({
      sources: {
        dependabot: state({ status: "error", error: "GitHub is down" }),
        code_scanning: state({ status: "off", reason: "needs_advanced_security", readAt: null }),
        secret_scanning: state({ status: "ok", truncated: true }),
        osv: state({ status: "off", reason: "dependabot_ok", readAt: null }),
      },
      supplyChain: { status: "none", reason: "not_read" },
      posture: null,
      postureReadAt: null,
    });
    const lines = sourceLines(report);
    expect(lines[0]!.detail).toBe('The last attempt failed with the message "GitHub is down". Earlier results are kept.');
    expect(lines[0]!.enable).toMatch(/Dependabot alerts/);
    expect(lines[1]!.detail).toMatch(/GitHub Code Security/);
    expect(lines[2]!.detail).toMatch(/more alerts exist/i);
    expect(lines[3]!.enable).toBeNull();
    // OSV was not needed, which is information and not a failure.
    expect(lines[3]).toMatchObject({ tone: "unseen", stateLabel: "Not needed" });
    expect(lines.map((l) => l.tone)).toEqual(["unmet", "unmet", "met", "unseen", "unseen", "unseen"]);
    expect(lines[4]).toMatchObject({ status: "not_read", detail: "These files have not been read yet." });
    expect(lines[5]).toMatchObject({ status: "not_read", detail: "They have not been read yet." });
    expect(
      sourceLines(securityReport({ sources: { ...base, dependabot: state({ status: "error", error: null }) } }))[0]!.detail,
    ).toBe("The last attempt failed. Earlier results are kept.");
  });

  it("says the files are switched off when code analysis is off", () => {
    const line = sourceLines(securityReport({ supplyChain: { status: "none", reason: "analysis_off" } }))[4]!;
    expect(line).toMatchObject({
      status: "off",
      stateLabel: "Switched off",
      detail: "Code analysis is switched off on this dashboard.",
    });
    expect(line.enable).toMatch(/CODE_ANALYSIS=on/);
  });

  it("finds the latest time any alert source was read", () => {
    expect(alertsReadAt(securityReport())).toBe("2026-03-01T10:02:00Z");
    expect(alertsReadAt(noSecurity())).toBeNull();
  });

  it("says which sources were read and which were not for a list row", () => {
    expect(sourceCoverage(securitySummary())).toBe(
      "Read Dependabot alerts, code scanning and workflow and dependency files. Not read secret scanning.",
    );
    expect(
      sourceCoverage(
        securitySummary({
          sources: { dependabot: "ok", code_scanning: "ok", secret_scanning: "ok", osv: "ok" },
          supplyChain: "ok",
        }),
      ),
    ).toBe("Read Dependabot alerts, code scanning, secret scanning, the OSV.dev lookup and workflow and dependency files.");
    expect(
      sourceCoverage({
        sources: { dependabot: "off", code_scanning: "off", secret_scanning: "off", osv: "off" },
        supplyChain: "not_read",
      }),
    ).toBe("Nothing has been read yet.");
  });

  it("does not call Dependabot missing when the OSV lookup covered for it, as the page's own notice does not", () => {
    const sources = { dependabot: "off", code_scanning: "ok", secret_scanning: "ok", osv: "ok" } as const;
    expect(sourceCoverage({ sources, supplyChain: "ok" })).toBe(
      "Read code scanning, secret scanning, the OSV.dev lookup and workflow and dependency files.",
    );
    expect(sourceCoverage({ sources: { ...sources, osv: "off" }, supplyChain: "ok" })).toBe(
      "Read code scanning, secret scanning and workflow and dependency files. Not read Dependabot alerts.",
    );
  });

  it("agrees with the notice about what could not be read, whatever covers for what", () => {
    const base = securityReport().sources;
    const off = state({ status: "off", reason: "disabled", readAt: null });
    const covered = securityReport({ sources: { ...base, dependabot: off, osv: state({ status: "ok" }) } });
    expect(unreadParts(covered)).toEqual([]);
    expect(reportCoverage(covered)).not.toContain("Not read");
    // A source that failed this time but was read before counts as read in both.
    const failedBefore = securityReport({
      sources: { ...base, code_scanning: state({ status: "error", error: "down", readAt: "2026-02-01T00:00:00Z" }) },
    });
    expect(unreadParts(failedBefore)).toEqual([]);
    expect(reportCoverage(failedBefore)).toBe(
      "Read Dependabot alerts, code scanning, secret scanning and workflow and dependency files.",
    );
  });

  it("words the coverage of a full report the same way", () => {
    expect(reportCoverage(securityReport())).toBe(
      "Read Dependabot alerts, code scanning, secret scanning and workflow and dependency files.",
    );
    expect(reportCoverage(noSecurity())).toBe("Nothing has been read yet.");
  });
});

describe("the list page", () => {
  const graded = securitySummary({ repo: { id: 1, owner: "acme", name: "a", lastCrawledAt: null, crawlStatus: "idle" } });
  const second = securitySummary({
    repo: { id: 2, owner: "acme", name: "b", lastCrawledAt: null, crawlStatus: "idle" },
    band: "low",
    pastFix: 3,
    failed: true,
  });
  const none = securitySummary({
    repo: { id: 3, owner: "acme", name: "c", lastCrawledAt: null, crawlStatus: "idle" },
    band: null,
    gradeMissing: "not_crawled",
    pastFix: 0,
    open: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  });

  it("splits graded repositories from the rest, keeping the API order in each", () => {
    const { graded: g, notGraded } = splitGraded([second, none, graded]);
    expect(g.map((s) => s.repo.id)).toEqual([2, 1]);
    expect(notGraded.map((s) => s.repo.id)).toEqual([3]);
  });

  it("totals open critical alerts and alerts past their fix-by date, and finds the failed reads", () => {
    const totals = listTotals([graded, second, none]);
    // 1 critical in each of the two graded rows, and 1 + 3 + 0 past their fix-by date.
    expect(totals.openCritical).toBe(2);
    expect(totals.pastFix).toBe(4);
    expect(totals.notGraded).toBe(1);
    expect(totals.failed.map((s) => s.repo.id)).toEqual([2]);
    expect(totals.read).toBe(3);
    expect(totals.total).toBe(3);
  });

  it("adds up only the repositories that were read, because a repository never read holds zeros that mean nothing", () => {
    const unread = securitySummary({
      repo: { id: 4, owner: "acme", name: "d", lastCrawledAt: null, crawlStatus: "idle" },
      read: false,
      open: { critical: 7, high: 0, medium: 0, low: 0, unknown: 0 },
      pastFix: 9,
    });
    const totals = listTotals([graded, second, unread]);
    expect(totals.openCritical).toBe(2);
    expect(totals.pastFix).toBe(4);
    expect(totals.read).toBe(2);
    expect(totals.total).toBe(3);
    expect(listTotals([unread])).toMatchObject({ openCritical: 0, pastFix: 0, read: 0, total: 1 });
  });

  it("writes the last read or says it has not been read", () => {
    expect(lastRead("2026-03-01T10:02:00Z")).toBe("1 Mar 2026, 10:02");
    expect(lastRead(null)).toBe("Not read yet");
  });

  it("totals the alerts past their fix-by date over every severity", () => {
    expect(pastFixTotal({ critical: 1, high: 2, medium: 0, low: 3, unknown: 4 })).toBe(10);
  });
});

describe("supply chain lines", () => {
  it("gives every check a place in exactly one section", () => {
    const placed = Object.values(SUPPLY_CHAIN_GROUPS).flat();
    expect(placed).toHaveLength(SUPPLY_CHAIN_CHECK_IDS.length);
    expect([...placed].sort()).toEqual([...SUPPLY_CHAIN_CHECK_IDS].sort());
  });

  it.each(SUPPLY_CHAIN_CHECK_IDS)("names %s and writes a sentence for a met and an unmet line", (id) => {
    expect(supplyChainTitle[id].length).toBeGreaterThan(10);
    for (const met of [true, false]) {
      const sentence = supplyChainSentence({ check: id, met, graded: true, items: [], total: 2 });
      expect(sentence.length).toBeGreaterThan(8);
      expect(sentence).not.toMatch(NO_DASH);
      expect(sentence).not.toMatch(/undefined|NaN/);
    }
  });

  it("states the number found for an unmet line", () => {
    expect(supplyChainSentence({ check: "unpinnedActions", met: false, graded: true, items: [], total: 2 })).toBe(
      "2 are not pinned.",
    );
    expect(supplyChainSentence({ check: "unpinnedActions", met: false, graded: true, items: [], total: 1 })).toBe(
      "1 is not pinned.",
    );
    expect(supplyChainSentence({ check: "unpinnedActions", met: true, graded: true, items: [], total: 0 })).toBe(
      "Every one is pinned.",
    );
  });

  it("takes each section's lines in the section's order and leaves out what the report did not carry", () => {
    const report = securityReport();
    expect(groupLines(report, "workflows").map((l) => l.check)).toEqual([
      "prHeadCheckout",
      "scriptInjection",
      "unpinnedActions",
      "workflowPermissions",
      "keyFiles",
    ]);
    expect(groupLines(report, "tools").map((l) => l.check)).toEqual(["staticAnalysis"]);
    expect(groupLines(report, "images").map((l) => l.check)).toEqual(["baseImagesPinned"]);
    expect(groupLines(report, "files").map((l) => l.check)).toEqual(["securityPolicy", "codeowners"]);
    expect(groupLines(report, "updates").map((l) => l.check)).toEqual(["updateConfig", "lockfiles"]);
    expect(groupLines(noSecurity(), "workflows")).toEqual([]);
  });

  it("writes an item as its path and line", () => {
    expect(lineItemText({ path: ".github/workflows/ci.yml", line: 12, detail: null })).toBe(".github/workflows/ci.yml line 12");
    expect(lineItemText({ path: "Dockerfile", line: null, detail: null })).toBe("Dockerfile");
  });
});

describe("branch rules and settings", () => {
  const posture = securityReport().posture!;

  it("shows each rule as met, not met or not visible, with the approvals where known", () => {
    expect(ruleRows(posture).map((r) => [r.key, r.state, r.detail])).toEqual([
      ["requirePullRequest", "met", null],
      ["requiredApprovals", "met", "1 approval is required."],
      ["dismissStaleReviews", "unseen", null],
      ["requireCodeOwnerReview", "unseen", null],
      ["requireStatusChecks", "unseen", null],
      ["blockForcePushes", "unmet", null],
      ["blockDeletion", "unseen", null],
      ["requireSignedCommits", "unseen", null],
      ["requireLinearHistory", "unseen", null],
    ]);
  });

  it("counts zero required approvals as not met and several as met", () => {
    const withApprovals = (n: number | null) => ({
      ...posture,
      branch: { ...posture.branch, rules: { ...posture.branch.rules, requiredApprovals: n } },
    });
    expect(ruleRows(withApprovals(0)).find((r) => r.key === "requiredApprovals")).toMatchObject({ state: "unmet", detail: null });
    expect(ruleRows(withApprovals(2)).find((r) => r.key === "requiredApprovals")).toMatchObject({
      state: "met",
      detail: "2 approvals are required.",
    });
    expect(ruleRows(withApprovals(null)).find((r) => r.key === "requiredApprovals")?.state).toBe("unseen");
  });

  it("shows each repository setting as met, not met or not visible", () => {
    expect(settingRows(posture).map((r) => [r.key, r.state])).toEqual([
      ["dependabotSecurityUpdates", "met"],
      ["secretScanning", "unseen"],
      ["pushProtection", "unmet"],
      ["validityChecks", "unseen"],
      ["privateVulnerabilityReporting", "unseen"],
    ]);
  });

  it("says whether the branch is protected, and what the account could see", () => {
    expect(branchProtectedLine(posture)).toBe("The branch is protected.");
    expect(branchProtectedLine({ ...posture, branch: { ...posture.branch, protected: false } })).toBe(
      "The branch is not protected.",
    );
    expect(branchProtectedLine({ ...posture, branch: { ...posture.branch, protected: null } })).toBe(
      "Whether the branch is protected could not be seen.",
    );
    expect(postureAbout(posture)).toBe(
      "The deploy branch is main in a public repository. The account the dashboard uses is not an administrator, so some settings are not visible.",
    );
    expect(postureAbout({ ...posture, visibility: null, isAdmin: true })).toBe(
      "The deploy branch is main. The dashboard could read every setting, because its account is an administrator.",
    );
    expect(postureAbout({ ...posture, isAdmin: null })).toMatch(/not known whether/);
  });

  it("writes the advisory counts", () => {
    expect(advisorySentence({ draft: 1, triage: 2, published: 3, closed: 4 })).toBe(
      "1 in draft, 2 in triage, 3 published and 4 closed.",
    );
  });
});

describe("change control and Scorecard", () => {
  const review = securityReport().review;

  it("says why review is not graded, or nothing when it is", () => {
    const limits = { reviewMinMerged: 10, reviewWindowDays: 90 };
    expect(reviewNotGraded(review, limits)).toBeNull();
    expect(reviewNotGraded({ ...review, graded: false, notGradedBecause: "too_few" }, limits)).toBe(
      "There are too few merged pull requests to judge, because at least 10 in the last 90 days are needed. Review is not part of the grade.",
    );
    expect(reviewNotGraded({ ...review, graded: false, notGradedBecause: "single_author" }, limits)).toMatch(
      /Only one person merged/,
    );
    expect(reviewNotGraded({ ...review, graded: false, notGradedBecause: null }, limits)).toBeNull();
  });

  it("takes the minimum and the window from the report's thresholds, so a change shows in the words", () => {
    const text = reviewNotGraded(
      { ...review, graded: false, notGradedBecause: "too_few" },
      { reviewMinMerged: 25, reviewWindowDays: 60 },
    );
    expect(text).toContain("at least 25 in the last 60 days");
    expect(text).not.toContain("90");
    expect(
      reviewNotGraded(
        { ...review, graded: false, notGradedBecause: "single_author" },
        { reviewMinMerged: 25, reviewWindowDays: 60 },
      ),
    ).toContain("in the last 60 days");
  });

  it("words a Scorecard check, with -1 as not applicable", () => {
    expect(scorecardCheckValue(3)).toBe("3 out of 10");
    expect(scorecardCheckValue(-1)).toBe("Not applicable");
    expect(scannedOn("2026-02-28")).toBe("Scanned on 28 Feb 2026.");
  });
});

describe("safeHttpUrl", () => {
  it("passes web addresses and refuses anything that could run script", () => {
    expect(safeHttpUrl("https://github.com/acme/widgets/pull/1")).toBe("https://github.com/acme/widgets/pull/1");
    expect(safeHttpUrl("http://ghe.example.com/x")).toBe("http://ghe.example.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("Dependabot version updates and alerts", () => {
  const withUpdates = (file: string | null) =>
    securityReport({
      sources: { ...securityReport().sources, dependabot: state({ status: "off", reason: "disabled", readAt: null }) },
      dependabotVersionUpdates: file,
    });

  it("words the action and the Dependabot source line with the distinction, from the report's own file", () => {
    const report = withUpdates(".github/dependabot.yml");
    const action = securityAction({ kind: "enable_dependabot" });
    expect(actionSentence(action, report.dependabotVersionUpdates)).toBe(
      "Dependabot version updates are set up in .github/dependabot.yml and keep your packages current, but Dependabot alerts, which warn you when a package you use has a known vulnerability, are switched off.",
    );
    expect(actionSentence(action)).toBe(copy.security.fix.enable_dependabot.what());
    expect(sourceLines(report)[0]!.detail).toMatch(
      /^Dependabot version updates are set up in \.github\/dependabot\.yml.*Switch them on under the repository's Settings, then Advanced Security\.$/,
    );
    expect(sourceLines(withUpdates(null))[0]!.detail).toBe("It is switched off for this repository.");
  });

  it("names Renovate when the file is Renovate's", () => {
    const sentence = actionSentence(securityAction({ kind: "enable_dependabot" }), "renovate.json");
    expect(sentence).toMatch(/^Renovate is set up in renovate\.json and keeps your packages current/);
  });
});

describe("notReadYet", () => {
  it("is true only when none of the four alert sources has been read, as core's read says", () => {
    expect(notReadYet(noSecurity().sources)).toBe(true);
    expect(notReadYet(securityReport().sources)).toBe(false);
    expect(notReadYet({ dependabot: "not_read", code_scanning: "not_read", secret_scanning: "ok", osv: "not_read" })).toBe(false);
    expect(notReadYet({ dependabot: "not_read", code_scanning: "not_read", secret_scanning: "not_read", osv: "off" })).toBe(
      false,
    );
    expect(notReadYet({ dependabot: "not_read", code_scanning: "not_read", secret_scanning: "not_read", osv: "not_read" })).toBe(
      true,
    );
    expect(notReadYet({ dependabot: "no_access", code_scanning: "not_read", secret_scanning: "not_read", osv: "not_read" })).toBe(
      false,
    );
  });
});

describe("limits written from the report's thresholds", () => {
  const thresholds = { ...securityReport().thresholds, reviewWindowDays: 45, lowAlertAdviceDays: 365, staleUpdateDays: 14 };

  it.each([
    ["require_review", "in the last 45 days had no approval", "in the last 90 days"],
    ["fix_low_alerts", "open for more than 365 days", "180 days"],
    ["merge_dependency_updates", "waiting for more than 14 days", "30 days"],
  ] as const)("writes the number of days for %s from the thresholds", (kind, expected, old) => {
    const sentence = actionSentence(securityAction({ kind, count: 2 }), null, thresholds);
    expect(sentence).toContain(expected);
    expect(sentence).not.toContain(old);
  });

  it("names no number where the summary carries none, instead of repeating one that may have drifted", () => {
    for (const kind of ["require_review", "fix_low_alerts", "merge_dependency_updates"] as const) {
      const sentence = actionSentence(securityAction({ kind, count: 2 }));
      expect(sentence).not.toMatch(/\d+ days/);
    }
    expect(actionSentence(securityAction({ kind: "require_review", count: 1 }))).toContain("in the review window");
  });

  it("carries the thresholds in the facts an action's sentence is written from", () => {
    expect(actionFacts(securityAction(), thresholds).thresholds).toBe(thresholds);
    expect(actionFacts(securityAction()).thresholds).toBeNull();
  });

  it("writes the exploit prediction share as a percentage", () => {
    expect(likelyShare({ likelyExploitedEpss: 0.1 })).toBe("10%");
    expect(likelyShare({ likelyExploitedEpss: 0.25 })).toBe("25%");
  });
});
