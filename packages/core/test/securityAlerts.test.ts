import { describe, expect, it } from "vitest";
import { SEVERITY_RANK, cwesOf, epssOf, isLikelyExploited, isUsable, severityOf, worseSeverity } from "../src/securityAlerts.js";
import { codeAlert, depAlert, secretAlert, sourceState } from "./security.js";

describe("severityOf", () => {
  it.each(["critical", "high", "medium", "low", "unknown"] as const)(
    "takes a Dependabot alert's published %s severity",
    (severity) => {
      expect(severityOf(depAlert({ severity }))).toBe(severity);
    },
  );

  it("takes an OSV alert's published severity", () => {
    expect(severityOf(depAlert({ source: "osv", severity: "critical" }))).toBe("critical");
  });

  it("prefers a code alert's security severity over its rule severity", () => {
    expect(severityOf(codeAlert({ code: { securitySeverity: "critical", ruleSeverity: "note" } }))).toBe("critical");
  });

  it("uses a security severity even when the rule is not tagged", () => {
    expect(severityOf(codeAlert({ code: { securitySeverity: "low", securityTagged: false } }))).toBe("low");
  });

  it.each([
    ["error", "high"],
    ["warning", "medium"],
    ["note", "low"],
    ["none", "low"],
    [null, "low"],
  ] as const)("grades a tagged rule with %s severity and no security severity as %s", (ruleSeverity, expected) => {
    expect(severityOf(codeAlert({ code: { ruleSeverity, securitySeverity: null, securityTagged: true } }))).toBe(expected);
  });

  it("leaves an untagged code alert without a security severity ungraded", () => {
    expect(severityOf(codeAlert({ code: { securityTagged: false, securitySeverity: null, ruleSeverity: "error" } }))).toBeNull();
  });

  it.each([
    ["active", false, "critical"],
    ["unknown", false, "critical"],
    ["inactive", true, "critical"],
    ["inactive", false, "low"],
  ] as const)("grades a %s secret, publicly leaked %s, as %s", (validity, publiclyLeaked, expected) => {
    expect(severityOf(secretAlert({ exposure: { validity, publiclyLeaked } }))).toBe(expected);
  });
});

describe("isUsable", () => {
  it("accepts a source that was read", () => {
    expect(isUsable(sourceState({ status: "ok" }))).toBe(true);
  });

  it("accepts a source whose last attempt failed but which was read before", () => {
    expect(isUsable(sourceState({ status: "error", readAt: "2026-01-01T00:00:00Z", error: "rate limited" }))).toBe(true);
  });

  it("rejects a source that failed and was never read", () => {
    expect(isUsable(sourceState({ status: "error", readAt: null }))).toBe(false);
  });

  it.each(["off", "no_access", "not_read"] as const)("rejects a %s source even with an old read time", (status) => {
    expect(isUsable(sourceState({ status, readAt: "2026-01-01T00:00:00Z" }))).toBe(false);
  });
});

describe("epssOf and isLikelyExploited", () => {
  const withEpss = (percentage: number) => depAlert({ dependency: { epss: { percentage, percentile: 0.5 } } });

  it("reads a dependency alert's exploit prediction", () => {
    expect(epssOf(withEpss(0.25))).toBe(0.25);
  });

  it("answers null when none is published", () => {
    expect(epssOf(depAlert())).toBeNull();
  });

  it("answers null for code and secret alerts", () => {
    expect(epssOf(codeAlert())).toBeNull();
    expect(epssOf(secretAlert())).toBeNull();
  });

  it.each([
    [0.1, true],
    [0.099, false],
    [0.9, true],
    [0, false],
  ])("marks an exploit prediction of %s as likely exploited: %s", (percentage, expected) => {
    expect(isLikelyExploited(withEpss(percentage))).toBe(expected);
  });

  it("does not mark an alert without a prediction", () => {
    expect(isLikelyExploited(depAlert())).toBe(false);
  });
});

describe("cwesOf", () => {
  it("reads a dependency alert's weaknesses", () => {
    expect(cwesOf(depAlert({ dependency: { cwes: ["CWE-79", "CWE-1321"] } }))).toEqual(["CWE-79", "CWE-1321"]);
  });

  it("reads a code alert's weaknesses", () => {
    expect(cwesOf(codeAlert({ code: { cwes: ["CWE-94"] } }))).toEqual(["CWE-94"]);
  });

  it("normalises zero padded and lower case ids, and drops the duplicates that results in", () => {
    expect(cwesOf(codeAlert({ code: { cwes: ["CWE-020", "cwe-20", "CWE-079"] } }))).toEqual(["CWE-20", "CWE-79"]);
    expect(cwesOf(depAlert({ dependency: { cwes: ["CWE-0089", "not-a-cwe"] } }))).toEqual(["CWE-89", "not-a-cwe"]);
  });

  it("gives a secret alert none", () => {
    expect(cwesOf(secretAlert())).toEqual([]);
  });
});

describe("SEVERITY_RANK and worseSeverity", () => {
  it("ranks an unrated alert just below a real medium and above low, as the grade holds it to medium's limit", () => {
    expect(SEVERITY_RANK).toEqual({ critical: 0, high: 1, medium: 2, unknown: 3, low: 4 });
  });

  it.each([
    ["unknown", "low", "unknown"],
    ["low", "unknown", "unknown"],
    ["medium", "unknown", "medium"],
    ["unknown", "medium", "medium"],
    ["high", "unknown", "high"],
    ["low", "low", "low"],
    ["critical", "low", "critical"],
  ] as const)("takes the worse of %s and %s, which is %s", (a, b, expected) => {
    expect(worseSeverity(a, b)).toBe(expected);
  });
});
