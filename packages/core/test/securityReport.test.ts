import { describe, expect, it } from "vitest";
import {
  LINE_ITEM_LIMIT,
  OPEN_ALERT_LIMIT,
  SECURITY_THRESHOLDS,
  WEAKNESS_LIMIT,
  securityReport,
  securitySummary,
  type SecurityInput,
} from "../src/securityReport.js";
import {
  FIX_WITHIN_DAYS,
  SEVERITIES,
  type AlertSource,
  type CloseReason,
  type SecurityReport,
  type SourceState,
  type SupplyChainCheckId,
} from "../src/securityTypes.js";
import type { PullRequest } from "../src/types.js";
import { fingerprintOfFinding } from "../src/securityAcceptance.js";
import { shortHash } from "../src/workflowReach.js";
import { closedIssue, issue, pr } from "./issue.js";
import {
  NOW,
  acceptance,
  allOk,
  codeAlert,
  daysAgo,
  depAlert,
  failed,
  held,
  input,
  noAccess,
  notRead,
  notUsed,
  ok,
  off,
  osvAlert,
  posture,
  record,
  secretAlert,
} from "./security.js";

/** The hashes every workflow finding carries, which a test sets apart only when it is about them. */
const HASHES = { lineHash: "00112233aabbccdd", reachHash: "8899aabbccddeeff" };
/** What an item of anything but a workflow finding says about routes and conditions. */
const NO_WHY = { routes: [], routesDropped: 0, conditions: [], conditionsDropped: 0 };
const EMPTY = { count: 0, median: null, p75: null, mean: null };
const build = (overrides: Parameters<typeof input>[0] = {}, options: { from?: string; to?: string } = {}): SecurityReport =>
  securityReport(input(overrides), { now: NOW, ...options });

describe("a repository with nothing in it", () => {
  const report = build();

  it("names the repository, the day it ranges over and when it was graded", () => {
    expect(report.repo).toEqual({
      id: 7,
      owner: "acme",
      name: "widgets",
      deployBranch: "main",
      lastCrawledAt: "2026-10-07T08:00:00Z",
    });
    expect(report.range).toEqual({ from: "2026-10-07", to: "2026-10-07" });
    expect(report.gradedAt).toBe(NOW);
  });

  it("carries the settings link", () => {
    expect(report.settingsUrl).toBe("https://github.com/acme/widgets/settings/security_analysis");
  });

  it("carries every limit the page quotes in one place, so no copy repeats a number", () => {
    expect(report.thresholds).toEqual({
      fixWithinDays: { critical: 7, high: 30, medium: 90, low: 180 },
      staleUpdateDays: 30,
      likelyExploitedEpss: 0.1,
      lowAlertAdviceDays: 180,
    });
    expect(report.thresholds).toBe(SECURITY_THRESHOLDS);
    expect(report.thresholds.fixWithinDays).toBe(FIX_WITHIN_DAYS);
  });

  it("keeps no copy of a limit beside the thresholds", () => {
    for (const key of ["fixWithinDays", "likelyExploitedEpss"]) expect(key in report).toBe(false);
    expect("total" in report.open).toBe(false);
  });

  it("passes a failed posture read through beside the posture it keeps, and says nothing when it did not fail", () => {
    expect(report.postureFailure).toBeNull();
    const failure = { message: "GitHub did not answer", attemptedAt: "2026-10-07T09:00:00Z" };
    expect(build({ postureFailure: failure })).toMatchObject({
      postureFailure: failure,
      posture: { value: posture(), readAt: "2026-10-07T08:00:00Z" },
    });
  });

  it("passes a failed inspection of the clone through beside the facts it keeps, and says nothing when it did not fail", () => {
    expect(report.supplyChainFailure).toBeNull();
    const failure = { message: "The clone could not be inspected. See the API log.", attemptedAt: "2026-10-07T09:00:00Z" };
    const failedAgain = build({ supplyChainFailure: failure });
    expect(failedAgain.supplyChainFailure).toEqual(failure);
    expect(failedAgain.supplyChain).toMatchObject({ status: "ok", commitSha: "a".repeat(40) });
    const neverRead = build({ supplyChain: null, supplyChainMissing: "not_read", supplyChainFailure: failure });
    expect(neverRead).toMatchObject({ supplyChain: { status: "none", reason: "not_read" }, supplyChainFailure: failure });
  });

  it("is elite with nothing to fix", () => {
    expect(report.grade!.overall).toMatchObject({ band: "elite", check: "all" });
    expect(report.gradeMissing).toBeNull();
    expect(report.raiseGrade).toBeNull();
    expect(report.actions).toEqual([]);
  });

  it("counts zero of everything, with every key present", () => {
    expect(report.open).toEqual({
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      bySource: { dependabot: 0, code_scanning: 0, secret_scanning: 0, osv: 0 },
      pastFix: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    });
    expect(report.likelyExploitedOpen).toBe(0);
    expect(report.openAlerts).toEqual([]);
    expect(report.openAlertTotal).toBe(0);
    expect(report.dependencyGroups).toEqual([]);
    expect(report.weaknesses).toEqual([]);
    expect(report.fixedInRange).toBe(0);
    expect(report.dismissed).toEqual({ total: 0, byReason: [] });
    expect(report.pushProtectionBypassedInRange).toBe(0);
  });

  it("gives an empty summary for the time to fix, overall and for every severity in order", () => {
    expect(report.timeToFix).toEqual(EMPTY);
    expect(report.timeToFixBySeverity).toEqual(SEVERITIES.map((severity) => ({ severity, summary: EMPTY })));
    expect(report.timeToFixBySeverity.map((r) => r.severity)).toEqual(["critical", "high", "medium", "low", "unknown"]);
  });

  it("gives one partial week for the day", () => {
    expect(report.weekly).toEqual([
      {
        week: "2026-10-05",
        partial: true,
        opened: 0,
        fixed: 0,
        dismissed: 0,
        openAtEnd: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        pastFixAtEnd: 0,
      },
    ]);
  });

  it("gives nothing for dependency updates and no security issues", () => {
    expect(report.dependencyUpdates).toEqual({
      openedInRange: 0,
      mergedInRange: 0,
      closedUnmergedInRange: 0,
      openNow: 0,
      timeToMerge: EMPTY,
      oldestOpenDays: null,
    });
    expect(report.securityIssues).toBeNull();
  });

  it("passes the posture, the scorecard and the ecosystems through", () => {
    expect(report.posture).toEqual({ value: posture(), readAt: "2026-10-07T08:00:00Z" });
    expect(report.scorecard).toEqual({ status: "off" });
    expect(report.ecosystems).toEqual(["npm"]);
  });

  it.each([
    ["a result", { status: "ok" as const, result: { score: 7.4, date: "2026-10-01", checks: [] } }],
    [
      "a failure with the last result kept",
      {
        status: "error" as const,
        message: "The OpenSSF Scorecard could not be read. See the API log.",
        attemptedAt: "2026-10-07T09:00:00Z",
        lastGood: { score: 6.1, date: "2026-09-01", checks: [] },
      },
    ],
    ["nothing read yet", { status: "not_read" as const }],
  ])("passes a Scorecard state holding %s through as it is", (_, scorecard) => {
    expect(build({ scorecard }).scorecard).toEqual(scorecard);
  });

  it("carries no review figure, because review habits are a delivery figure (ADR 0036)", () => {
    for (const key of ["review", "reviewInRange", "reviewMinMerged"]) expect(key in report).toBe(false);
    for (const key of ["reviewWindowDays", "reviewMinMerged", "unapprovedLimits"]) expect(key in report.thresholds).toBe(false);
  });
});

describe("the range", () => {
  const alert = depAlert({ severity: "high", createdAt: "2026-09-10T08:00:00Z" });

  it("starts at the earliest graded alert and ends today by default", () => {
    expect(build({ alerts: [alert] }).range).toEqual({ from: "2026-09-10", to: "2026-10-07" });
  });

  it("starts at the earliest pull request when it is older than every alert, or when there is no alert", () => {
    const opened = pr({ number: 1, createdAt: "2026-08-03T09:00:00Z" });
    expect(build({ alerts: [alert], pullRequests: [opened] }).range.from).toBe("2026-08-03");
    expect(build({ alerts: [], pullRequests: [opened] }).range).toEqual({ from: "2026-08-03", to: "2026-10-07" });
  });

  it("covers only today when there is neither an alert nor a pull request", () => {
    expect(build({ alerts: [] }).range).toEqual({ from: "2026-10-07", to: "2026-10-07" });
  });

  it("ignores alerts that are not graded when choosing the start", () => {
    const quality = codeAlert({ createdAt: "2026-01-01T00:00:00Z", code: { securitySeverity: null, securityTagged: false } });
    expect(build({ alerts: [alert, quality] }).range.from).toBe("2026-09-10");
  });

  it("honours a from and a to, and stops at now", () => {
    expect(build({ alerts: [alert] }, { from: "2026-09-15T22:00:00Z", to: "2026-09-20" }).range).toEqual({
      from: "2026-09-15",
      to: "2026-09-20",
    });
    expect(build({ alerts: [alert] }, { to: "2026-12-31" }).range.to).toBe("2026-10-07");
  });

  it("describes the same alerts now whatever the range, so a narrow range changes only the range figures", () => {
    const wide = build({ alerts: [alert] });
    const narrow = build({ alerts: [alert] }, { from: "2026-10-01", to: "2026-10-02" });
    expect(narrow.open).toEqual(wide.open);
    expect(narrow.openAlerts).toEqual(wide.openAlerts);
    expect(narrow.grade).toEqual(wide.grade);
    expect(narrow.actions).toEqual(wide.actions);
  });
});

describe("the open alerts", () => {
  const alerts = [
    depAlert({
      key: "d1",
      severity: "critical",
      createdAt: daysAgo(8),
      dependency: { epss: { percentage: 0.25, percentile: 0.95 }, cvssScore: 9.8, cwes: ["CWE-79"] },
    }),
    depAlert({ key: "d2", severity: "high", createdAt: daysAgo(2), dependency: { name: "express", lockedVersion: null } }),
    codeAlert({ key: "c1", createdAt: daysAgo(40), code: { securitySeverity: "high", cwes: ["CWE-89"] } }),
    secretAlert({ key: "s1", createdAt: daysAgo(1) }),
    depAlert({ key: "d3", severity: "low", createdAt: daysAgo(1) }),
    depAlert({ key: "d4", severity: "unknown", createdAt: daysAgo(100) }),
    depAlert({ key: "d5", severity: "critical", state: "fixed", closedAt: daysAgo(1) }),
    codeAlert({ key: "q1", code: { securitySeverity: null, securityTagged: false } }),
  ];
  const report = build({ alerts });

  it("counts open alerts by severity and source, leaving out closed and quality alerts", () => {
    expect(report.openAlertTotal).toBe(6);
    expect(report.open.bySeverity).toEqual({ critical: 2, high: 2, medium: 0, low: 1, unknown: 1 });
    expect(report.open.bySource).toEqual({ dependabot: 4, code_scanning: 1, secret_scanning: 1, osv: 0 });
  });

  it("counts the alerts past their fix-by date by severity", () => {
    // d1 critical 8 days (limit 7), c1 high 40 days (limit 30), d4 unknown 100 days (limit 90); the active secret is a day old.
    expect(report.open.pastFix).toEqual({ critical: 1, high: 1, medium: 0, low: 0, unknown: 1 });
  });

  it("lists them worst first, then past fix-by, then age", () => {
    // d1 critical past fix, s1 critical within, c1 high past fix, d2 high within, then d4 unknown (graded as medium, so
    // ranked above low) and last d3 low.
    expect(report.openAlerts.map((a) => a.key)).toEqual(["d1", "s1", "c1", "d2", "d4", "d3"]);
  });

  it("describes each alert with its age, flags and where it is", () => {
    const [first] = report.openAlerts;
    expect(first).toEqual({
      source: "dependabot",
      key: "d1",
      severity: "critical",
      title: "Advisory d1",
      url: "https://github.com/acme/widgets/security/dependabot/d1",
      createdAt: daysAgo(8),
      ageHours: 192,
      pastFix: true,
      fixByAt: daysAgo(1),
      daysLeft: -1,
      likelyExploited: true,
      epss: 0.25,
      cvssScore: 9.8,
      cwes: ["CWE-79"],
      where: { kind: "package", ecosystem: "npm", name: "lodash", version: "4.17.0", manifestPath: "package-lock.json" },
    });
    expect(report.openAlerts.find((a) => a.key === "c1")).toMatchObject({
      where: { kind: "code", path: "src/db.ts", line: 12, ruleId: "js/sql-injection", tool: "CodeQL" },
      epss: null,
      cvssScore: null,
      likelyExploited: false,
      cwes: ["CWE-89"],
    });
    expect(report.openAlerts.find((a) => a.key === "s1")!.where).toEqual({
      kind: "secret",
      type: "github_personal_access_token",
    });
    expect(report.openAlerts.find((a) => a.key === "d2")!.where).toMatchObject({ version: null });
  });

  it("counts the alerts likely to be exploited", () => {
    expect(report.likelyExploitedOpen).toBe(1);
  });

  it("caps the list at 100 and still says how many are open", () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      depAlert({ key: `m${i}`, severity: "medium", createdAt: daysAgo(1 + i / 1000) }),
    );
    const capped = build({ alerts: many });
    expect(capped.openAlerts).toHaveLength(OPEN_ALERT_LIMIT);
    expect(capped.openAlertTotal).toBe(130);
  });

  it("uses OSV's alerts only when Dependabot cannot be read", () => {
    const osv = osvAlert({ key: "o1", severity: "high" });
    const dep = depAlert({ key: "d9", severity: "high" });
    expect(build({ alerts: [osv, dep], sources: { ...allOk(), osv: ok() } }).openAlerts.map((a) => a.key)).toEqual(["d9"]);
    const fallback = build({ alerts: [osv, dep], sources: { ...allOk(), dependabot: noAccess(), osv: ok() } });
    expect(fallback.openAlerts.map((a) => a.key)).toEqual(["o1"]);
    expect(fallback.open.bySource.osv).toBe(1);
  });
});

describe("alerts over the weeks", () => {
  // Range 2026-09-21 (a Monday) to now, Wednesday 2026-10-07 at noon: weeks 09-21, 09-28 and 10-05, the last partial.
  const alerts = [
    depAlert({
      key: "A",
      severity: "critical",
      createdAt: "2026-09-23T10:00:00Z",
      state: "fixed",
      closedAt: "2026-10-01T10:00:00Z",
      closeReason: "fixed",
    }),
    depAlert({ key: "B", severity: "high", createdAt: "2026-09-29T09:00:00Z" }),
    depAlert({
      key: "C",
      severity: "medium",
      createdAt: "2026-09-10T09:00:00Z",
      state: "dismissed",
      closedAt: "2026-10-06T09:00:00Z",
      closeReason: "tolerable_risk",
    }),
    codeAlert({ key: "D", createdAt: "2026-10-06T08:00:00Z" }),
    depAlert({ key: "E", severity: "critical", createdAt: "2026-09-24T00:00:00Z" }),
    codeAlert({ key: "Q", createdAt: "2026-09-25T00:00:00Z", code: { securitySeverity: null, securityTagged: false } }),
  ];
  const report = build({ alerts }, { from: "2026-09-21" });

  it("gives a row for each week and marks only the last as partial", () => {
    expect(report.weekly.map((w) => [w.week, w.partial])).toEqual([
      ["2026-09-21", false],
      ["2026-09-28", false],
      ["2026-10-05", true],
    ]);
  });

  it("counts what opened, was fixed and was dismissed in each week", () => {
    expect(report.weekly.map((w) => [w.opened, w.fixed, w.dismissed])).toEqual([
      [2, 0, 0], // A and E opened; C opened before the range
      [1, 1, 0], // B opened; A fixed on the 1st
      [1, 0, 1], // D opened; C dismissed on the 6th
    ]);
  });

  it("counts what was open at the end of each week, the last being the end of the range", () => {
    expect(report.weekly.map((w) => w.openAtEnd)).toEqual([
      { critical: 2, high: 0, medium: 1, low: 0, unknown: 0 }, // A, E and C
      { critical: 1, high: 1, medium: 1, low: 0, unknown: 0 }, // E, B and C
      { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 }, // E, B and D
    ]);
  });

  it("counts what was past fix-by at the end of each week", () => {
    // E is 3.99 days old at the end of the first week, then 10.99 and 13.5, against a limit of 7.
    expect(report.weekly.map((w) => w.pastFixAtEnd)).toEqual([0, 1, 1]);
  });

  it("leaves out a fix or dismissal that falls outside the range", () => {
    const before = build({ alerts }, { from: "2026-10-02" });
    expect(before.fixedInRange).toBe(0);
    expect(before.dismissed.total).toBe(1);
    expect(before.weekly.map((w) => w.fixed)).toEqual([0, 0]);
  });

  it("includes a close at the very end of the last day and not a moment later", () => {
    const edge = [
      depAlert({ key: "x", createdAt: "2026-09-01T00:00:00Z", state: "fixed", closedAt: "2026-09-20T23:59:59.999Z" }),
      depAlert({ key: "y", createdAt: "2026-09-01T00:00:00Z", state: "fixed", closedAt: "2026-09-21T00:00:00Z" }),
    ];
    expect(build({ alerts: edge }, { from: "2026-09-10", to: "2026-09-20" }).fixedInRange).toBe(1);
  });

  it("is not partial when the range ends on a Sunday", () => {
    const sunday = build({ alerts }, { from: "2026-09-21", to: "2026-10-04" });
    expect(sunday.weekly.map((w) => w.partial)).toEqual([false, false]);
  });
});

describe("time to fix", () => {
  const hours = (h: number) => new Date(Date.parse("2026-09-30T00:00:00Z") + h * 3_600_000).toISOString();
  const fixed = (
    key: string,
    severity: "critical" | "high" | "medium" | "low" | "unknown",
    took: number,
    closedAt = hours(took),
  ) => depAlert({ key, severity, createdAt: "2026-09-30T00:00:00Z", state: "fixed", closedAt, closeReason: "fixed" });
  const alerts = [
    fixed("a", "critical", 24),
    fixed("b", "critical", 48),
    fixed("c", "high", 12),
    fixed("d", "unknown", 100),
    fixed("e", "low", 6),
    fixed("old", "high", 5, "2026-08-01T05:00:00Z"), // closed before the range
    depAlert({ key: "gone", severity: "high", state: "dismissed", closedAt: "2026-10-01T00:00:00Z" }),
  ];
  const report = build({ alerts }, { from: "2026-09-20" });

  it("covers fixed alerts closed in the range, in hours from creation", () => {
    expect(report.fixedInRange).toBe(5);
    // 6, 12, 24, 48, 100: median 24, p75 48, mean 190/5 = 38.
    expect(report.timeToFix).toEqual({ count: 5, median: 24, p75: 48, mean: 38 });
  });

  it("splits by severity, with every severity present and in order", () => {
    expect(report.timeToFixBySeverity).toEqual([
      { severity: "critical", summary: { count: 2, median: 36, p75: 42, mean: 36 } },
      { severity: "high", summary: { count: 1, median: 12, p75: 12, mean: 12 } },
      { severity: "medium", summary: EMPTY },
      { severity: "low", summary: { count: 1, median: 6, p75: 6, mean: 6 } },
      { severity: "unknown", summary: { count: 1, median: 100, p75: 100, mean: 100 } },
    ]);
  });

  it("counts a fix that came before the alert as taking no time", () => {
    const odd = depAlert({ key: "odd", createdAt: "2026-09-30T10:00:00Z", state: "fixed", closedAt: "2026-09-30T08:00:00Z" });
    expect(build({ alerts: [odd] }, { from: "2026-09-20" }).timeToFix).toEqual({ count: 1, median: 0, p75: 0, mean: 0 });
  });
});

describe("dismissals", () => {
  const dismissed = (key: string, closeReason: CloseReason | null) =>
    depAlert({ key, state: "dismissed", closedAt: "2026-10-01T00:00:00Z", closeReason, createdAt: "2026-09-25T00:00:00Z" });

  it("groups by GitHub's reason, most common first then by name, with a word for none", () => {
    const report = build({
      alerts: [
        dismissed("1", "tolerable_risk"),
        dismissed("2", "false_positive"),
        dismissed("3", "tolerable_risk"),
        dismissed("4", null),
        dismissed("5", "auto_dismissed"),
      ],
    });
    expect(report.dismissed).toEqual({
      total: 5,
      byReason: [
        { reason: "tolerable_risk", count: 2 },
        { reason: "auto_dismissed", count: 1 },
        { reason: "false_positive", count: 1 },
        { reason: "unspecified", count: 1 },
      ],
    });
  });
});

describe("weaknesses", () => {
  const cwe = (key: string, cwes: string[], extra: Parameters<typeof depAlert>[0] = {}) =>
    depAlert({ key, severity: "high", dependency: { cwes }, ...extra });

  it("counts a zero padded id stored earlier under its plain id", () => {
    const report = build({
      alerts: [cwe("1", ["CWE-020"]), cwe("2", ["CWE-20"]), codeAlert({ key: "3", code: { cwes: ["CWE-020"] } })],
    });
    expect(report.weaknesses).toEqual([{ cwe: "CWE-20", open: 3, fixedInRange: 0 }]);
  });

  it("counts open alerts and fixes in the range per weakness, most open first", () => {
    const report = build(
      {
        alerts: [
          cwe("1", ["CWE-79", "CWE-20"]),
          cwe("2", ["CWE-79"]),
          cwe("3", ["CWE-89"], { state: "fixed", closedAt: daysAgo(1) }),
          cwe("4", ["CWE-89", "CWE-89"], { state: "fixed", closedAt: daysAgo(2) }),
          cwe("5", ["CWE-20"], { state: "dismissed", closedAt: daysAgo(1) }),
          codeAlert({ key: "6", code: { cwes: ["CWE-20"] } }),
          cwe("7", []),
        ],
      },
      { from: "2026-10-01" },
    );
    expect(report.weaknesses).toEqual([
      { cwe: "CWE-20", open: 2, fixedInRange: 0 },
      { cwe: "CWE-79", open: 2, fixedInRange: 0 },
      { cwe: "CWE-89", open: 0, fixedInRange: 2 },
    ]);
  });

  it("keeps the ten with the most", () => {
    const alerts = Array.from({ length: 12 }, (_, i) => cwe(String(i), [`CWE-${100 + i}`]));
    const report = build({ alerts });
    expect(report.weaknesses).toHaveLength(WEAKNESS_LIMIT);
    expect(report.weaknesses[0]!.cwe).toBe("CWE-100");
  });

  it("leaves out a fix outside the range", () => {
    const report = build(
      { alerts: [cwe("1", ["CWE-79"], { state: "fixed", closedAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z" })] },
      { from: "2026-09-20" },
    );
    expect(report.weaknesses).toEqual([]);
  });
});

describe("push protection", () => {
  it("counts secrets opened in the range whose push protection was bypassed", () => {
    const bypassed = (key: string, createdAt: string) =>
      secretAlert({ key, createdAt, exposure: { pushProtectionBypassed: true } });
    const report = build(
      { alerts: [bypassed("1", daysAgo(3)), bypassed("2", daysAgo(40)), secretAlert({ key: "3", createdAt: daysAgo(3) })] },
      { from: daysAgo(10).slice(0, 10) },
    );
    expect(report.pushProtectionBypassedInRange).toBe(1);
  });
});

describe("dependency groups", () => {
  it("groups by package, worst first, without the alerts behind them", () => {
    const report = build({
      alerts: [
        depAlert({ key: "1", severity: "high", dependency: { name: "a", patchedVersion: "1.2.9" } }),
        depAlert({ key: "2", severity: "high", dependency: { name: "a", patchedVersion: "1.2.10" } }),
        depAlert({ key: "3", severity: "critical", dependency: { name: "b", patchedVersion: null } }),
      ],
    });
    expect(report.dependencyGroups).toEqual([
      {
        ecosystem: "npm",
        name: "b",
        manifestPath: "package-lock.json",
        relationship: "direct",
        lockedVersions: ["4.17.0"],
        alerts: 1,
        worstSeverity: "critical",
        upgradeTo: null,
        patchedVersions: [],
        pastFix: 0,
        likelyExploited: false,
      },
      {
        ecosystem: "npm",
        name: "a",
        manifestPath: "package-lock.json",
        relationship: "direct",
        lockedVersions: ["4.17.0"],
        alerts: 2,
        worstSeverity: "high",
        upgradeTo: "1.2.10",
        patchedVersions: ["1.2.9", "1.2.10"],
        pastFix: 0,
        likelyExploited: false,
      },
    ]);
  });

  it("lists patched versions that cannot be compared without choosing one", () => {
    const report = build({
      alerts: ["2.0.0-rc.1", "1.9.0"].map((patchedVersion, i) => depAlert({ key: String(i), dependency: { patchedVersion } })),
    });
    expect(report.dependencyGroups[0]).toMatchObject({ upgradeTo: null, patchedVersions: ["1.9.0", "2.0.0-rc.1"] });
  });
});

describe("the supply chain lines", () => {
  const ORDER: SupplyChainCheckId[] = [
    "prHeadCheckout",
    "scriptInjection",
    "selfHostedPublic",
    "unpinnedActions",
    "ownActionsUnpinned",
    "workflowPermissions",
    "unsecureCommands",
    "keyFiles",
    "weakKeyFiles",
    "curlPipeShell",
    "secretsInherit",
    "persistCredentials",
    "updateConfig",
    "lockfiles",
    "securityPolicy",
    "dependencyReview",
    "secretScanInCi",
    "staticAnalysis",
    "baseImagesPinned",
    "latestImages",
    "nonRootImages",
    "remoteAdd",
  ];
  const lines = (overrides: Parameters<typeof record>[0] = {}, extra: Parameters<typeof input>[0] = {}) => {
    const report = build({ supplyChain: record(overrides), ...extra });
    if (report.supplyChain.status !== "ok") throw new Error("expected a record");
    return report.supplyChain.lines;
  };
  const line = (
    check: SupplyChainCheckId,
    overrides: Parameters<typeof record>[0] = {},
    extra: Parameters<typeof input>[0] = {},
  ) => lines(overrides, extra).find((l) => l.check === check)!;

  it("covers every check in a fixed order, graded only for those the grade counts", () => {
    const all = lines({}, { posture: held(posture({ visibility: "public" })) });
    expect(all.map((l) => l.check)).toEqual(ORDER);
    expect(all.filter((l) => l.graded).map((l) => l.check)).toEqual([
      "prHeadCheckout",
      "scriptInjection",
      "selfHostedPublic",
      "unpinnedActions",
      "workflowPermissions",
      "unsecureCommands",
      "keyFiles",
    ]);
  });

  it("is met on every line for a clean repository", () => {
    expect(
      lines({}, { posture: held(posture({ visibility: "public" })) }).every(
        (l) =>
          l.met &&
          l.items.length ===
            (["updateConfig", "securityPolicy", "dependencyReview", "secretScanInCi", "staticAnalysis"].includes(l.check)
              ? l.total
              : 0),
      ),
    ).toBe(true);
  });

  it("lists a finding with its file, line and evidence", () => {
    const found = line("scriptInjection", {
      findings: [{ file: "a.yml", line: 8, risk: "scriptInjection", evidence: "github.event.issue.title", ...HASHES }],
    });
    expect(found).toEqual({
      check: "scriptInjection",
      met: false,
      graded: true,
      items: [
        {
          path: "a.yml",
          line: 8,
          detail: "github.event.issue.title",
          url: null,
          risk: "scriptInjection",
          // The risk, file, line hash, evidence and reach hash, joined with NUL.
          fingerprint: `w2:${shortHash("scriptInjection\x00a.yml\x0000112233aabbccdd\x00github.event.issue.title\x008899aabbccddeeff")}`,
          ...NO_WHY,
        },
      ],
      total: 1,
      accepted: 0,
      absence: null,
    });
  });

  it("splits unpinned actions into third party and own organisation, the owner compared without case", () => {
    const use = (action: string, kind: "other" | "docker" | "github" = "other", ref: string | null = "v1") => ({
      file: "ci.yml",
      line: 2,
      action,
      ref,
      pinned: false,
      kind,
    });
    const facts = {
      actions: [use("zed/tool"), use("ACME/shared"), use("docker://alpine", "docker", null), use("actions/checkout", "github")],
    };
    expect(line("unpinnedActions", facts).items).toEqual([
      {
        path: "ci.yml",
        line: 2,
        detail: "zed/tool@v1",
        url: null,
        risk: null,
        fingerprint: `a1:${shortHash("zed/tool@v1")}`,
        ...NO_WHY,
      },
      {
        path: "ci.yml",
        line: 2,
        detail: "docker://alpine",
        url: null,
        risk: null,
        fingerprint: `a1:${shortHash("docker://alpine@")}`,
        ...NO_WHY,
      },
    ]);
    expect(line("ownActionsUnpinned", facts)).toMatchObject({
      met: false,
      graded: false,
      total: 1,
      items: [{ detail: "ACME/shared@v1" }],
    });
  });

  it("counts a self-hosted runner only in a public repository whose pull requests run on it", () => {
    const runner = { file: "ci.yml", line: 3, risk: "selfHosted" as const, evidence: "self-hosted", ...HASHES };
    const findings = [{ ...runner, onPullRequest: true }];
    expect(line("selfHostedPublic", { findings }, { posture: held(posture({ visibility: "public" })) }).met).toBe(false);
    expect(line("selfHostedPublic", { findings }, { posture: held(posture({ visibility: "private" })) }).met).toBe(true);
    const pushOnly = [{ ...runner, onPullRequest: false }];
    expect(line("selfHostedPublic", { findings: pushOnly }, { posture: held(posture({ visibility: "public" })) }).met).toBe(true);
  });

  it("leaves the self-hosted line out when pull requests run on one and the visibility is not known", () => {
    const findings = [
      { file: "ci.yml", line: 3, risk: "selfHosted" as const, evidence: "self-hosted", ...HASHES, onPullRequest: true },
    ];
    expect(lines({ findings }, { posture: null }).map((l) => l.check)).not.toContain("selfHostedPublic");
    expect(lines({ findings }, { posture: held(posture({ visibility: null })) }).map((l) => l.check)).not.toContain(
      "selfHostedPublic",
    );
  });

  it("separates strong and weak key files and write-all from no permissions", () => {
    const facts = {
      keyFiles: [
        { path: ".env", blob: null, strength: "strong" as const },
        { path: "a.pem", blob: null, strength: "weak" as const },
      ],
      findings: [
        { file: "a.yml", line: null, risk: "writeAll" as const, evidence: "write-all", ...HASHES },
        { file: "b.yml", line: null, risk: "noPermissions" as const, evidence: "permissions", ...HASHES },
      ],
    };
    // A blob id that was not read leaves no fingerprint, so the file cannot be accepted.
    expect(line("keyFiles", facts).items).toEqual([
      { path: ".env", line: null, detail: null, url: null, risk: null, fingerprint: null, ...NO_WHY },
    ]);
    expect(line("weakKeyFiles", facts).items).toEqual([
      { path: "a.pem", line: null, detail: null, url: null, risk: null, fingerprint: null, ...NO_WHY },
    ]);
    expect(line("workflowPermissions", facts).total).toBe(2);
  });

  it("is met for what should be present when it is, and lists where", () => {
    expect(line("updateConfig")).toMatchObject({
      met: true,
      graded: false,
      items: [{ path: ".github/dependabot.yml", line: null, detail: null }],
    });
    const open = { posture: held(posture({ visibility: "public" })) };
    expect(line("securityPolicy", {}, open)).toMatchObject({ met: true, total: 1 });
    const missing = { updateConfig: null, securityPolicy: null, securityTools: [] };
    for (const check of ["updateConfig", "securityPolicy", "dependencyReview", "secretScanInCi", "staticAnalysis"] as const) {
      expect(line(check, missing, open)).toMatchObject({ met: false, items: [], total: 0 });
    }
  });

  it.each(["private", "internal", null] as const)(
    "shows no security policy line when the repository is %s, because it has no outside reporters",
    (visibility) => {
      const shown = lines({ securityPolicy: null }, { posture: held(posture({ visibility })) });
      expect(shown.map((l) => l.check)).not.toContain("securityPolicy");
      expect(shown.map((l) => l.check)).not.toContain("codeowners");
    },
  );

  it("shows no security policy line before the posture has been read", () => {
    expect(lines({}, { posture: null }).map((l) => l.check)).not.toContain("securityPolicy");
  });

  it("lists each tool with the file that runs it", () => {
    expect(line("staticAnalysis")).toMatchObject({
      met: true,
      items: [{ path: ".github/workflows/ci.yml", line: null, detail: "github/codeql-action/analyze" }],
    });
  });

  it.each(["unsecureCommands", "secretsInherit", "persistCredentials"] as const)(
    "lists a %s finding on its own line, with its risk",
    (risk) => {
      const findings = [{ file: "ci.yml", line: 6, risk, evidence: "x", ...HASHES }];
      expect(line(risk, { findings })).toMatchObject({ met: false, total: 1, items: [{ path: "ci.yml", line: 6, risk }] });
    },
  );

  it("lists manifests without a lockfile", () => {
    expect(line("lockfiles", { missingLockfiles: ["web/package.json"] })).toMatchObject({
      met: false,
      items: [{ path: "web/package.json" }],
      total: 1,
    });
  });

  it("reports container images by file with the share of the images", () => {
    const docker = {
      path: "Dockerfile",
      blob: null,
      images: 4,
      unpinnedImages: 3,
      latestImages: 2,
      runsAsRoot: true,
      addsRemote: true,
      curlPipeShell: true,
    };
    const facts = {
      dockerfiles: [docker],
      findings: [{ file: "ci.yml", line: 5, risk: "curlPipeShell" as const, evidence: "curl | sh", ...HASHES }],
    };
    expect(line("baseImagesPinned", facts).items).toEqual([
      { path: "Dockerfile", line: null, detail: "3 of 4", url: null, risk: null, fingerprint: null, ...NO_WHY },
    ]);
    expect(line("latestImages", facts).items).toEqual([
      { path: "Dockerfile", line: null, detail: "2 of 4", url: null, risk: null, fingerprint: null, ...NO_WHY },
    ]);
    expect(line("nonRootImages", facts)).toMatchObject({ met: false, total: 1 });
    expect(line("remoteAdd", facts)).toMatchObject({ met: false, total: 1 });
    expect(line("curlPipeShell", facts).items.map((i) => i.path)).toEqual(["ci.yml", "Dockerfile"]);
  });

  it("tells a Dockerfile's curlPipeShell item from a workflow's by its risk, line and detail, which only the workflow's has", () => {
    const docker = {
      path: "Dockerfile",
      blob: null,
      images: 1,
      unpinnedImages: 0,
      latestImages: 0,
      runsAsRoot: false,
      addsRemote: false,
      curlPipeShell: true,
    };
    const items = line("curlPipeShell", {
      dockerfiles: [docker],
      findings: [{ file: "ci.yml", line: 5, risk: "curlPipeShell", evidence: "curl | sh", ...HASHES }],
    }).items;
    expect(items.map((i) => [i.path, i.risk, i.line, i.detail])).toEqual([
      ["ci.yml", "curlPipeShell", 5, "curl | sh"],
      ["Dockerfile", null, null, null],
    ]);
  });

  it("lists at most 50 items and still counts them all", () => {
    const actions = Array.from({ length: 60 }, (_, i) => ({
      file: "ci.yml",
      line: i + 1,
      action: `zed/tool${i}`,
      ref: "v1",
      pinned: false,
      kind: "other" as const,
    }));
    const found = line("unpinnedActions", { actions });
    expect(found.items).toHaveLength(LINE_ITEM_LIMIT);
    expect(found.total).toBe(60);
  });

  it("carries the Dockerfiles that were not read beside the workflows", () => {
    const report = build({ supplyChain: record({ dockerfilesUnread: ["a/Dockerfile"], dockerfilesUnreadTotal: 3 }) });
    expect(report.supplyChain).toMatchObject({ status: "ok", dockerfilesUnread: ["a/Dockerfile"], dockerfilesUnreadTotal: 3 });
  });

  it("carries how many findings and action uses the caps left out, so a line can say that it is incomplete", () => {
    const report = build({ supplyChain: record({ findingsDropped: 12, actionsDropped: 3 }) });
    expect(report.supplyChain).toMatchObject({ status: "ok", findingsDropped: 12, actionsDropped: 3 });
  });

  it("describes the commit and the workflows read", () => {
    const report = build({ supplyChain: record({ workflowsRead: 4, workflowsUnread: ["big.yml"] }) });
    expect(report.supplyChain).toMatchObject({
      status: "ok",
      commitSha: "a".repeat(40),
      readAt: "2026-10-07T08:30:00Z",
      workflowsRead: 4,
      workflowsUnread: ["big.yml"],
    });
  });

  it("holds the record and the reason it is missing together in the input's type", () => {
    const given = input();
    // @ts-expect-error A missing record needs its reason, so no reader has to guess one.
    const neither: SecurityInput = { ...given, supplyChain: null, supplyChainMissing: null };
    // @ts-expect-error A record has no reason to be missing.
    const both: SecurityInput = { ...given, supplyChainMissing: "not_read" };
    expect([neither.supplyChainMissing, both.supplyChainMissing]).toEqual([null, "not_read"]);
  });

  it.each([
    ["analysis_off", "analysis_off"],
    ["not_read", "not_read"],
  ] as const)("says why there is no record when missing is %s", (missing, reason) => {
    const report = build({ supplyChain: null, supplyChainMissing: missing });
    expect(report.supplyChain).toEqual({ status: "none", reason });
    expect(report.ecosystems).toEqual([]);
  });
});

describe("which sources are in use and when each last read", () => {
  it("says whether each source's alerts are in use, as the grade uses them", () => {
    expect(build().used).toEqual({ dependabot: true, code_scanning: true, secret_scanning: true, osv: false });
    // Dependabot failed with no earlier read, so OSV stands in; a source without access is attempted but not in use.
    const sources = { dependabot: failed(null), code_scanning: noAccess(), secret_scanning: off(), osv: ok() };
    expect(build({ sources }).used).toEqual({ dependabot: false, code_scanning: false, secret_scanning: false, osv: true });
  });

  it("gives each source's last good read, from this attempt or from the one before a failure, and null otherwise", () => {
    const sources = {
      dependabot: failed("2026-09-01T00:00:00Z"),
      code_scanning: ok("2026-10-07T07:00:00Z"),
      secret_scanning: noAccess(),
      osv: ok("2026-10-07T09:30:00Z"),
    };
    // OSV's read is given although Dependabot's alerts are the ones in use; `used` says which count.
    expect(build({ sources }).lastGoodAt).toEqual({
      dependabot: "2026-09-01T00:00:00Z",
      code_scanning: "2026-10-07T07:00:00Z",
      secret_scanning: null,
      osv: "2026-10-07T09:30:00Z",
    });
    expect(build({ sources: { ...sources, dependabot: failed(null), osv: notUsed() } }).lastGoodAt).toMatchObject({
      dependabot: null,
      osv: null,
    });
  });

  it("names the deploy branch in the report but leaves it out of the list page's row", () => {
    const report = build({
      repo: { id: 7, owner: "acme", name: "widgets", deployBranch: "develop", lastCrawledAt: "2026-10-07T08:00:00Z" },
    });
    expect(report.repo.deployBranch).toBe("develop");
    expect(securitySummary(report, "idle").repo).toEqual({
      id: 7,
      owner: "acme",
      name: "widgets",
      lastCrawledAt: "2026-10-07T08:00:00Z",
      crawlStatus: "idle",
    });
  });
});

describe("change control", () => {
  const merged = Array.from({ length: 12 }, (_, i) =>
    pr({ number: 100 + i, mergedAt: "2026-10-01T10:00:00Z", author: `dev${i % 3}`, reviews: [] }),
  );

  it("is not lowered by merges that have no approval, whoever merged them", () => {
    const report = build({ pullRequests: merged });
    expect(report.grade!.parts.changeControl).toMatchObject({ band: "elite", check: "all" });
    expect(report.actions.map((a) => a.kind)).not.toContain("require_review");
  });

  it("follows the branch rules alone", () => {
    const open = posture({ branch: { protected: false, rules: { requirePullRequest: false, blockForcePushes: false } } });
    const report = build({ pullRequests: merged, posture: held(open) });
    expect(report.grade!.parts.changeControl).toMatchObject({ band: "high" });
    expect(report.checks.filter((c) => c.part === "changeControl").map((c) => c.check)).toEqual([
      "branchUnprotected",
      "forcePushAllowed",
    ]);
  });
});

describe("dependency updates", () => {
  const update = (number: number, author: string, overrides: Partial<PullRequest> = {}) =>
    pr({ number, author, authorIsBot: true, ...overrides });
  const prs = [
    update(1, "dependabot[bot]", {
      createdAt: "2026-09-02T00:00:00Z",
      mergedAt: "2026-09-03T00:00:00Z",
      closedAt: "2026-09-03T00:00:00Z",
    }),
    update(2, "renovate[bot]", {
      createdAt: "2026-09-10T00:00:00Z",
      mergedAt: "2026-09-10T06:00:00Z",
      closedAt: "2026-09-10T06:00:00Z",
    }),
    update(3, "dependabot[bot]", {
      state: "CLOSED",
      createdAt: "2026-08-01T00:00:00Z",
      mergedAt: null,
      closedAt: "2026-09-05T00:00:00Z",
    }),
    update(4, "Dependabot", { state: "OPEN", createdAt: "2026-08-28T12:00:00Z", mergedAt: null, closedAt: null }),
    update(5, "renovate", { state: "OPEN", createdAt: "2026-10-01T12:00:00Z", mergedAt: null, closedAt: null }),
    pr({ number: 6, author: "dependabot-fan", createdAt: "2026-09-02T00:00:00Z" }),
    pr({ number: 7, author: "alice", createdAt: "2026-09-02T00:00:00Z" }),
    pr({ number: 8, author: null, createdAt: "2026-09-02T00:00:00Z" }),
  ];
  const report = build({ pullRequests: prs }, { from: "2026-09-01" });

  it("counts the update pull requests opened, merged, closed and still open", () => {
    expect(report.dependencyUpdates).toMatchObject({ openedInRange: 3, mergedInRange: 2, closedUnmergedInRange: 1, openNow: 2 });
    // Opened in range: 1, 2 and 5 (the open one from 1 October); 4 was opened in August.
  });

  it("times the merges from creation and ages the oldest open one in whole days", () => {
    // 24 hours and 6 hours: median 15, p75 6 + 18 * 0.75 = 19.5, mean 15.
    expect(report.dependencyUpdates.timeToMerge).toEqual({ count: 2, median: 15, p75: 19.5, mean: 15 });
    // 28 August 12:00 to 7 October 12:00 is 40 days.
    expect(report.dependencyUpdates.oldestOpenDays).toBe(40);
  });

  it("counts every account that opens update pull requests, whatever its spelling", () => {
    const accounts = ["dependabot", "dependabot[bot]", "dependabot-preview[bot]", "renovate", "renovate[bot]", "renovate-bot"];
    const open = accounts.map((author, i) =>
      update(100 + i, author, { state: "OPEN", createdAt: daysAgo(40), mergedAt: null, closedAt: null }),
    );
    const found = build({ pullRequests: open });
    expect(found.dependencyUpdates.openNow).toBe(6);
    // All six have been open for 40 days, longer than the 30 that make an update stale.
    expect(found.actions.find((a) => a.kind === "merge_dependency_updates")).toMatchObject({ count: 6 });
  });

  it("asks for the old ones to be merged", () => {
    expect(report.actions.find((a) => a.kind === "merge_dependency_updates")).toMatchObject({ count: 1, band: null });
  });

  it("does not ask when none has been open for more than 30 days", () => {
    const fresh = build({
      pullRequests: [update(5, "renovate", { state: "OPEN", createdAt: daysAgo(30), mergedAt: null, closedAt: null })],
    });
    expect(fresh.actions.find((a) => a.kind === "merge_dependency_updates")).toBeUndefined();
    const old = build({
      pullRequests: [update(5, "renovate", { state: "OPEN", createdAt: daysAgo(30.001), mergedAt: null, closedAt: null })],
    });
    expect(old.actions.find((a) => a.kind === "merge_dependency_updates")).toBeDefined();
  });
});

describe("security issues", () => {
  const labelled = (number: number, labels: string[], overrides = {}) =>
    issue({ number, labels, createdAt: "2026-09-27T12:00:00Z", ...overrides });

  it("is null when the repository has no stored issues", () => {
    expect(build({ issues: null }).securityIssues).toBeNull();
    expect(build({ issues: [] }).securityIssues).toBeNull();
  });

  it("counts security issues only, as classified by the label rules", () => {
    const issues = [
      labelled(1, ["security"]),
      labelled(2, ["Vulnerability"], { createdAt: "2026-10-05T12:00:00Z" }),
      labelled(3, ["bug"]),
      closedIssue({ number: 4, labels: ["security"], createdAt: "2026-09-20T00:00:00Z", closedAt: "2026-09-22T00:00:00Z" }),
      closedIssue({
        number: 5,
        labels: ["security"],
        createdAt: "2026-09-20T00:00:00Z",
        closedAt: "2026-09-23T00:00:00Z",
        closeReason: "not_planned",
      }),
      closedIssue({ number: 6, labels: ["security"], createdAt: "2026-07-01T00:00:00Z", closedAt: "2026-07-03T00:00:00Z" }),
    ];
    const report = build({ issues, alerts: [depAlert({ createdAt: "2026-09-15T00:00:00Z" })] });
    expect(report.securityIssues).toEqual({
      open: 2,
      oldestOpenDays: 10, // 27 September 12:00 to 7 October 12:00
      closedInRange: 1,
      timeToClose: { count: 1, median: 48, p75: 48, mean: 48 },
    });
  });

  it("uses the repository's own label names", () => {
    const issues = [labelled(1, ["sec-team"]), labelled(2, ["security"])];
    const report = build({ issues, issueLabels: { kinds: { security: ["sec-team"] } } });
    expect(report.securityIssues).toMatchObject({ open: 1 });
  });

  it("has no oldest age and no time to close when none is open or closed", () => {
    const report = build({ issues: [labelled(1, ["bug"])] });
    expect(report.securityIssues).toEqual({ open: 0, oldestOpenDays: null, closedInRange: 0, timeToClose: EMPTY });
  });
});

describe("a grade that is missing", () => {
  it("says not crawled before the first crawl, with no grade and no checks", () => {
    const report = securityReport(input({ repo: { ...input().repo, lastCrawledAt: null } }), { now: NOW });
    expect(report).toMatchObject({ grade: null, gradeMissing: "not_crawled", checks: [], raiseGrade: null });
  });

  it("says nothing measured when no source and no clone could be read", () => {
    const sources = {
      dependabot: notRead(),
      code_scanning: noAccess(),
      secret_scanning: off("not_set_up"),
      osv: notUsed("lookup_off"),
    };
    const report = build({ sources, supplyChain: null, supplyChainMissing: "analysis_off" });
    expect(report).toMatchObject({ grade: null, gradeMissing: "nothing_measured", raiseGrade: null });
    expect(report.actions.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["turn_on_code_analysis", "check_secret_scanning", "grant_alert_access"]),
    );
    expect(report.actions.some((a) => a.onPath)).toBe(false);
  });
});

describe("raising the grade", () => {
  it("names the band reached and how many actions are on the path", () => {
    const alerts = [
      depAlert({ key: "1", severity: "critical", dependency: { name: "a" } }),
      depAlert({ key: "2", severity: "critical", dependency: { name: "b" } }),
      depAlert({ key: "3", severity: "high", dependency: { name: "c" } }),
    ];
    const report = build({ alerts });
    expect(report.grade!.overall.band).toBe("medium");
    expect(report.raiseGrade).toEqual({ to: "high", actions: 2 });
    expect(report.actions.filter((a) => a.onPath).map((a) => a.target)).toEqual(["npm:a", "npm:b"]);
  });

  it("counts a workflow action once per workflow", () => {
    const findings = ["a.yml", "b.yml"].map((file) => ({
      file,
      line: 1,
      risk: "prHeadCheckout" as const,
      evidence: "x",
      ...HASHES,
    }));
    expect(build({ supplyChain: record({ findings }) }).raiseGrade).toEqual({ to: "elite", actions: 2 });
  });
});

describe("raising the grade by what the actions clear", () => {
  const late = depAlert({ key: "late", severity: "critical", createdAt: daysAgo(10) });
  const fresh = depAlert({ key: "fresh", severity: "critical", createdAt: daysAgo(1) });

  it("reaches elite when one upgrade clears an alert past its fix-by date and a fresh one in the same package", () => {
    const report = build({ alerts: [late, fresh] });
    // `late` is critical past 7 days (low) and `fresh` is critical and open (medium). Both are lodash in one manifest, so
    // the one upgrade clears both, and the grade rises past medium to elite.
    expect(report.grade!.overall.band).toBe("low");
    expect(report.raiseGrade).toEqual({ to: "elite", actions: 1 });
    expect(report.actions.filter((a) => a.onPath)).toHaveLength(1);
  });

  it("stops at medium when the fresh alert is in another manifest, which is another action", () => {
    const elsewhere = depAlert({
      key: "other",
      severity: "critical",
      createdAt: daysAgo(1),
      dependency: { manifestPath: "web/package-lock.json" },
    });
    const report = build({ alerts: [late, elsewhere] });
    expect(report.raiseGrade).toEqual({ to: "medium", actions: 1 });
  });

  it("stops at high when the same package also has an advisory with no fix, which the upgrade cannot clear", () => {
    const patched = depAlert({ key: "patched", severity: "critical", createdAt: daysAgo(2) });
    const unpatched = depAlert({
      key: "unpatched",
      severity: "high",
      createdAt: daysAgo(2),
      dependency: { patchedVersion: null },
    });
    const report = build({ alerts: [patched, unpatched] });
    // The critical alert is open within 7 days (medium). Upgrading lodash clears it and leaves the high alert open within
    // 30 days, which holds the grade at high; without the critical alert the report grades high on `highOpen`.
    expect(report.grade!.overall).toMatchObject({ band: "medium", check: "criticalOpen" });
    expect(report.raiseGrade).toEqual({ to: "high", actions: 1 });
    expect(build({ alerts: [unpatched] }).grade!.overall).toMatchObject({ band: "high", check: "highOpen" });
  });

  it("reaches elite by rotating one active secret that feeds a low and a medium check", () => {
    expect(build({ alerts: [secretAlert()] }).raiseGrade).toEqual({ to: "elite", actions: 1 });
  });
});

describe("the version updates note", () => {
  const dependabotOff = { ...allOk(), dependabot: off("disabled") };

  it("names the update configuration when alerts are off and one exists", () => {
    expect(build({ sources: dependabotOff }).dependabotVersionUpdates).toBe(".github/dependabot.yml");
    expect(
      build({ sources: dependabotOff, supplyChain: record({ updateConfig: "renovate.json" }) }).dependabotVersionUpdates,
    ).toBe("renovate.json");
    expect(build({ sources: { ...allOk(), dependabot: off("not_set_up") } }).dependabotVersionUpdates).toBe(
      ".github/dependabot.yml",
    );
  });

  it("is null with alerts on, with no configuration, or without supply chain facts", () => {
    expect(build().dependabotVersionUpdates).toBeNull();
    expect(build({ sources: dependabotOff, supplyChain: record({ updateConfig: null }) }).dependabotVersionUpdates).toBeNull();
    expect(
      build({ sources: dependabotOff, supplyChain: null, supplyChainMissing: "not_read" }).dependabotVersionUpdates,
    ).toBeNull();
  });
});

describe("the summary", () => {
  const alerts = [
    depAlert({
      key: "1",
      severity: "critical",
      createdAt: daysAgo(10),
      dependency: { epss: { percentage: 0.4, percentile: 0.99 } },
    }),
    depAlert({ key: "2", severity: "high", createdAt: daysAgo(2) }),
    codeAlert({ key: "3", createdAt: daysAgo(40) }),
  ];
  const sources = {
    ...allOk(),
    dependabot: ok("2026-10-07T06:00:00Z"),
    code_scanning: failed("2026-10-06T00:00:00Z"),
    secret_scanning: ok("2026-10-07T09:00:00Z"),
  };
  const report = build({ alerts, sources, scorecard: { status: "ok", result: { score: 7.4, date: "2026-10-01", checks: [] } } });
  const summary = securitySummary(report, "crawling");
  const none: Record<AlertSource, SourceState> = {
    dependabot: notRead(),
    code_scanning: notRead(),
    secret_scanning: notRead(),
    osv: notRead(),
  };

  it("agrees with the report on the grade, the counts and the top action", () => {
    expect(summary.repo).toEqual({
      id: 7,
      owner: "acme",
      name: "widgets",
      lastCrawledAt: "2026-10-07T08:00:00Z",
      crawlStatus: "crawling",
    });
    expect(summary.band).toBe(report.grade!.overall.band);
    expect(summary.band).toBe("low");
    expect(summary.limitedBy).toEqual({ part: "vulnerabilities", check: "criticalPastFix" });
    expect(summary.open).toEqual(report.open.bySeverity);
    expect(summary.pastFix).toBe(2); // the critical alert and the high code alert
    expect(summary.likelyExploited).toBe(1);
    expect(summary.topAction).toBe(report.actions[0]);
    expect(summary.topAction).toMatchObject({ kind: "upgrade_dependency", onPath: true });
    expect(summary.scorecard).toBe(7.4);
    expect(summary.gradeMissing).toBeNull();
  });

  it("carries the thresholds so a row can name the real numbers", () => {
    expect(summary.thresholds).toEqual(report.thresholds);
    expect(summary.thresholds).toMatchObject({ lowAlertAdviceDays: 180, staleUpdateDays: 30 });
    expect(summary.thresholds).not.toHaveProperty("reviewWindowDays");
  });

  it("counts the actions that have a band and leaves the advice out", () => {
    // Two actions, both with a band: upgrading lodash (the critical past fix, low) and the code rule (high past fix, medium).
    expect(report.actions.map((a) => [a.kind, a.band])).toEqual([
      ["upgrade_dependency", "low"],
      ["fix_code_alert", "medium"],
    ]);
    expect(summary.actions).toBe(2);
    // A public repository with no security policy and nothing else to fix has one action, and it is advice.
    const withAdvice = build({ supplyChain: record({ securityPolicy: null }), posture: held(posture({ visibility: "public" })) });
    expect(withAdvice.actions.map((a) => [a.kind, a.band])).toEqual([["add_security_policy", null]]);
    expect(securitySummary(withAdvice, "idle").actions).toBe(0);
  });

  it("says a repository is read only when some source's alerts are in use, so zeros can be told from no data", () => {
    const read = (overrides: Partial<typeof none>) => securitySummary(build({ sources: { ...none, ...overrides } }), "idle").read;
    expect(read({})).toBe(false);
    // Every crawl writes a state for OSV, so a crawl in which every alert source had no access still uses nothing.
    expect(
      read({
        dependabot: noAccess(),
        code_scanning: noAccess(),
        secret_scanning: noAccess("admin_only_or_off"),
        osv: notUsed("no_inventory"),
      }),
    ).toBe(false);
    expect(read({ code_scanning: off("not_set_up"), osv: notUsed("lookup_off") })).toBe(false);
    expect(read({ code_scanning: failed(null) })).toBe(false);
    expect(read({ code_scanning: failed("2026-10-01T00:00:00Z") })).toBe(true);
    expect(read({ dependabot: noAccess(), osv: ok() })).toBe(true);
    expect(summary.read).toBe(true);
  });

  it("says whether each source's alerts are in use, as the grade uses them", () => {
    expect(summary.used).toEqual({ dependabot: true, code_scanning: true, secret_scanning: true, osv: false });
    const fallback = securitySummary(build({ sources: { ...allOk(), dependabot: failed(null), osv: ok() } }), "idle");
    expect(fallback.used).toEqual({ dependabot: false, code_scanning: true, secret_scanning: true, osv: true });
  });

  it("carries the raise-the-grade step and the version updates note from the report", () => {
    expect(summary.raiseGrade).toEqual(report.raiseGrade);
    // Upgrading lodash clears both its alerts; the code alert past its fix-by date then holds the grade at medium.
    expect(summary.raiseGrade).toEqual({ to: "medium", actions: 1 });
    expect(securitySummary(build(), "idle").raiseGrade).toBeNull();
    const dependabotOff = build({ sources: { ...allOk(), dependabot: off("disabled") } });
    expect(securitySummary(dependabotOff, "idle").dependabotVersionUpdates).toBe(".github/dependabot.yml");
    expect(summary.dependabotVersionUpdates).toBeNull();
  });

  it("counts every action with a band in `actions`, and only those on the path in `raiseGrade.actions`", () => {
    const mixed = build({
      alerts: [
        depAlert({ key: "c", severity: "critical", createdAt: daysAgo(10) }),
        depAlert({ key: "h", severity: "high", dependency: { name: "x" } }),
      ],
    });
    const row = securitySummary(mixed, "idle");
    // Two actions have a band (the critical past fix, low, and the high open, high); only the first is on the path.
    expect(row.actions).toBe(2);
    expect(row.raiseGrade).toEqual({ to: "high", actions: 1 });
  });

  it("gives each source's status, the latest read among those in use, and whether any failed", () => {
    expect(summary.sources).toEqual({ dependabot: "ok", code_scanning: "error", secret_scanning: "ok", osv: "not_used" });
    expect(summary.readAt).toBe("2026-10-07T09:00:00Z");
    expect(summary.failed).toBe(true);
    expect(securitySummary(build(), "idle").failed).toBe(false);
  });

  it("quotes no read time from a source whose alerts are not in use", () => {
    // Dependabot failed after a read on 1 September, so its alerts count and OSV's do not, although OSV was read later.
    const stale = {
      dependabot: failed("2026-09-01T00:00:00Z"),
      code_scanning: notRead(),
      secret_scanning: noAccess(),
      osv: ok("2026-10-07T09:30:00Z"),
    };
    expect(securitySummary(build({ sources: stale }), "idle").readAt).toBe("2026-09-01T00:00:00Z");
  });

  it("gives no read time when nothing is in use", () => {
    expect(securitySummary(build({ sources: none }), "idle").readAt).toBeNull();
    expect(securitySummary(build({ sources: { ...none, dependabot: noAccess() } }), "idle").readAt).toBeNull();
  });

  it("counts a failed posture read or a failed inspection of the clone as a failure", () => {
    const failure = { message: "GitHub did not answer", attemptedAt: "2026-10-07T09:00:00Z" };
    expect(securitySummary(build({ postureFailure: failure }), "idle").failed).toBe(true);
    expect(securitySummary(build({ supplyChainFailure: failure }), "idle").failed).toBe(true);
    expect(securitySummary(build({ posture: null, postureFailure: failure }), "idle").failed).toBe(true);
  });

  it.each([
    ["the score read", { status: "ok" as const, result: { score: 8.2, date: "2026-10-01", checks: [] } }, 8.2],
    [
      "the last score read when the lookup failed",
      { status: "error" as const, message: "x", attemptedAt: NOW, lastGood: { score: 5.5, date: "2026-09-01", checks: [] } },
      5.5,
    ],
    [
      "no score when the lookup failed with none read before",
      { status: "error" as const, message: "x", attemptedAt: NOW, lastGood: null },
      null,
    ],
    ["no score when nothing has been asked yet", { status: "not_read" as const }, null],
    ["no score when the lookup is off", { status: "off" as const }, null],
  ])("gives %s", (_, scorecard, expected) => {
    expect(securitySummary(build({ scorecard }), "idle").scorecard).toBe(expected);
  });

  it("says whether the clone was read", () => {
    expect(summary.supplyChain).toBe("ok");
    expect(securitySummary(build({ supplyChain: null, supplyChainMissing: "analysis_off" }), "idle").supplyChain).toBe(
      "analysis_off",
    );
    expect(securitySummary(build({ supplyChain: null, supplyChainMissing: "not_read" }), "idle").supplyChain).toBe("not_read");
  });

  it("names what was unmeasured, with or without a grade", () => {
    expect(summary.unmeasured).toEqual(report.grade!.unmeasured);
    const sources = { dependabot: notRead(), code_scanning: notRead(), secret_scanning: notRead(), osv: notUsed("lookup_off") };
    const empty = securitySummary(
      build({ sources, supplyChain: null, supplyChainMissing: "analysis_off", posture: null }),
      "idle",
    );
    expect(empty).toMatchObject({ band: null, limitedBy: null, gradeMissing: "nothing_measured" });
    expect(empty.topAction).toMatchObject({ kind: "turn_on_code_analysis", onPath: false });
    expect(empty.unmeasured).toEqual(["dependencies", "code", "secrets", "supplyChain", "changeControl"]);
    expect(empty.scorecard).toBeNull();
  });

  it("matches the report's own unmeasured list in every case it has a grade", () => {
    for (const overrides of [{}, { supplyChain: null, supplyChainMissing: "not_read" as const }, { posture: null }]) {
      const r = build(overrides);
      expect(securitySummary(r, "idle").unmeasured).toEqual(r.grade!.unmeasured);
    }
  });

  it("carries the top action for an elite repository as null", () => {
    expect(securitySummary(build(), "idle")).toMatchObject({
      band: "elite",
      limitedBy: { part: "vulnerabilities", check: "all" },
      topAction: null,
    });
  });
});

describe("privacy", () => {
  it("returns no login anywhere", () => {
    const prs = [pr({ number: 1, author: "mallory-login", mergedBy: "trent-login", reviews: [] })];
    const report = build({ pullRequests: prs, alerts: [secretAlert()] });
    expect(JSON.stringify(report)).not.toMatch(/mallory-login|trent-login/);
  });
});

describe("links to the files of the clone", () => {
  const sha = "a".repeat(40);
  const calls: [string, string, number | null][] = [];
  const fileUrl = (commitSha: string, path: string, line: number | null) => {
    calls.push([commitSha, path, line]);
    return `https://host.test/blob/${commitSha}/${path}${line === null ? "" : `#L${line}`}`;
  };
  const supplyChain = record({
    findings: [{ file: "a.yml", line: 8, risk: "scriptInjection", evidence: "github.event.issue.title", ...HASHES }],
    actions: [{ file: "b.yml", line: 3, action: "zed/tool", ref: "v1", pinned: false, kind: "other" }],
    keyFiles: [{ path: ".env", blob: null, strength: "strong" }],
  });
  const items = (report: SecurityReport, check: SupplyChainCheckId) => {
    if (report.supplyChain.status !== "ok") throw new Error("expected a record");
    return report.supplyChain.lines.find((l) => l.check === check)!.items;
  };

  it("hands the record's commit, the path and the line to the function and carries the answer on the items", () => {
    calls.length = 0;
    const report = build({ supplyChain, fileUrl });
    expect(items(report, "scriptInjection")).toEqual([
      {
        path: "a.yml",
        line: 8,
        detail: "github.event.issue.title",
        url: `https://host.test/blob/${sha}/a.yml#L8`,
        risk: "scriptInjection",
        fingerprint: `w2:${shortHash("scriptInjection\x00a.yml\x0000112233aabbccdd\x00github.event.issue.title\x008899aabbccddeeff")}`,
        ...NO_WHY,
      },
    ]);
    expect(items(report, "unpinnedActions")[0]).toMatchObject({ url: `https://host.test/blob/${sha}/b.yml#L3`, risk: null });
    expect(items(report, "keyFiles")[0]).toMatchObject({ url: `https://host.test/blob/${sha}/.env`, risk: null });
    expect(calls).toContainEqual([sha, "a.yml", 8]);
    expect(calls).toContainEqual([sha, ".env", null]);
  });

  it("carries the same links on the action refs", () => {
    const report = build({ supplyChain, fileUrl });
    const refs = (kind: string) => report.actions.find((a) => a.kind === kind)!.refs;
    expect(refs("fix_script_injection")).toEqual([{ label: "a.yml:8", url: `https://host.test/blob/${sha}/a.yml#L8` }]);
    expect(refs("pin_actions")[0]!.url).toBe(`https://host.test/blob/${sha}/b.yml#L3`);
    expect(refs("remove_key_files")[0]!.url).toBe(`https://host.test/blob/${sha}/.env`);
  });

  it("leaves every url null when no function is given", () => {
    const report = build({ supplyChain });
    expect(items(report, "scriptInjection")[0]!.url).toBeNull();
    expect(items(report, "unpinnedActions")[0]!.url).toBeNull();
    expect(report.actions.flatMap((a) => a.refs).every((r) => r.url === null)).toBe(true);
  });

  it("keeps the host's own address on a code alert's ref", () => {
    const report = build({ alerts: [codeAlert({ key: "q9" })], supplyChain, fileUrl });
    expect(report.actions.find((a) => a.kind === "fix_code_alert")!.refs[0]!.url).toBe(
      "https://github.com/acme/widgets/security/code-scanning/q9",
    );
  });
});

describe("when an open alert is due", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const alertAt = (ageMs: number) => {
    const [ref] = build({
      alerts: [depAlert({ key: "t", severity: "critical", createdAt: new Date(Date.parse(NOW) - ageMs).toISOString() })],
    }).openAlerts;
    return ref!;
  };

  it("adds the days its severity allows to the day it was raised", () => {
    const ref = alertAt(2 * DAY);
    // Critical is 7 days, so an alert raised 2 days ago is due in 5.
    expect(ref.fixByAt).toBe(new Date(Date.parse(NOW) + 5 * DAY).toISOString());
    expect(ref.daysLeft).toBe(5);
    expect(ref.pastFix).toBe(false);
  });

  it("reads 3 for 3.5 days left", () => {
    expect(alertAt(3.5 * DAY)).toMatchObject({ daysLeft: 3, pastFix: false });
  });

  it("reads 0 exactly at the limit, which is not past it", () => {
    expect(alertAt(7 * DAY)).toMatchObject({ fixByAt: NOW.replace("Z", ".000Z"), daysLeft: 0, pastFix: false });
  });

  it("reads 0 for part of a day left", () => {
    expect(alertAt(7 * DAY - HOUR)).toMatchObject({ daysLeft: 0, pastFix: false });
  });

  it("reads -1 one hour past the limit, and -1 for a whole day past", () => {
    expect(alertAt(7 * DAY + HOUR)).toMatchObject({ daysLeft: -1, pastFix: true });
    expect(alertAt(8 * DAY)).toMatchObject({ daysLeft: -1, pastFix: true });
    expect(alertAt(8 * DAY + HOUR)).toMatchObject({ daysLeft: -2, pastFix: true });
  });

  it("holds an unknown severity to medium's 90 days", () => {
    const [ref] = build({ alerts: [depAlert({ key: "u", severity: "unknown", createdAt: daysAgo(80) })] }).openAlerts;
    expect(ref).toMatchObject({ daysLeft: 10, pastFix: false });
  });

  it("names the tool of a code alert", () => {
    const [ref] = build({ alerts: [codeAlert({ code: { tool: "Semgrep" } })] }).openAlerts;
    expect(ref!.where).toMatchObject({ kind: "code", tool: "Semgrep" });
  });
});

describe("accepting findings", () => {
  const checkout = {
    file: ".github/workflows/db.yml",
    line: 31,
    risk: "prHeadCheckout" as const,
    evidence: "head_sha",
    ...HASHES,
  };
  const unpinned = { file: "ci.yml", line: 3, action: "zed/tool", ref: "v1", pinned: false, kind: "other" as const };
  const supplyChain = record({ findings: [checkout], actions: [unpinned] });
  const accepted = acceptance({
    id: 4,
    check: "prHeadCheckout",
    path: checkout.file,
    line: checkout.line,
    fingerprint: fingerprintOfFinding(checkout),
  });

  it("reports nothing accepted, and no band before, when nothing is", () => {
    const report = build({ supplyChain });
    expect(report.acceptances).toEqual([]);
    expect(report.accepted).toEqual({ graded: 0, advice: 0, bandBefore: null, supplyChainBefore: null });
    expect(securitySummary(report, "idle").accepted).toEqual({ graded: 0, bandBefore: null });
  });

  it("takes an accepted finding out of the grade and says what the band was before", () => {
    const report = build({ supplyChain, acceptances: [accepted] });
    // Low before, because of the checkout; high after, because the unpinned action still caps the part.
    expect(report.grade!.overall.band).toBe("high");
    expect(report.accepted).toEqual({ graded: 1, advice: 0, bandBefore: "low", supplyChainBefore: "low" });
    expect(report.checks.find((c) => c.check === "prHeadCheckout")).toMatchObject({ count: 0, accepted: 1 });
    expect(report.actions.map((a) => a.kind)).not.toContain("fix_pr_head_checkout");
    expect(securitySummary(report, "idle")).toMatchObject({ band: "high", accepted: { graded: 1, bandBefore: "low" } });
  });

  it("moves the line to the accepted count and leaves the open ones listed", () => {
    const report = build({ supplyChain, acceptances: [accepted] });
    if (report.supplyChain.status !== "ok") throw new Error("expected a record");
    const line = report.supplyChain.lines.find((l) => l.check === "prHeadCheckout")!;
    expect(line).toMatchObject({ met: true, items: [], total: 0, accepted: 1 });
    expect(report.supplyChain.lines.find((l) => l.check === "unpinnedActions")).toMatchObject({ total: 1, accepted: 0 });
  });

  it("counts advice apart from graded findings, and carries each acceptance with its place", () => {
    const own = { ...unpinned, action: "acme/shared" };
    const held = [accepted, acceptance({ id: 5, check: "staticAnalysis" })];
    const report = build({ supplyChain: record({ findings: [checkout], actions: [own], securityTools: [] }), acceptances: held });
    expect(report.accepted).toMatchObject({ graded: 1, advice: 1 });
    expect(report.acceptances.map((v) => [v.acceptance.id, v.status, v.graded, v.covers])).toEqual([
      [4, "applies", true, 1],
      [5, "applies", false, 1],
    ]);
    expect(report.acceptances[0]!.items).toEqual([
      expect.objectContaining({
        path: checkout.file,
        line: 31,
        risk: "prHeadCheckout",
        fingerprint: fingerprintOfFinding(checkout),
      }),
    ]);
  });

  it("links the places of an acceptance at the commit that was read", () => {
    const report = build({
      supplyChain,
      acceptances: [accepted],
      fileUrl: (sha, path, line) => `https://host.test/${sha}/${path}#L${line}`,
    });
    expect(report.acceptances[0]!.items[0]!.url).toBe(`https://host.test/${"a".repeat(40)}/.github/workflows/db.yml#L31`);
  });

  it("marks an absence on its line while it is open and counts it once it is accepted", () => {
    const missing = record({ securityTools: [] });
    const line = (r: SecurityReport) =>
      r.supplyChain.status === "ok" ? r.supplyChain.lines.find((l) => l.check === "dependencyReview")! : null;
    expect(line(build({ supplyChain: missing }))).toMatchObject({ met: false, accepted: 0, absence: { fingerprint: "n1:" } });
    expect(line(build({ supplyChain: missing, acceptances: [acceptance()] }))).toMatchObject({
      met: false,
      accepted: 1,
      absence: null,
    });
    expect(line(build({ supplyChain: record() }))).toMatchObject({ met: true, accepted: 0, absence: null });
  });

  it("leaves every acceptance unchecked, and the report as it was, when there is no supply chain record", () => {
    const report = build({ supplyChain: null, supplyChainMissing: "not_read", acceptances: [accepted] });
    expect(report.acceptances).toEqual([{ acceptance: accepted, status: "unchecked", graded: true, covers: 0, items: [] }]);
    expect(report.accepted).toEqual({ graded: 0, advice: 0, bandBefore: null, supplyChainBefore: null });
  });

  it("reopens an acceptance whose line changed, so the finding counts again", () => {
    const edited = { ...checkout, lineHash: "ffffffffffffffff" };
    const report = build({ supplyChain: record({ findings: [edited] }), acceptances: [accepted] });
    expect(report.acceptances[0]!.status).toBe("reopened");
    expect(report.grade!.overall).toMatchObject({ band: "low", check: "prHeadCheckout" });
    expect(report.accepted).toMatchObject({ graded: 0, bandBefore: null });
  });

  it("reopens an acceptance when only the reach changed, such as a swapped caller or a deleted guard", () => {
    const rerouted = { ...checkout, reachHash: "0000000000000000" };
    const report = build({ supplyChain: record({ findings: [rerouted] }), acceptances: [accepted] });
    expect(report.acceptances[0]!.status).toBe("reopened");
    expect(report.checks.find((c) => c.check === "prHeadCheckout")).toMatchObject({ count: 1 });
  });

  it("shows a key file acceptance as unchecked, and counts the file again, when the blob ids could not be read", () => {
    const held = acceptance({ id: 7, check: "keyFiles", path: ".env", fingerprint: `b:${"a".repeat(40)}` });
    const report = build({
      supplyChain: record({ keyFiles: [{ path: ".env", blob: null, strength: "strong" }], blobsRead: false }),
      acceptances: [held],
    });
    expect(report.acceptances).toEqual([{ acceptance: held, status: "unchecked", graded: true, covers: 0, items: [] }]);
    const check = report.checks.find((c) => c.check === "keyFiles")!;
    expect(check).toMatchObject({ count: 1, met: false });
    expect("accepted" in check).toBe(false);
  });

  it("agrees on an accepted absence across the line, the grade, the advice, the counts and the view", () => {
    const missing = record({ securityTools: [] });
    const absent = acceptance({ id: 6, check: "dependencyReview" });
    const before = build({ supplyChain: missing });
    const after = build({ supplyChain: missing, acceptances: [absent] });
    if (after.supplyChain.status !== "ok") throw new Error("expected a record");
    // The review is still missing, so the line is not met, but nothing open is left on it and its absence is accepted.
    expect(after.supplyChain.lines.find((l) => l.check === "dependencyReview")).toEqual({
      check: "dependencyReview",
      met: false,
      graded: false,
      items: [],
      total: 0,
      accepted: 1,
      absence: null,
    });
    // Advice never moves the grade, so the grade and its checks are as they were.
    expect(after.grade).toEqual(before.grade);
    expect(after.checks).toEqual(before.checks);
    expect(before.actions.map((a) => a.kind)).toContain("add_dependency_review");
    expect(after.actions.map((a) => a.kind)).not.toContain("add_dependency_review");
    // Something matched, so the bands before are worked out, and are the same elite.
    expect(after.accepted).toEqual({ graded: 0, advice: 1, bandBefore: "elite", supplyChainBefore: "elite" });
    expect(after.acceptances).toEqual([{ acceptance: absent, status: "applies", graded: false, covers: 1, items: [] }]);
  });

  it("says how many stored acceptances could not be read, and none by default", () => {
    expect(build({ supplyChain }).acceptancesUnreadable).toBe(0);
    const report = build({ supplyChain, acceptances: [accepted], unreadableAcceptances: 2 });
    expect(report.acceptancesUnreadable).toBe(2);
    expect(report.acceptances).toHaveLength(1);
    expect(build({ supplyChain: null, supplyChainMissing: "not_read", unreadableAcceptances: 3 }).acceptancesUnreadable).toBe(3);
  });
});
