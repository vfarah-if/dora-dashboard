import { describe, expect, it } from "vitest";
import {
  CHECK_BAND,
  bandOfAlert,
  branchState,
  checksOfAlert,
  fixWithinDays,
  gradeSecurity,
  gradedAlerts,
  isPastFix,
  lowest,
  raisedBand,
  supplyChainFound,
  usedAlerts,
} from "../src/securityGrade.js";
import type { ActionUse, BranchRules, SecurityAlert, SecurityCheckName, WorkflowFinding } from "../src/securityTypes.js";
import {
  NOW,
  allOk,
  codeAlert,
  controls,
  daysAgo,
  depAlert,
  failed,
  facts,
  msAgo,
  noAccess,
  notRead,
  ok,
  off,
  posture,
  record,
  secretAlert,
} from "./security.js";

const DAY = 86_400_000;
const grade = (overrides: Parameters<typeof facts>[0] = {}) => gradeSecurity(facts(overrides));
const part = (overrides: Parameters<typeof facts>[0], name: "vulnerabilities" | "supplyChain" | "changeControl") =>
  grade(overrides).grade!.parts[name]!;
const finding = (risk: WorkflowFinding["risk"], file = ".github/workflows/ci.yml"): WorkflowFinding => ({
  file,
  line: 4,
  risk,
  evidence: "x",
});
const action = (overrides: Partial<ActionUse>): ActionUse => ({
  file: ".github/workflows/ci.yml",
  line: 9,
  action: "someone/tool",
  ref: "v1",
  pinned: false,
  kind: "other",
  ...overrides,
});
const withFindings = (...findings: WorkflowFinding[]) => ({ supplyChain: record({ findings }) });

describe("a repository with nothing wrong", () => {
  const result = grade();

  it("is elite in every part and names nothing", () => {
    expect(result.grade!.overall).toMatchObject({ band: "elite", check: "all" });
    expect(Object.values(result.grade!.parts).map((p) => p!.band)).toEqual(["elite", "elite", "elite"]);
    expect(result.gradeMissing).toBeNull();
  });

  it("sets limits on no check and meets every check that was measured", () => {
    expect(result.checks.some((c) => c.limits)).toBe(false);
    expect(result.checks.every((c) => c.met === true)).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual([
      "secretExposed",
      "criticalPastFix",
      "criticalOpen",
      "highPastFix",
      "dependenciesUnwatched",
      "highOpen",
      "mediumPastFix",
      "prHeadCheckout",
      "scriptInjection",
      "selfHostedPublic",
      "unpinnedActions",
      "workflowPermissions",
      "unsecureCommands",
      "keyFiles",
      "unapprovedMerges",
      "branchUnprotected",
      "forcePushAllowed",
    ]);
  });

  it("leaves nothing unmeasured", () => {
    expect(result.grade!.unmeasured).toEqual([]);
  });
});

describe("the fix-by limits", () => {
  it.each([
    ["critical", 7],
    ["high", 30],
    ["medium", 90],
    ["low", 180],
    ["unknown", 90],
  ] as const)("%s allows %i days", (severity, days) => {
    expect(fixWithinDays(severity)).toBe(days);
  });

  it.each([
    ["exactly at the limit is within it", 7 * DAY, false],
    ["a second past the limit is past it", 7 * DAY + 1000, true],
    ["a millisecond within the limit", 7 * DAY - 1, false],
  ])("a critical alert %s", (_name, age, past) => {
    expect(isPastFix("critical", msAgo(age), NOW)).toBe(past);
  });
});

describe("alert checks and the band each allows", () => {
  const critical = (age: number) => depAlert({ severity: "critical", createdAt: msAgo(age) });
  const high = (age: number) => depAlert({ severity: "high", createdAt: msAgo(age) });
  const medium = (age: number, severity: "medium" | "unknown" = "medium") => depAlert({ severity, createdAt: msAgo(age) });

  it.each([
    ["a critical alert at exactly 7 days", critical(7 * DAY), "criticalOpen", "medium"],
    ["a critical alert a second past 7 days", critical(7 * DAY + 1000), "criticalPastFix", "low"],
    ["a high alert at exactly 30 days", high(30 * DAY), "highOpen", "high"],
    ["a high alert a second past 30 days", high(30 * DAY + 1000), "highPastFix", "medium"],
    ["a medium alert a second past 90 days", medium(90 * DAY + 1000), "mediumPastFix", "high"],
    ["an unrated alert a second past 90 days", medium(90 * DAY + 1000, "unknown"), "mediumPastFix", "high"],
    ["a recent critical alert", critical(DAY), "criticalOpen", "medium"],
    ["a recent high alert", high(DAY), "highOpen", "high"],
  ] as [string, SecurityAlert, SecurityCheckName, string][])("%s sets %s and the band %s", (_name, alert, check, band) => {
    const result = part({ alerts: [alert] }, "vulnerabilities");
    expect(result).toMatchObject({ band, check });
  });

  it.each([
    ["a medium alert at exactly 90 days", medium(90 * DAY)],
    ["an unrated alert within its limit", medium(10 * DAY, "unknown")],
    ["a low alert of any age", depAlert({ severity: "low", createdAt: msAgo(1000 * DAY) })],
    ["a fixed critical alert", depAlert({ severity: "critical", state: "fixed", closedAt: daysAgo(1) })],
    ["a dismissed critical alert", depAlert({ severity: "critical", state: "dismissed", closedAt: daysAgo(1) })],
    ["a code quality alert", codeAlert({ code: { securitySeverity: null, securityTagged: false } })],
    ["an inactive secret", secretAlert({ exposure: { validity: "inactive" } })],
  ])("%s never caps the grade", (_name, alert) => {
    expect(part({ alerts: [alert] }, "vulnerabilities")).toMatchObject({ band: "elite", check: "all" });
  });

  it("counts the alerts behind a check and the age of the oldest in whole days", () => {
    const result = grade({ alerts: [critical(DAY), critical(3 * DAY + 5 * 3_600_000), high(DAY)] });
    const open = result.checks.find((c) => c.check === "criticalOpen")!;
    expect(open).toMatchObject({ value: 2, count: 2, band: "medium", met: false, oldestDays: 3, limits: true });
    expect(result.checks.find((c) => c.check === "highOpen")).toMatchObject({
      count: 1,
      band: "high",
      met: false,
      limits: false,
    });
  });

  it("takes the lowest band when several checks find something", () => {
    const result = part({ alerts: [high(DAY), critical(DAY), medium(100 * DAY)] }, "vulnerabilities");
    expect(result).toMatchObject({ band: "medium", check: "criticalOpen" });
  });

  it("names the check listed first when two tie, and limits only that one", () => {
    // criticalOpen and highPastFix both allow medium; criticalOpen is listed first.
    const result = grade({ alerts: [high(40 * DAY), critical(DAY)] });
    expect(result.grade!.parts.vulnerabilities).toMatchObject({ band: "medium", check: "criticalOpen" });
    expect(result.checks.filter((c) => c.limits).map((c) => c.check)).toEqual(["criticalOpen"]);
    expect(result.checks.find((c) => c.check === "highPastFix")).toMatchObject({ band: "medium", met: false, limits: false });
  });

  it("gives a reason that says what was found", () => {
    expect(part({ alerts: [critical(8 * DAY)] }, "vulnerabilities").reason).toBe(
      "1 critical alert has been open for more than 7 days",
    );
    expect(part({ alerts: [critical(8 * DAY), critical(9 * DAY)] }, "vulnerabilities").reason).toBe(
      "2 critical alerts have been open for more than 7 days",
    );
  });
});

describe("secrets", () => {
  it.each([
    ["active", { validity: "active" }, "secretExposed", "low"],
    ["leaked publicly although inactive", { validity: "inactive", publiclyLeaked: true }, "secretExposed", "low"],
  ] as const)("a secret that is %s allows only low", (_name, exposure, check, band) => {
    expect(part({ alerts: [secretAlert({ exposure })] }, "vulnerabilities")).toMatchObject({ band, check });
  });

  it("treats an unknown validity as a critical alert, not as an exposed secret", () => {
    const result = grade({ alerts: [secretAlert({ exposure: { validity: "unknown" } })] });
    expect(result.checks.find((c) => c.check === "secretExposed")).toMatchObject({ count: 0, met: true });
    expect(result.grade!.parts.vulnerabilities).toMatchObject({ band: "medium", check: "criticalOpen" });
  });

  it("leaves the check unmeasured, with no band, when secret scanning cannot be read", () => {
    const result = grade({ sources: { ...allOk(), secret_scanning: noAccess("admin_only_or_off") }, alerts: [secretAlert()] });
    const secrets = result.checks.find((c) => c.check === "secretExposed")!;
    expect(secrets).toEqual({ part: "vulnerabilities", check: "secretExposed", value: null, limits: false });
    expect(result.grade!.parts.vulnerabilities!.band).toBe("elite");
    expect(result.grade!.unmeasured).toContain("secrets");
  });
});

describe("which sources are used", () => {
  const osv = depAlert({ source: "osv", severity: "critical", createdAt: daysAgo(1), key: "osv-1" });
  const dependabot = depAlert({ severity: "high", createdAt: daysAgo(1), key: "dep-1" });

  it("uses Dependabot's alerts and ignores OSV's when Dependabot is usable", () => {
    const sources = { ...allOk(), osv: ok() };
    expect(gradedAlerts([osv, dependabot], sources)).toEqual([dependabot]);
  });

  it("falls back to OSV's alerts when Dependabot cannot be read", () => {
    const sources = { ...allOk(), dependabot: off("disabled"), osv: ok() };
    expect(gradedAlerts([osv, dependabot], sources)).toEqual([osv]);
    expect(part({ sources, alerts: [osv, dependabot] }, "vulnerabilities")).toMatchObject({
      band: "medium",
      check: "criticalOpen",
    });
  });

  it("uses no dependency alerts when neither is usable, even if some are stored", () => {
    const sources = { ...allOk(), dependabot: noAccess(), osv: off("lookup_off") };
    expect(gradedAlerts([osv, dependabot], sources)).toEqual([]);
  });

  it("keeps using an alert source whose last read failed when an earlier read succeeded", () => {
    const sources = { ...allOk(), dependabot: failed("2026-10-06T08:00:00Z") };
    expect(gradedAlerts([dependabot], sources)).toEqual([dependabot]);
  });

  it("drops an alert source whose read failed with nothing to fall back on", () => {
    const sources = { ...allOk(), dependabot: failed(null) };
    expect(gradedAlerts([dependabot], sources)).toEqual([]);
  });

  it("ignores code and secret alerts when their source cannot be read", () => {
    const sources = { ...allOk(), code_scanning: off("not_set_up"), secret_scanning: notRead() };
    expect(gradedAlerts([codeAlert(), secretAlert()], sources)).toEqual([]);
  });

  it("works out severity, age and the past-fix flag for the open alerts only", () => {
    const used = usedAlerts(
      facts({
        alerts: [
          depAlert({ key: "a", severity: "critical", createdAt: msAgo(8 * DAY) }),
          depAlert({ key: "b", severity: "high", state: "fixed", closedAt: daysAgo(1) }),
        ],
      }),
    );
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ severity: "critical", ageHours: 192, pastFix: true });
  });

  it("maps an alert to its checks and band", () => {
    const [secret] = usedAlerts(facts({ alerts: [secretAlert({ createdAt: msAgo(8 * DAY) })] }));
    expect(checksOfAlert(secret!)).toEqual(["secretExposed", "criticalPastFix"]);
    expect(bandOfAlert(secret!)).toBe("low");
    const [low] = usedAlerts(facts({ alerts: [depAlert({ severity: "low" })] }));
    expect(checksOfAlert(low!)).toEqual([]);
    expect(bandOfAlert(low!)).toBeNull();
  });
});

describe("Dependabot switched off", () => {
  const disabled = { ...allOk(), dependabot: off("disabled") };

  it("caps at medium when manifests exist and nothing else watches them", () => {
    const result = grade({ sources: disabled });
    expect(result.grade!.parts.vulnerabilities).toMatchObject({ band: "medium", check: "dependenciesUnwatched" });
    expect(result.checks.find((c) => c.check === "dependenciesUnwatched")).toMatchObject({ value: true, count: 1, limits: true });
  });

  it("caps at medium without a supply chain record, since manifests cannot be ruled out", () => {
    expect(part({ sources: disabled, supplyChain: null, supplyChainMissing: "analysis_off" }, "vulnerabilities")).toMatchObject({
      band: "medium",
      check: "dependenciesUnwatched",
    });
  });

  it("does not cap when the clone shows no manifest", () => {
    const supplyChain = record({ manifestsByEcosystem: {} });
    expect(part({ sources: disabled, supplyChain }, "vulnerabilities")).toMatchObject({ band: "elite", check: "all" });
  });

  it("does not cap when OSV is watching the locked dependencies", () => {
    expect(part({ sources: { ...disabled, osv: ok() } }, "vulnerabilities")).toMatchObject({ band: "elite", check: "all" });
  });

  it("measures the part even when it is the only thing known", () => {
    const sources = { dependabot: off("disabled"), code_scanning: notRead(), secret_scanning: notRead(), osv: off("lookup_off") };
    expect(part({ sources }, "vulnerabilities").check).toBe("dependenciesUnwatched");
  });

  it.each([
    ["not set up", off("not_set_up")],
    ["without access", noAccess("forbidden")],
    ["not read", notRead()],
  ])("is not counted as unwatched when it is %s", (_name, dependabot) => {
    const result = grade({ sources: { ...allOk(), dependabot } });
    expect(result.grade!.parts.vulnerabilities!.band).toBe("elite");
    expect(result.grade!.unmeasured).toContain("dependencies");
  });
});

describe("the supply chain part", () => {
  it.each([
    ["a pull request head checkout", withFindings(finding("prHeadCheckout")), "prHeadCheckout", "low"],
    ["a script injection", withFindings(finding("scriptInjection")), "scriptInjection", "low"],
    ["write-all permissions", withFindings(finding("writeAll")), "workflowPermissions", "high"],
    ["a workflow with no permissions", withFindings(finding("noPermissions")), "workflowPermissions", "high"],
    ["unsecure commands", withFindings(finding("unsecureCommands")), "unsecureCommands", "high"],
    ["a third party action not pinned", { supplyChain: record({ actions: [action({})] }) }, "unpinnedActions", "high"],
    [
      "an unpinned docker action",
      { supplyChain: record({ actions: [action({ kind: "docker", action: "docker://alpine" })] }) },
      "unpinnedActions",
      "high",
    ],
    ["a strong key file", { supplyChain: record({ keyFiles: [{ path: ".env", strength: "strong" }] }) }, "keyFiles", "high"],
  ] as [string, Parameters<typeof facts>[0], SecurityCheckName, string][])(
    "%s allows %s at %s",
    (_name, overrides, check, band) => {
      expect(part(overrides, "supplyChain")).toMatchObject({ band, check });
    },
  );

  it.each([
    ["a weak key file", record({ keyFiles: [{ path: "server.pem", strength: "weak" }] })],
    ["a pinned third party action", record({ actions: [action({ pinned: true, ref: "a".repeat(40) })] })],
    ["an unpinned action of GitHub's own", record({ actions: [action({ kind: "github", action: "actions/checkout" })] })],
    ["an unpinned local action", record({ actions: [action({ kind: "local", action: "./local" })] })],
    [
      "an unpinned action of the repository's own organisation",
      record({ actions: [action({ action: "ACME/shared/.github/workflows/x.yml" })] }),
    ],
    ["a pinned docker action", record({ actions: [action({ kind: "docker", pinned: true })] })],
    ["a curl piped to a shell, which is advice only", record({ findings: [finding("curlPipeShell")] })],
    ["a secrets inherit, which is advice only", record({ findings: [finding("secretsInherit")] })],
    ["a persisted credential, which is advice only", record({ findings: [finding("persistCredentials")] })],
  ])("does not count %s", (_name, supplyChain) => {
    expect(part({ supplyChain }, "supplyChain")).toMatchObject({ band: "elite", check: "all" });
  });

  it("counts a self-hosted runner only in a public repository", () => {
    const supplyChain = record({ findings: [{ ...finding("selfHosted"), onPullRequest: true }] });
    expect(part({ supplyChain, posture: posture({ visibility: "public" }) }, "supplyChain")).toMatchObject({
      band: "low",
      check: "selfHostedPublic",
    });
    expect(part({ supplyChain, posture: posture({ visibility: "private" }) }, "supplyChain").band).toBe("elite");
    expect(part({ supplyChain, posture: null }, "supplyChain").band).toBe("elite");
  });

  it("does not count a self-hosted runner in a public repository when pull requests never trigger the workflow", () => {
    // Only people with write access can start a push or schedule run, so nobody outside the team reaches the machine.
    const supplyChain = record({ findings: [{ ...finding("selfHosted"), onPullRequest: false }] });
    expect(part({ supplyChain, posture: posture({ visibility: "public" }) }, "supplyChain").band).toBe("elite");
  });

  it("gives the files behind a check and the share of unpinned actions", () => {
    const supplyChain = record({
      actions: [
        action({ file: "b.yml" }),
        action({ file: "a.yml", action: "other/tool" }),
        action({ pinned: true }),
        action({ kind: "local", action: "./x" }),
      ],
    });
    const check = grade({ supplyChain }).checks.find((c) => c.check === "unpinnedActions")!;
    expect(check).toMatchObject({ count: 2, total: 3, detail: ["a.yml", "b.yml"] });
  });

  it("splits actions into third party and own with the owner compared without case", () => {
    const found = supplyChainFound(
      record({
        actions: [
          action({ action: "Acme/tools" }),
          action({ action: "zed/tools" }),
          action({ action: "docker://x", kind: "docker" }),
        ],
      }),
      "acme",
      null,
    );
    expect(found.ownUnpinned.map((u) => u.action)).toEqual(["Acme/tools"]);
    expect(found.thirdPartyUnpinned.map((u) => u.action)).toEqual(["zed/tools", "docker://x"]);
  });

  it("is unmeasured without a record", () => {
    const result = grade({ supplyChain: null, supplyChainMissing: "not_read" });
    expect(result.grade!.parts.supplyChain).toBeNull();
    expect(result.grade!.unmeasured).toContain("supplyChain");
    expect(result.checks.some((c) => c.part === "supplyChain")).toBe(false);
  });
});

describe("the change control part", () => {
  it.each([
    [0, "elite"],
    [0.05, "elite"],
    [0.0501, "high"],
    [0.2, "high"],
    [0.2001, "medium"],
    [1, "medium"],
  ] as const)("a share of %f unapproved allows %s", (share, band) => {
    const review = controls({ merged: 10000, unapproved: Math.round(share * 10000), share });
    const result = part({ review }, "changeControl");
    expect(result.band).toBe(band);
    expect(result.check).toBe(band === "elite" ? "all" : "unapprovedMerges");
  });

  it("reports the figures and a reason in words", () => {
    const review = controls({ merged: 20, unapproved: 5, share: 0.25 });
    const result = grade({ review });
    expect(result.checks.find((c) => c.check === "unapprovedMerges")).toMatchObject({
      value: 0.25,
      count: 5,
      total: 20,
      band: "medium",
      met: false,
      limits: true,
    });
    expect(result.grade!.parts.changeControl!.reason).toBe(
      "25.0% of merged pull requests (5 of 20) had no approval before the merge, and the elite band allows at most 5.0%",
    );
  });

  it.each([
    ["too few merges", controls({ merged: 9, graded: false, notGradedBecause: "too_few", share: 0.5, unapproved: 4 })],
    [
      "a single author",
      controls({ merged: 30, authors: 1, graded: false, notGradedBecause: "single_author", share: 1, unapproved: 30 }),
    ],
  ])("leaves merges without a band for %s, and grades the branch alone", (_name, review) => {
    const result = grade({ review });
    const unapproved = result.checks.find((c) => c.check === "unapprovedMerges")!;
    expect(unapproved.band).toBeUndefined();
    expect(unapproved.met).toBeUndefined();
    expect(result.grade!.parts.changeControl!.band).toBe("elite");
  });

  it("is unmeasured when merges are not graded and the branch was not read", () => {
    const result = grade({ review: controls({ graded: false, merged: 2 }), posture: null });
    expect(result.grade!.parts.changeControl).toBeNull();
    expect(result.grade!.unmeasured).toEqual(["changeControl"]);
  });

  it("does not let change control alone make a grade", () => {
    const sources = { dependabot: notRead(), code_scanning: notRead(), secret_scanning: notRead(), osv: off("lookup_off") };
    const result = grade({
      sources,
      supplyChain: null,
      supplyChainMissing: "analysis_off",
      review: controls({ unapproved: 20, share: 1 }),
    });
    expect(result.grade).toBeNull();
    expect(result.gradeMissing).toBe("nothing_measured");
    expect(result.checks.find((c) => c.check === "unapprovedMerges")).toMatchObject({ band: "medium", limits: true });
  });
});

const noRules: BranchRules = {
  requirePullRequest: null,
  requiredApprovals: null,
  dismissStaleReviews: null,
  requireCodeOwnerReview: null,
  requireStatusChecks: null,
  blockForcePushes: null,
  blockDeletion: null,
  requireSignedCommits: null,
  requireLinearHistory: null,
};

describe("branch state", () => {
  const unprotected = posture({
    branch: {
      protected: false,
      detail: "full",
      rules: {
        requirePullRequest: false,
        requiredApprovals: 0,
        dismissStaleReviews: false,
        requireCodeOwnerReview: false,
        requireStatusChecks: false,
        blockForcePushes: false,
        blockDeletion: false,
        requireSignedCommits: false,
        requireLinearHistory: false,
      },
    },
  });

  it("is unprotected when there is neither protection nor a rule, and not also a force push risk", () => {
    expect(branchState(unprotected)).toEqual({ read: true, unprotected: true, forcePushAllowed: false, enforced: false });
    expect(part({ posture: unprotected }, "changeControl")).toMatchObject({ band: "high", check: "branchUnprotected" });
  });

  it("is unprotected when the whole branch was read with detail full and no rule is in force", () => {
    const full = posture({ branch: { ...unprotected.branch, detail: "full" } });
    expect(full.branch.detail).toBe("full");
    expect(branchState(full)).toEqual({ read: true, unprotected: true, forcePushAllowed: false, enforced: false });
    expect(part({ posture: full }, "changeControl")).toMatchObject({ band: "high", check: "branchUnprotected" });
  });

  it("is protected by a ruleset alone", () => {
    const ruleset = posture({ branch: { protected: false, detail: "rulesets_only", rules: { blockForcePushes: true } } });
    const nothing = { ...unprotected.branch.rules };
    const onlyRuleset = {
      ...unprotected,
      branch: { ...unprotected.branch, detail: "rulesets_only" as const, rules: { ...nothing, requireStatusChecks: true } },
    };
    expect(branchState(onlyRuleset).unprotected).toBe(false);
    expect(branchState(ruleset).unprotected).toBe(false);
  });

  it("counts required approvals as a rule", () => {
    const withApprovals = {
      ...unprotected,
      branch: { ...unprotected.branch, rules: { ...unprotected.branch.rules, requiredApprovals: 2 } },
    };
    expect(branchState(withApprovals).enforced).toBe(true);
  });

  it("flags a force push allowed on a protected branch", () => {
    const loose = posture({ branch: { rules: { blockForcePushes: false } } });
    expect(part({ posture: loose }, "changeControl")).toMatchObject({ band: "high", check: "forcePushAllowed" });
  });

  it("does not flag a force push when the rule could not be seen", () => {
    const unseen = posture({ branch: { rules: { blockForcePushes: null } } });
    expect(branchState(unseen).forcePushAllowed).toBe(false);
  });

  it("is not read when the host answered nothing about the branch", () => {
    const unread = posture({ branch: { protected: null, detail: "none", rules: noRules } });
    expect(branchState(unread)).toMatchObject({ read: false, unprotected: false });
    expect(branchState(null)).toEqual({ read: false, unprotected: false, forcePushAllowed: false, enforced: false });
  });

  it("names the branch check first when both branch checks tie and nothing else is lower", () => {
    const both = posture({ branch: { protected: true, rules: { blockForcePushes: false } } });
    expect(part({ posture: both, review: controls({ merged: 20, unapproved: 5, share: 0.25 }) }, "changeControl").check).toBe(
      "unapprovedMerges",
    );
  });
});

describe("the overall grade", () => {
  const critical = depAlert({ severity: "critical", createdAt: daysAgo(1) });
  const high = depAlert({ severity: "high", createdAt: daysAgo(1) });

  it("is the lowest measured part", () => {
    const result = grade({ alerts: [high], supplyChain: record({ findings: [finding("scriptInjection")] }) });
    expect(result.grade!.overall).toMatchObject({ part: "supplyChain", band: "low", check: "scriptInjection" });
    expect(result.grade!.overall.reason).toBe(
      "Supply chain is the lowest part. 1 privileged workflow step puts untrusted text in a script",
    );
  });

  it("names the first part, in order vulnerabilities, supply chain, change control, when they tie", () => {
    const supplyChain = record({ findings: [finding("writeAll")] }); // high
    const tied = grade({ alerts: [high], supplyChain, review: controls({ merged: 20, unapproved: 3, share: 0.15 }) });
    expect(tied.grade!.overall).toMatchObject({ part: "vulnerabilities", band: "high", check: "highOpen" });
    const noAlert = grade({ supplyChain, review: controls({ merged: 20, unapproved: 3, share: 0.15 }) });
    expect(noAlert.grade!.overall).toMatchObject({ part: "supplyChain", band: "high" });
    const reviewOnly = grade({ review: controls({ merged: 20, unapproved: 3, share: 0.15 }) });
    expect(reviewOnly.grade!.overall).toMatchObject({ part: "changeControl", check: "unapprovedMerges" });
  });

  it("is lowered by change control when it is the lowest", () => {
    const result = grade({ alerts: [critical], review: controls({ merged: 10, unapproved: 10, share: 1 }) });
    expect(result.grade!.overall).toMatchObject({ part: "vulnerabilities", band: "medium" });
    const bad = grade({ alerts: [high], review: controls({ merged: 10, unapproved: 10, share: 1 }) });
    expect(bad.grade!.overall).toMatchObject({ part: "changeControl", band: "medium" });
  });

  it("sets limits only on the check behind each part, not on equal checks elsewhere", () => {
    const result = grade({ alerts: [high], supplyChain: record({ findings: [finding("writeAll")] }) });
    expect(result.checks.filter((c) => c.limits).map((c) => c.check)).toEqual(["highOpen", "workflowPermissions"]);
  });
});

describe("a grade that cannot be given", () => {
  it("is missing as not crawled before the first crawl, whatever else is known", () => {
    const result = grade({ crawled: false, alerts: [depAlert({ severity: "critical" })] });
    expect(result).toEqual({ grade: null, checks: [], gradeMissing: "not_crawled" });
  });

  it("is missing as nothing measured when neither alerts nor the clone were read", () => {
    const sources = {
      dependabot: notRead(),
      code_scanning: noAccess(),
      secret_scanning: off("not_set_up"),
      osv: off("lookup_off"),
    };
    const result = grade({ sources, supplyChain: null, supplyChainMissing: "analysis_off" });
    expect(result.grade).toBeNull();
    expect(result.gradeMissing).toBe("nothing_measured");
  });

  it("is still given from the clone alone, naming what is unmeasured", () => {
    const sources = { dependabot: notRead(), code_scanning: notRead(), secret_scanning: notRead(), osv: off("lookup_off") };
    const result = grade({ sources });
    expect(result.grade!.parts.vulnerabilities).toBeNull();
    expect(result.grade!.unmeasured).toEqual(["dependencies", "code", "secrets"]);
  });

  it("is still given from alerts alone", () => {
    const result = grade({
      supplyChain: null,
      supplyChainMissing: "analysis_off",
      review: controls({ graded: false }),
      posture: null,
    });
    expect(result.grade!.unmeasured).toEqual(["supplyChain", "changeControl"]);
    expect(result.grade!.overall.band).toBe("elite");
  });
});

describe("raising the grade", () => {
  it("is null at elite and when there is no grade", () => {
    expect(raisedBand(facts())).toBeNull();
    expect(raisedBand(facts({ crawled: false }))).toBeNull();
  });

  it("clears every check at the overall band and reads the band again", () => {
    // Two checks at medium (critical open, high past fix) and one at high (workflow permissions).
    const alerts = [
      depAlert({ severity: "critical", createdAt: daysAgo(1) }),
      depAlert({ severity: "high", createdAt: daysAgo(40) }),
    ];
    const supplyChain = record({ findings: [finding("writeAll")] });
    expect(raisedBand(facts({ alerts, supplyChain }))).toBe("high");
  });

  it("stops at the next obstacle, which may be two bands up", () => {
    const alerts = [depAlert({ severity: "critical", createdAt: daysAgo(10) })];
    expect(raisedBand(facts({ alerts }))).toBe("elite");
  });

  it("clears the merges first, then reads the branch that is left", () => {
    const loose = posture({ branch: { rules: { blockForcePushes: false } } });
    const review = controls({ merged: 10, unapproved: 3, share: 0.3 });
    expect(raisedBand(facts({ posture: loose, review }))).toBe("high");
  });

  it("clears the unwatched dependencies", () => {
    expect(raisedBand(facts({ sources: { ...allOk(), dependabot: off("disabled") } }))).toBe("elite");
  });

  it("raises from low to the band of the next check up", () => {
    const alerts = [
      depAlert({ severity: "critical", createdAt: daysAgo(10) }),
      depAlert({ severity: "high", createdAt: daysAgo(1) }),
    ];
    expect(raisedBand(facts({ alerts }))).toBe("high");
  });
});

describe("what could not be measured", () => {
  it.each([
    ["Dependabot not read", { ...allOk(), dependabot: notRead() }, ["dependencies"]],
    ["Dependabot refused and OSV off", { ...allOk(), dependabot: noAccess() }, ["dependencies"]],
    ["Dependabot refused but OSV read", { ...allOk(), dependabot: noAccess(), osv: ok() }, []],
    ["code scanning off", { ...allOk(), code_scanning: off("needs_advanced_security") }, ["code"]],
    ["secret scanning refused", { ...allOk(), secret_scanning: noAccess("admin_only_or_off") }, ["secrets"]],
    ["a failed read with an earlier one", { ...allOk(), code_scanning: failed("2026-10-01T00:00:00Z") }, []],
    ["a failed read with none before", { ...allOk(), code_scanning: failed() }, ["code"]],
  ] as const)("%s leaves %j unmeasured", (_name, sources, expected) => {
    expect(grade({ sources }).grade!.unmeasured).toEqual(expected);
  });
});

describe("small helpers", () => {
  it("picks the lowest band, or null for none", () => {
    expect(lowest([null, "high", "medium", "elite"])).toBe("medium");
    expect(lowest([null])).toBeNull();
    expect(lowest([])).toBeNull();
  });

  it("publishes a band for every fixed check", () => {
    expect(Object.keys(CHECK_BAND)).toHaveLength(16);
  });
});

describe("the reason for each check", () => {
  const sc = (overrides: Parameters<typeof record>[0]) => ({ supplyChain: record(overrides) });
  const cases: [string, Parameters<typeof facts>[0], string][] = [
    ["secretExposed", { alerts: [secretAlert()] }, "1 open secret alert still work or was leaked publicly"],
    ["criticalOpen", { alerts: [depAlert({ severity: "critical" })] }, "1 critical alert is open"],
    [
      "highPastFix",
      { alerts: [depAlert({ severity: "high", createdAt: daysAgo(31) })] },
      "1 high alert has been open for more than 30 days",
    ],
    ["highOpen", { alerts: [depAlert({ severity: "high" })] }, "1 high alert is open"],
    [
      "mediumPastFix",
      { alerts: [depAlert({ severity: "medium", createdAt: daysAgo(91) })] },
      "1 medium alert has been open for more than 90 days",
    ],
    [
      "dependenciesUnwatched",
      { sources: { ...allOk(), dependabot: off("disabled") } },
      "Dependabot is switched off and nothing else watches the dependencies",
    ],
    [
      "prHeadCheckout",
      sc({ findings: [finding("prHeadCheckout")] }),
      "1 privileged workflow step checks out code from a pull request",
    ],
    [
      "selfHostedPublic",
      { ...sc({ findings: [{ ...finding("selfHosted"), onPullRequest: true }] }), posture: posture({ visibility: "public" }) },
      "A public repository runs pull requests on a self-hosted runner",
    ],
    [
      "unpinnedActions",
      sc({ actions: [action({}), action({ action: "x/y" })] }),
      "2 third party actions are not pinned to a commit",
    ],
    [
      "workflowPermissions",
      sc({ findings: [finding("writeAll")] }),
      "1 workflow grants more token access than needed or set none",
    ],
    [
      "unsecureCommands",
      sc({ findings: [finding("unsecureCommands")] }),
      "A workflow switches on the deprecated unsecure commands",
    ],
    ["keyFiles", sc({ keyFiles: [{ path: ".env", strength: "strong" }] }), "1 file that looks like keys or secrets is committed"],
    [
      "branchUnprotected",
      {
        posture: posture({
          branch: {
            protected: false,
            rules: {
              requirePullRequest: false,
              requiredApprovals: 0,
              dismissStaleReviews: false,
              requireCodeOwnerReview: false,
              requireStatusChecks: false,
              blockForcePushes: false,
              blockDeletion: false,
              requireSignedCommits: false,
              requireLinearHistory: false,
            },
          },
        }),
      },
      "The deploy branch has no protection and no rules",
    ],
    [
      "forcePushAllowed",
      { posture: posture({ branch: { rules: { blockForcePushes: false } } }) },
      "Force pushes are allowed on the deploy branch",
    ],
  ];

  it.each(cases)("%s says what was found", (check, overrides, reason) => {
    const result = grade(overrides).grade!;
    const limiting = Object.values(result.parts).find((p) => p?.check === check)!;
    expect(limiting.reason).toBe(reason);
  });
});

describe("raising the band by alert, not by check name", () => {
  it("reaches elite by rotating an active secret that feeds both a low and a medium check", () => {
    const f = facts({ alerts: [secretAlert()] });
    const checks = gradeSecurity(f).checks;
    // One active, one day old secret: `secretExposed` (low) and `criticalOpen` (medium) both count it.
    expect(checks.find((c) => c.check === "secretExposed")).toMatchObject({ count: 1, band: "low" });
    expect(checks.find((c) => c.check === "criticalOpen")).toMatchObject({ count: 1, band: "medium" });
    expect(gradeSecurity(f).grade!.overall).toMatchObject({ band: "low", check: "secretExposed" });
    expect(raisedBand(f)).toBe("elite");
  });

  it("stops at medium when another critical alert still feeds the medium check", () => {
    const f = facts({ alerts: [secretAlert({ key: "s" }), depAlert({ key: "d", severity: "critical" })] });
    expect(raisedBand(f)).toBe("medium");
  });

  it("clears every check an alert feeds, past fix-by or not", () => {
    // Old and past its 7 days: `criticalPastFix` (low). It feeds no other check, so removing it leaves nothing.
    expect(raisedBand(facts({ alerts: [depAlert({ severity: "critical", createdAt: daysAgo(10) })] }))).toBe("elite");
  });

  it("takes away the further alerts the caller says the work would clear", () => {
    const late = depAlert({ key: "late", severity: "critical", createdAt: daysAgo(10) });
    const fresh = depAlert({ key: "fresh", severity: "critical", createdAt: daysAgo(1) });
    const f = facts({ alerts: [late, fresh] });
    // Clearing the low check removes `late` only, which leaves `fresh` feeding the medium check.
    expect(raisedBand(f)).toBe("medium");
    expect(raisedBand(f, undefined, [fresh])).toBe("elite");
  });

  it("is null when elite or without a grade", () => {
    expect(raisedBand(facts())).toBeNull();
    expect(raisedBand(facts({ crawled: false }))).toBeNull();
  });
});

describe("a branch read only through rulesets", () => {
  const rulesetsOnly = (rules: Partial<BranchRules>) =>
    posture({ branch: { protected: null, detail: "rulesets_only", rules: { ...noRules, ...rules } } });
  const unreviewed = controls({ graded: false, notGradedBecause: "too_few", share: null, merged: 3 });

  it("is not read, and not called unprotected, when the branch call failed and rulesets held no rule", () => {
    expect(branchState(rulesetsOnly({}))).toEqual({ read: false, unprotected: false, forcePushAllowed: false, enforced: false });
    expect(
      branchState(rulesetsOnly({ requireStatusChecks: false, blockForcePushes: false, requiredApprovals: 0 })),
    ).toMatchObject({
      read: false,
      unprotected: false,
    });
  });

  it("is not graded for the branch check, and names change control as unmeasured when reviews are not graded", () => {
    const result = grade({ posture: rulesetsOnly({}), review: unreviewed });
    expect(result.grade!.parts.changeControl).toBeNull();
    expect(result.grade!.unmeasured).toContain("changeControl");
    expect(result.checks.some((c) => c.check === "branchUnprotected")).toBe(false);
  });

  it("reports the branch check as not measured, not as found, when reviews are graded", () => {
    const checks = grade({ posture: rulesetsOnly({}) }).checks;
    expect(checks.find((c) => c.check === "branchUnprotected")).toEqual({
      part: "changeControl",
      check: "branchUnprotected",
      value: null,
      limits: false,
    });
  });

  it("is protected, and read, when a ruleset has a rule in force", () => {
    expect(branchState(rulesetsOnly({ blockForcePushes: true }))).toEqual({
      read: true,
      unprotected: false,
      forcePushAllowed: false,
      enforced: true,
    });
    expect(branchState(rulesetsOnly({ requiredApprovals: 1 }))).toMatchObject({ read: true, unprotected: false });
  });

  it("is unprotected only when classic protection said false and no rule is in force", () => {
    const classicOff = posture({ branch: { protected: false, detail: "rulesets_only", rules: noRules } });
    expect(branchState(classicOff)).toMatchObject({ read: true, unprotected: true });
  });
});
