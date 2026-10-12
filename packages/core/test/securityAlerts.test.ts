import { describe, expect, it } from "vitest";
import {
  SEVERITY_RANK,
  cwesOf,
  epssOf,
  failedSource,
  isLikelyExploited,
  isUsable,
  lastGoodRead,
  severityOf,
  usedSources,
  worseSeverity,
} from "../src/securityAlerts.js";
import { CLOSE_REASONS, type SourceState } from "../src/securityTypes.js";
import { codeAlert, depAlert, failed, noAccess, notRead, notUsed, off, ok, osvAlert, secretAlert } from "./security.js";

describe("severityOf", () => {
  it.each(["critical", "high", "medium", "low", "unknown"] as const)(
    "takes a Dependabot alert's published %s severity",
    (severity) => {
      expect(severityOf(depAlert({ severity }))).toBe(severity);
    },
  );

  it("takes an OSV alert's published severity", () => {
    expect(severityOf(osvAlert({ severity: "critical" }))).toBe("critical");
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

describe("isUsable and lastGoodRead", () => {
  it("uses a source that was read, with that read", () => {
    const state = ok("2026-10-07T08:00:00Z", { truncated: true, skipped: 2 });
    expect(isUsable(state)).toBe(true);
    expect(lastGoodRead(state)).toEqual({ readAt: "2026-10-07T08:00:00Z", truncated: true, skipped: 2 });
  });

  it("uses a source whose last attempt failed, with the earlier read it carries", () => {
    expect(isUsable(failed("2026-01-01T00:00:00Z"))).toBe(true);
    expect(lastGoodRead(failed("2026-01-01T00:00:00Z"))).toEqual({
      readAt: "2026-01-01T00:00:00Z",
      truncated: false,
      skipped: 0,
    });
  });

  it("does not use a source that failed with no earlier read", () => {
    expect(isUsable(failed(null))).toBe(false);
    expect(lastGoodRead(failed(null))).toBeNull();
  });

  it.each([
    ["off", off()],
    ["no_access", noAccess()],
    ["not_used", notUsed("dependabot_ok")],
    ["not_read", notRead()],
  ] as const)("does not use a %s source", (_, state) => {
    expect(isUsable(state)).toBe(false);
    expect(lastGoodRead(state)).toBeNull();
  });
});

describe("failedSource", () => {
  const AT = "2026-10-08T09:00:00Z";

  it("keeps the read of a source that was ok, so its alerts still count", () => {
    const state = failedSource(ok("2026-10-07T08:00:00Z", { skipped: 1 }), "GitHub did not answer", AT);
    expect(state).toEqual({
      status: "error",
      error: "GitHub did not answer",
      attemptedAt: AT,
      lastGood: { readAt: "2026-10-07T08:00:00Z", truncated: false, skipped: 1 },
    });
    expect(isUsable(state)).toBe(true);
  });

  it("keeps the read an earlier failure still carried, through any number of failures", () => {
    const twice = failedSource(failedSource(ok("2026-10-01T00:00:00Z"), "first", "2026-10-02T00:00:00Z"), "second", AT);
    expect(twice).toMatchObject({ error: "second", attemptedAt: AT, lastGood: { readAt: "2026-10-01T00:00:00Z" } });
  });

  // A read without access after a good read leaves its alerts stored but not used. A failure after that must not bring
  // those months-old alerts back into the grade.
  it("carries no read after no access, so a later failure grades nothing", () => {
    const state = failedSource(noAccess("forbidden"), "GitHub did not answer", AT);
    expect(state.lastGood).toBeNull();
    expect(isUsable(state)).toBe(false);
  });

  it.each([
    ["off", off()],
    ["not_used", notUsed("lookup_off")],
    ["not_read", notRead()],
    ["error with no earlier read", failed(null)],
  ] as const)("carries no read after a source that was %s", (_, previous: SourceState) => {
    expect(failedSource(previous, "boom", AT).lastGood).toBeNull();
  });
});

describe("usedSources", () => {
  it("uses Dependabot and leaves OSV out while Dependabot can be used, even if OSV was read", () => {
    expect(usedSources({ dependabot: ok(), code_scanning: off(), secret_scanning: noAccess(), osv: ok() })).toEqual({
      dependabot: true,
      code_scanning: false,
      secret_scanning: false,
      osv: false,
    });
  });

  it("uses OSV when Dependabot cannot be used and OSV was read", () => {
    expect(
      usedSources({ dependabot: off(), code_scanning: ok(), secret_scanning: failed("2026-10-01T00:00:00Z"), osv: ok() }),
    ).toEqual({ dependabot: false, code_scanning: true, secret_scanning: true, osv: true });
  });

  it("uses a Dependabot that failed after a good read, and not OSV", () => {
    const used = usedSources({
      dependabot: failed("2026-10-01T00:00:00Z"),
      code_scanning: ok(),
      secret_scanning: ok(),
      osv: ok(),
    });
    expect(used).toMatchObject({ dependabot: true, osv: false });
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

describe("CLOSE_REASONS", () => {
  it("is the closed set of codes an alert can be closed with, so no free text can be stored as a reason", () => {
    expect(CLOSE_REASONS).toEqual([
      // Dependabot
      "fixed",
      "auto_dismissed",
      "fix_started",
      "inaccurate",
      "no_bandwidth",
      "not_used",
      "tolerable_risk",
      // code scanning and secret scanning
      "false_positive",
      "wont_fix",
      "used_in_tests",
      "revoked",
      "pattern_edited",
      "pattern_deleted",
      // OSV
      "not_found",
    ]);
  });
});
