import { describe, expect, it } from "vitest";
import { MAX_REFS, compareAlerts, groupDependencies, securityActions, securityPlan } from "../src/securityAdvice.js";
import { gradeSecurity, usedAlerts, type SecurityFacts } from "../src/securityGrade.js";
import {
  SECURITY_ACTION_KINDS,
  type SecurityAction,
  type SecurityActionKind,
  type WorkflowFinding,
} from "../src/securityTypes.js";
import { allOk, codeAlert, controls, daysAgo, depAlert, facts, noAccess, off, posture, record, secretAlert } from "./security.js";

const finding = (risk: WorkflowFinding["risk"], file = ".github/workflows/ci.yml", line: number | null = 4): WorkflowFinding => ({
  file,
  line,
  risk,
  evidence: "x",
});
const actions = (overrides: Parameters<typeof facts>[0] = {}, staleUpdates = 0): SecurityAction[] => {
  const f = facts(overrides);
  return securityActions({ facts: f, overall: gradeSecurity(f).grade?.overall.band ?? null, staleUpdates });
};
const of = (list: SecurityAction[], kind: SecurityActionKind) => list.filter((a) => a.kind === kind);
const loose = (rules: Partial<NonNullable<ReturnType<typeof posture>>["branch"]["rules"]>) => posture({ branch: { rules } });

/** One fixture per kind, each producing that kind. */
const FIXTURES: Record<SecurityActionKind, { overrides?: Parameters<typeof facts>[0]; stale?: number }> = {
  rotate_secret: { overrides: { alerts: [secretAlert()] } },
  upgrade_dependency: { overrides: { alerts: [depAlert({ severity: "high" })] } },
  replace_dependency: { overrides: { alerts: [depAlert({ severity: "high", dependency: { patchedVersion: null } })] } },
  fix_code_alert: { overrides: { alerts: [codeAlert()] } },
  fix_pr_head_checkout: { overrides: { supplyChain: record({ findings: [finding("prHeadCheckout")] }) } },
  fix_script_injection: { overrides: { supplyChain: record({ findings: [finding("scriptInjection")] }) } },
  stop_self_hosted_public: {
    overrides: {
      supplyChain: record({ findings: [{ ...finding("selfHosted"), onPullRequest: true }] }),
      posture: posture({ visibility: "public" }),
    },
  },
  pin_actions: {
    overrides: {
      supplyChain: record({ actions: [{ file: "a.yml", line: 3, action: "zed/tool", ref: "v1", pinned: false, kind: "other" }] }),
    },
  },
  restrict_permissions: { overrides: { supplyChain: record({ findings: [finding("noPermissions")] }) } },
  remove_unsecure_commands: { overrides: { supplyChain: record({ findings: [finding("unsecureCommands")] }) } },
  remove_key_files: { overrides: { supplyChain: record({ keyFiles: [{ path: ".env", strength: "strong" }] }) } },
  require_review: { overrides: { review: controls({ merged: 20, unapproved: 5, share: 0.25 }) } },
  protect_branch: { overrides: { posture: posture({ branch: { protected: false, rules: { ...unprotectedRules() } } }) } },
  block_force_push: { overrides: { posture: loose({ blockForcePushes: false }) } },
  enable_dependabot: { overrides: { sources: { ...allOk(), dependabot: off("disabled") } } },
  pin_own_actions: {
    overrides: {
      supplyChain: record({
        actions: [{ file: "a.yml", line: 3, action: "acme/shared", ref: "main", pinned: false, kind: "other" }],
      }),
    },
  },
  add_update_config: { overrides: { supplyChain: record({ updateConfig: null }) } },
  add_lockfile: { overrides: { supplyChain: record({ missingLockfiles: ["web/package.json"] }) } },
  add_security_policy: { overrides: { supplyChain: record({ securityPolicy: null }) } },
  add_codeowners: { overrides: { supplyChain: record({ codeowners: null }) } },
  review_weak_key_files: { overrides: { supplyChain: record({ keyFiles: [{ path: "a.pem", strength: "weak" }] }) } },
  enable_code_scanning: { overrides: { sources: { ...allOk(), code_scanning: off("not_set_up") } } },
  check_secret_scanning: { overrides: { sources: { ...allOk(), secret_scanning: noAccess("admin_only_or_off") } } },
  grant_alert_access: { overrides: { sources: { ...allOk(), dependabot: noAccess("forbidden") } } },
  turn_on_code_analysis: { overrides: { supplyChain: null, supplyChainMissing: "analysis_off" } },
  fix_low_alerts: { overrides: { alerts: [depAlert({ severity: "low", createdAt: daysAgo(181) })] } },
  require_approvals: { overrides: { posture: loose({ requiredApprovals: 0 }) } },
  require_status_checks: { overrides: { posture: loose({ requireStatusChecks: false }) } },
  dismiss_stale_reviews: { overrides: { posture: loose({ dismissStaleReviews: false }) } },
  require_code_owner_review: { overrides: { posture: loose({ requireCodeOwnerReview: false }) } },
  require_signed_commits: { overrides: { posture: loose({ requireSignedCommits: false }) } },
  enable_security_updates: {
    overrides: { posture: posture({ settings: { ...posture().settings, dependabotSecurityUpdates: false } }) },
  },
  enable_push_protection: { overrides: { posture: posture({ settings: { ...posture().settings, pushProtection: false } }) } },
  enable_private_reporting: {
    overrides: { posture: posture({ settings: { ...posture().settings, privateVulnerabilityReporting: false } }) },
  },
  triage_advisories: { overrides: { posture: posture({ advisories: { draft: 1, triage: 2, published: 0, closed: 0 } }) } },
  add_dependency_review: {
    overrides: { supplyChain: record({ securityTools: [{ tool: "x", category: "sast", file: "a.yml" }] }) },
  },
  add_secret_scanner_ci: {
    overrides: {
      supplyChain: record({ securityTools: [{ tool: "x", category: "dependency_review", file: "a.yml" }] }),
      sources: { ...allOk(), secret_scanning: off("not_set_up") },
    },
  },
  add_static_analysis: {
    overrides: {
      supplyChain: record({ securityTools: [{ tool: "x", category: "dependency_review", file: "a.yml" }] }),
      sources: { ...allOk(), code_scanning: off("not_set_up") },
    },
  },
  avoid_curl_pipe_shell: { overrides: { supplyChain: record({ findings: [finding("curlPipeShell")] }) } },
  avoid_secrets_inherit: { overrides: { supplyChain: record({ findings: [finding("secretsInherit")] }) } },
  disable_persist_credentials: { overrides: { supplyChain: record({ findings: [finding("persistCredentials")] }) } },
  pin_base_images: { overrides: { supplyChain: record({ dockerfiles: [docker({ unpinnedImages: 2 })] }) } },
  avoid_latest_images: { overrides: { supplyChain: record({ dockerfiles: [docker({ latestImages: 1 })] }) } },
  run_as_non_root: { overrides: { supplyChain: record({ dockerfiles: [docker({ runsAsRoot: true })] }) } },
  avoid_remote_add: { overrides: { supplyChain: record({ dockerfiles: [docker({ addsRemote: true })] }) } },
  merge_dependency_updates: { stale: 2 },
};

function docker(overrides: Partial<ReturnType<typeof dockerBase>> = {}) {
  return { ...dockerBase(), ...overrides };
}
function dockerBase() {
  return {
    path: "Dockerfile",
    images: 3,
    unpinnedImages: 0,
    latestImages: 0,
    runsAsRoot: false,
    addsRemote: false,
    curlPipeShell: false,
  };
}
function unprotectedRules() {
  return {
    requirePullRequest: false,
    requiredApprovals: 0,
    dismissStaleReviews: false,
    requireCodeOwnerReview: false,
    requireStatusChecks: false,
    blockForcePushes: false,
    blockDeletion: false,
    requireSignedCommits: false,
    requireLinearHistory: false,
  };
}

describe("a repository with nothing to do", () => {
  it("has no actions", () => {
    expect(actions()).toEqual([]);
  });
});

describe("every kind of action", () => {
  it("has a fixture for each kind the contract names", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...SECURITY_ACTION_KINDS].sort());
  });

  it.each(SECURITY_ACTION_KINDS)("%s is reachable", (kind) => {
    const { overrides, stale } = FIXTURES[kind];
    const found = of(actions(overrides, stale), kind);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.count).toBeGreaterThan(0);
  });

  it("gives the same band to the same kind each time, and null for advice", () => {
    const bandOf = (kind: SecurityActionKind) => of(actions(FIXTURES[kind].overrides, FIXTURES[kind].stale), kind)[0]!.band;
    expect(bandOf("fix_pr_head_checkout")).toBe("low");
    expect(bandOf("restrict_permissions")).toBe("high");
    expect(bandOf("remove_key_files")).toBe("high");
    expect(bandOf("protect_branch")).toBe("high");
    expect(bandOf("require_review")).toBe("medium");
    expect(bandOf("pin_own_actions")).toBeNull();
    expect(bandOf("merge_dependency_updates")).toBeNull();
    expect(bandOf("fix_low_alerts")).toBeNull();
  });
});

describe("what each action describes", () => {
  it("rotates each secret type once, as critical, with the alert link", () => {
    const list = actions({
      alerts: [
        secretAlert({ key: "s1" }),
        secretAlert({ key: "s2", exposure: { validity: "unknown" } }),
        secretAlert({ key: "s3", exposure: { type: "aws_access_key_id", publiclyLeaked: true, validity: "inactive" } }),
        secretAlert({ key: "s4", exposure: { validity: "inactive" } }),
      ],
    });
    const rotate = of(list, "rotate_secret");
    expect(rotate.map((a) => [a.target, a.count, a.severity, a.band])).toEqual([
      ["github_personal_access_token", 2, "critical", "low"],
      ["aws_access_key_id", 1, "critical", "low"],
    ]);
    expect(rotate[0]!.refs[0]).toEqual({
      label: "GitHub Personal Access Token",
      url: "https://github.com/acme/widgets/security/secret-scanning/s1",
    });
  });

  it("upgrades a package to the highest patched version and says where it is", () => {
    const [upgrade] = of(
      actions({
        alerts: [
          depAlert({
            key: "d1",
            severity: "high",
            dependency: { patchedVersion: "4.17.19", manifestPath: "api/package-lock.json" },
          }),
          depAlert({
            key: "d2",
            severity: "critical",
            dependency: { patchedVersion: "4.17.21", manifestPath: "api/package-lock.json" },
          }),
        ],
      }),
      "upgrade_dependency",
    );
    expect(upgrade).toMatchObject({
      target: "npm:lodash",
      ecosystem: "npm",
      manifestPath: "api/package-lock.json",
      upgradeTo: "4.17.21",
      severity: "critical",
      count: 2,
      band: "medium",
    });
    expect(upgrade!.refs.map((r) => r.label)).toEqual(["lodash@4.17.0 (GHSA-d2)", "lodash@4.17.0 (GHSA-d1)"]);
  });

  it.each([
    ["direct", ["direct"], "direct"],
    ["transitive", ["transitive"], "transitive"],
    ["mixed", ["direct", "transitive"], "mixed"],
    ["null", [null], null],
  ] as const)("gives a dependency action the group's relationship when it is %s", (_name, relationships, expected) => {
    const alerts = relationships.map((relationship, i) =>
      depAlert({ key: `r${i}`, severity: "high", dependency: { relationship } }),
    );
    expect(of(actions({ alerts }), "upgrade_dependency")[0]!.relationship).toBe(expected);
  });

  it("leaves the relationship null on an action that is not about a dependency", () => {
    const list = actions({ alerts: [codeAlert(), secretAlert()] });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => a.relationship === null)).toBe(true);
  });

  it("compares versions numerically, not as text", () => {
    const alerts = ["1.2.9", "1.2.10"].map((patchedVersion, i) => depAlert({ key: `v${i}`, dependency: { patchedVersion } }));
    expect(of(actions({ alerts }), "upgrade_dependency")[0]!.upgradeTo).toBe("1.2.10");
  });

  it("still advises an upgrade when patched versions cannot be compared, without naming one", () => {
    const alerts = ["1.0.0-beta", "1.2.0"].map((patchedVersion, i) =>
      depAlert({ key: `v${i}`, severity: "high", dependency: { patchedVersion } }),
    );
    const [upgrade] = of(actions({ alerts }), "upgrade_dependency");
    expect(upgrade).toMatchObject({ upgradeTo: null, count: 2 });
  });

  it("advises replacing a package no one has patched", () => {
    const list = actions({ alerts: [depAlert({ severity: "high", dependency: { patchedVersion: null, name: "left-pad" } })] });
    expect(of(list, "replace_dependency")[0]).toMatchObject({ target: "npm:left-pad", upgradeTo: null });
    expect(of(list, "upgrade_dependency")).toEqual([]);
  });

  it("flags a package whose alert is likely to be exploited", () => {
    const alerts = [depAlert({ severity: "high", dependency: { epss: { percentage: 0.1, percentile: 0.9 } } })];
    expect(of(actions({ alerts }), "upgrade_dependency")[0]!.likelyExploited).toBe(true);
    const calm = [depAlert({ severity: "high", dependency: { epss: { percentage: 0.0999, percentile: 0.9 } } })];
    expect(of(actions({ alerts: calm }), "upgrade_dependency")[0]!.likelyExploited).toBe(false);
  });

  it("groups code alerts by rule and labels them by path and line", () => {
    const list = actions({
      alerts: [
        codeAlert({ key: "c1", code: { path: "src/a.ts", line: 3 } }),
        codeAlert({ key: "c2", code: { path: "src/b.ts", line: null } }),
        codeAlert({ key: "c3", code: { path: null, line: null } }),
        codeAlert({ key: "c4", code: { ruleId: "js/xss", securitySeverity: "medium" } }),
      ],
    });
    const rules = of(list, "fix_code_alert");
    expect(rules.map((a) => [a.target, a.count, a.severity])).toEqual([
      ["js/sql-injection", 3, "high"],
      ["js/xss", 1, "medium"],
    ]);
    expect(rules[0]!.refs.map((r) => r.label).sort()).toEqual(["js/sql-injection", "src/a.ts:3", "src/b.ts"]);
  });

  it("holds a low alert back until it is past 180 days, then offers one advice item for all of them", () => {
    expect(of(actions({ alerts: [depAlert({ severity: "low", createdAt: daysAgo(180) })] }), "fix_low_alerts")).toEqual([]);
    const list = actions({
      alerts: [
        depAlert({ severity: "low", createdAt: daysAgo(200) }),
        codeAlert({ code: { securitySeverity: "low" }, createdAt: daysAgo(300) }),
        depAlert({ severity: "low", createdAt: daysAgo(10) }),
      ],
    });
    expect(of(list, "fix_low_alerts")).toHaveLength(1);
    expect(of(list, "fix_low_alerts")[0]).toMatchObject({ count: 2, severity: "low", band: null });
    expect(of(list, "upgrade_dependency")).toEqual([]);
  });

  it("lists each workflow with a finding once, with line labels and no link", () => {
    const supplyChain = record({
      findings: [
        finding("prHeadCheckout", "b.yml", 7),
        finding("prHeadCheckout", "a.yml", 3),
        finding("prHeadCheckout", "a.yml", null),
        finding("scriptInjection", "a.yml", 9),
      ],
    });
    const list = actions({ supplyChain });
    expect(of(list, "fix_pr_head_checkout").map((a) => [a.target, a.count])).toEqual([
      ["a.yml", 2],
      ["b.yml", 1],
    ]);
    expect(of(list, "fix_pr_head_checkout")[0]!.refs).toEqual([
      { label: "a.yml:3", url: null },
      { label: "a.yml", url: null },
    ]);
    expect(of(list, "fix_script_injection")[0]!.target).toBe("a.yml");
  });

  it("asks to pin third party actions per workflow, naming the action and its ref, and own ones as advice", () => {
    const use = (file: string, action: string, ref: string | null, kind: "other" | "docker" = "other") => ({
      file,
      line: 5,
      action,
      ref,
      pinned: false,
      kind,
    });
    const supplyChain = record({
      actions: [
        use("a.yml", "zed/tool", "v2"),
        use("a.yml", "docker://alpine", null, "docker"),
        use("b.yml", "acme/own", "main"),
      ],
    });
    const list = actions({ supplyChain });
    expect(of(list, "pin_actions")).toHaveLength(1);
    expect(of(list, "pin_actions")[0]).toMatchObject({ target: "a.yml", count: 2, band: "high" });
    expect(of(list, "pin_actions")[0]!.refs.map((r) => r.label)).toEqual(["zed/tool@v2", "docker://alpine"]);
    expect(of(list, "pin_own_actions")[0]).toMatchObject({ count: 1, band: null });
  });

  it("lists strong key files in one action and weak ones as advice", () => {
    const supplyChain = record({
      keyFiles: [
        { path: ".env", strength: "strong" },
        { path: "deploy/id_rsa", strength: "strong" },
        { path: "cert.pem", strength: "weak" },
      ],
    });
    const list = actions({ supplyChain });
    expect(of(list, "remove_key_files")).toHaveLength(1);
    expect(of(list, "remove_key_files")[0]!.refs.map((r) => r.label)).toEqual([".env", "deploy/id_rsa"]);
    expect(of(list, "review_weak_key_files")[0]!.refs).toEqual([{ label: "cert.pem", url: null }]);
  });

  it("asks for review with no pull request links, and not when the share is at most 5%", () => {
    const pullRequests = [
      { number: 4, title: "Fix it", url: "https://github.com/acme/widgets/pull/4", mergedAt: daysAgo(2), selfMerged: false },
    ];
    const bad = actions({ review: controls({ merged: 10, unapproved: 3, share: 0.3, pullRequests }) });
    expect(of(bad, "require_review")[0]).toMatchObject({
      band: "medium",
      count: 3,
    });
    expect(of(bad, "require_review")[0]!.refs).toEqual([]);
    expect(of(actions({ review: controls({ merged: 100, unapproved: 5, share: 0.05 }) }), "require_review")).toEqual([]);
    expect(of(actions({ review: controls({ merged: 100, unapproved: 6, share: 0.06 }) }), "require_review")[0]!.band).toBe(
      "high",
    );
    expect(of(actions({ review: controls({ merged: 5, unapproved: 5, share: 1, graded: false }) }), "require_review")).toEqual(
      [],
    );
  });

  it("names the branch for branch actions", () => {
    expect(of(actions(FIXTURES.protect_branch.overrides), "protect_branch")[0]).toMatchObject({ target: "main", band: "high" });
    expect(of(actions(FIXTURES.block_force_push.overrides), "block_force_push")[0]!.target).toBe("main");
  });

  it("gives branch rule advice only when the branch has protection, since an unprotected one needs protect_branch first", () => {
    const unprotected = posture({ branch: { protected: false, rules: unprotectedRules() } });
    const list = actions({ posture: unprotected });
    expect(list.map((a) => a.kind)).toEqual(["protect_branch"]);
  });

  it("asks for code owner review only when a CODEOWNERS file exists", () => {
    const without = actions({ posture: loose({ requireCodeOwnerReview: false }), supplyChain: record({ codeowners: null }) });
    expect(of(without, "require_code_owner_review")).toEqual([]);
  });

  it("does not ask for stale review dismissal when no pull request is required", () => {
    const list = actions({ posture: loose({ dismissStaleReviews: false, requirePullRequest: false }) });
    expect(of(list, "dismiss_stale_reviews")).toEqual([]);
    expect(of(list, "require_approvals")).toHaveLength(1);
  });

  it("offers Dependabot only when it is off and there is something to watch", () => {
    const disabled = { ...allOk(), dependabot: off("disabled") };
    expect(of(actions({ sources: disabled }), "enable_dependabot")[0]).toMatchObject({ band: "medium", target: "dependabot" });
    expect(of(actions({ sources: { ...disabled, osv: { ...allOk().dependabot } } }), "enable_dependabot")[0]!.band).toBeNull();
    expect(of(actions({ sources: disabled, supplyChain: record({ manifestsByEcosystem: {} }) }), "enable_dependabot")).toEqual(
      [],
    );
    expect(
      of(actions({ sources: disabled, supplyChain: null, supplyChainMissing: "not_read" }), "enable_dependabot"),
    ).toHaveLength(1);
  });

  it("names each source that refused access", () => {
    const sources = {
      ...allOk(),
      dependabot: noAccess("forbidden"),
      code_scanning: noAccess("forbidden"),
      secret_scanning: noAccess("admin_only_or_off"),
    };
    const list = actions({ sources });
    expect(of(list, "grant_alert_access").map((a) => a.target)).toEqual(["code_scanning", "dependabot"]);
    expect(of(list, "check_secret_scanning")).toHaveLength(1);
  });

  it("advises tools in CI only when GitHub's own feature is not usable, but dependency review always", () => {
    const none = record({ securityTools: [] });
    const usable = of(actions({ supplyChain: none }), "add_static_analysis");
    expect(usable).toEqual([]);
    expect(of(actions({ supplyChain: none }), "add_secret_scanner_ci")).toEqual([]);
    expect(of(actions({ supplyChain: none }), "add_dependency_review")).toHaveLength(1);
  });

  it("asks for a turn-on of code analysis only when it is off, not when the read is pending", () => {
    expect(of(actions({ supplyChain: null, supplyChainMissing: "not_read" }), "turn_on_code_analysis")).toEqual([]);
  });

  it("counts dockerfile findings and lists the files", () => {
    const supplyChain = record({
      dockerfiles: [
        docker({ path: "Dockerfile", unpinnedImages: 2, curlPipeShell: true }),
        docker({ path: "api/Dockerfile", unpinnedImages: 1 }),
      ],
    });
    const list = actions({ supplyChain });
    expect(of(list, "pin_base_images")[0]).toMatchObject({ count: 3 });
    expect(of(list, "pin_base_images")[0]!.refs.map((r) => r.label)).toEqual(["Dockerfile", "api/Dockerfile"]);
    expect(of(list, "avoid_curl_pipe_shell")[0]!.count).toBe(1);
  });

  it("counts curl piped into a shell from workflows and dockerfiles together", () => {
    const supplyChain = record({ findings: [finding("curlPipeShell")], dockerfiles: [docker({ curlPipeShell: true })] });
    const found = of(actions({ supplyChain }), "avoid_curl_pipe_shell")[0]!;
    expect(found.count).toBe(2);
    expect(found.refs.map((r) => r.label)).toEqual([".github/workflows/ci.yml:4", "Dockerfile"]);
  });

  it("leaves settings that could not be seen alone", () => {
    const unseen = posture({
      settings: {
        dependabotSecurityUpdates: null,
        secretScanning: null,
        pushProtection: null,
        validityChecks: null,
        privateVulnerabilityReporting: null,
      },
      advisories: null,
    });
    expect(actions({ posture: unseen })).toEqual([]);
  });

  it("reports a settings action only when the setting is known to be off", () => {
    const off3 = posture({
      settings: {
        ...posture().settings,
        dependabotSecurityUpdates: false,
        pushProtection: false,
        privateVulnerabilityReporting: false,
      },
    });
    expect(
      actions({ posture: off3 })
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["enable_private_reporting", "enable_push_protection", "enable_security_updates"].sort());
  });
});

describe("references", () => {
  it("keeps at most ten, worst first, and counts every alert", () => {
    const alerts = Array.from({ length: 15 }, (_, i) =>
      codeAlert({ key: `c${i}`, createdAt: daysAgo(i + 1), code: { path: `src/f${i}.ts`, line: i } }),
    );
    const [rule] = of(actions({ alerts }), "fix_code_alert");
    expect(rule!.count).toBe(15);
    expect(rule!.refs).toHaveLength(MAX_REFS);
    // The oldest is listed first among equals.
    expect(rule!.refs[0]!.label).toBe("src/f14.ts:14");
  });

  it("never carries a person", () => {
    const list = actions({
      alerts: [secretAlert(), depAlert({ severity: "high" }), codeAlert()],
      review: controls({
        merged: 10,
        unapproved: 3,
        share: 0.3,
        pullRequests: [{ number: 1, title: "x", url: "u", mergedAt: daysAgo(1), selfMerged: true }],
      }),
    });
    expect(JSON.stringify(list)).not.toMatch(/alice|bob|login|author/i);
  });
});

describe("ranking", () => {
  const rank = (overrides: Parameters<typeof facts>[0], stale = 0) =>
    actions(overrides, stale).map((a) => `${a.kind}:${a.target ?? "-"}`);

  it("puts the actions on the path first, then the worst band, severity, likely exploited, count, kind and target", () => {
    const alerts = [
      depAlert({ key: "a", severity: "critical", dependency: { name: "a" } }), // medium
      depAlert({ key: "b", severity: "critical", dependency: { name: "b", epss: { percentage: 0.5, percentile: 0.99 } } }), // medium, likely
      depAlert({ key: "c", severity: "high", dependency: { name: "c" } }), // high
      depAlert({ key: "d", severity: "medium", createdAt: daysAgo(100), dependency: { name: "d" } }), // high band, medium severity
      codeAlert({ key: "e", code: { ruleId: "js/e", securitySeverity: "high" } }), // high band
    ];
    const supplyChain = record({ findings: [finding("prHeadCheckout")], missingLockfiles: ["x/package.json"] });
    expect(rank({ alerts, supplyChain })).toEqual([
      "fix_pr_head_checkout:.github/workflows/ci.yml", // low: on the path
      "upgrade_dependency:npm:b", // medium, critical, likely exploited
      "upgrade_dependency:npm:a", // medium, critical
      "upgrade_dependency:npm:c", // high band, high severity, kind before fix_code_alert
      "fix_code_alert:js/e", // high band, high severity
      "upgrade_dependency:npm:d", // high band, medium severity
      "add_lockfile:-", // advice last
    ]);
  });

  it("marks only the actions at the overall band as on the path", () => {
    const alerts = [depAlert({ severity: "critical" }), depAlert({ severity: "high", dependency: { name: "other" } })];
    const list = actions({ alerts });
    expect(list.map((a) => [a.target, a.band, a.onPath])).toEqual([
      ["npm:lodash", "medium", true],
      ["npm:other", "high", false],
    ]);
  });

  it("marks nothing on the path without a grade", () => {
    const f = facts({ alerts: [depAlert({ severity: "critical" })] });
    expect(securityActions({ facts: f, overall: null, staleUpdates: 0 }).every((a) => !a.onPath)).toBe(true);
  });

  it("puts a likely exploited action before one with more alerts at the same severity", () => {
    const alerts = [
      depAlert({ key: "1", severity: "high", dependency: { name: "quiet" } }),
      depAlert({ key: "2", severity: "high", dependency: { name: "quiet" } }),
      depAlert({ key: "3", severity: "high", dependency: { name: "loud", epss: { percentage: 0.2, percentile: 0.9 } } }),
    ];
    expect(rank({ alerts })).toEqual(["upgrade_dependency:npm:loud", "upgrade_dependency:npm:quiet"]);
  });

  it("puts the group with more alerts first when everything else is equal", () => {
    const alerts = [
      depAlert({ key: "1", severity: "high", dependency: { name: "one" } }),
      depAlert({ key: "2", severity: "high", dependency: { name: "two" } }),
      depAlert({ key: "3", severity: "high", dependency: { name: "two" } }),
    ];
    expect(rank({ alerts })).toEqual(["upgrade_dependency:npm:two", "upgrade_dependency:npm:one"]);
  });

  it("falls back to the kind's order, then the target", () => {
    const alerts = [
      depAlert({ key: "1", severity: "high", dependency: { name: "zed" } }),
      depAlert({ key: "2", severity: "high", dependency: { name: "abc" } }),
      codeAlert({ key: "3", code: { ruleId: "js/rule", securitySeverity: "high" } }),
    ];
    expect(rank({ alerts })).toEqual(["upgrade_dependency:npm:abc", "upgrade_dependency:npm:zed", "fix_code_alert:js/rule"]);
  });

  it("puts advice with a severity before advice without one, and a bandless action after any with a band", () => {
    const alerts = [
      depAlert({ severity: "medium", createdAt: daysAgo(10) }),
      depAlert({ key: "low", severity: "low", createdAt: daysAgo(200), dependency: { name: "old" } }),
    ];
    const list = rank({ alerts, supplyChain: record({ missingLockfiles: ["a/package.json"] }) });
    expect(list).toEqual(["upgrade_dependency:npm:lodash", "fix_low_alerts:-", "add_lockfile:-"]);
  });
});

describe("dependency groups", () => {
  const used = (alerts: ReturnType<typeof depAlert>[]) => usedAlerts(facts({ alerts }));

  it("sorts by worst severity, then past fix-by, then alert count, then name", () => {
    const groups = groupDependencies(
      used([
        depAlert({ key: "1", severity: "high", dependency: { name: "b" } }),
        depAlert({ key: "2", severity: "high", dependency: { name: "a" } }),
        depAlert({ key: "3", severity: "high", createdAt: daysAgo(40), dependency: { name: "c" } }),
        depAlert({ key: "4", severity: "critical", dependency: { name: "z" } }),
        depAlert({ key: "5", severity: "high", dependency: { name: "d" } }),
        depAlert({ key: "6", severity: "high", dependency: { name: "d" } }),
      ]),
    );
    expect(groups.map((g) => g.name)).toEqual(["z", "c", "d", "a", "b"]);
  });

  it("separates the same name by ecosystem and by manifest", () => {
    const groups = groupDependencies(
      used([
        depAlert({ key: "1", dependency: { name: "x", ecosystem: "npm", manifestPath: "b/package-lock.json" } }),
        depAlert({ key: "2", dependency: { name: "x", ecosystem: "npm", manifestPath: "a/package-lock.json" } }),
        depAlert({ key: "3", dependency: { name: "x", ecosystem: "PyPI", manifestPath: "uv.lock" } }),
        depAlert({ key: "4", dependency: { name: "x", ecosystem: "npm", manifestPath: "a/package-lock.json" } }),
      ]),
    );
    // One group for each ecosystem, name and manifest: npm in a, npm in b and PyPI.
    expect(groups).toHaveLength(3);
    // Ties on severity and age break by alert count, name, then ecosystem by code unit ("PyPI" before "npm"), then path.
    expect(groups.map((g) => `${g.ecosystem}:${g.manifestPath}:${g.alerts}`)).toEqual([
      "npm:a/package-lock.json:2",
      "PyPI:uv.lock:1",
      "npm:b/package-lock.json:1",
    ]);
  });

  it("lists patched versions in order, once each, and picks the highest when they compare", () => {
    const [group] = groupDependencies(
      used(
        ["1.2.10", "1.2.9", "1.2.10", null].map((patchedVersion, i) =>
          depAlert({ key: `k${i}`, dependency: { patchedVersion } }),
        ),
      ),
    );
    expect(group).toMatchObject({ patchedVersions: ["1.2.9", "1.2.10"], upgradeTo: "1.2.10" });
  });

  it("gives no upgrade target when versions do not compare, but still lists them", () => {
    const [group] = groupDependencies(
      used(["2.0.0-rc.1", "1.9.0"].map((patchedVersion, i) => depAlert({ key: `k${i}`, dependency: { patchedVersion } }))),
    );
    expect(group!.upgradeTo).toBeNull();
    expect(group!.patchedVersions).toHaveLength(2);
  });

  it("counts the alerts past their fix-by date and flags a likely exploited one", () => {
    const [group] = groupDependencies(
      used([
        depAlert({ key: "1", severity: "high", createdAt: daysAgo(31) }),
        depAlert({ key: "2", severity: "high", dependency: { epss: { percentage: 0.3, percentile: 0.9 } } }),
      ]),
    );
    expect(group).toMatchObject({ alerts: 2, pastFix: 1, likelyExploited: true, worstSeverity: "high" });
  });

  it("ignores code and secret alerts", () => {
    expect(groupDependencies(used([]).concat(usedAlerts(facts({ alerts: [codeAlert(), secretAlert()] }))))).toEqual([]);
  });

  it("orders alerts worst first, then past fix-by, likely exploited, age and key", () => {
    const used = usedAlerts(
      facts({
        alerts: [
          depAlert({ key: "a", severity: "medium", createdAt: daysAgo(5) }),
          depAlert({ key: "b", severity: "high", createdAt: daysAgo(5) }),
          depAlert({ key: "c", severity: "high", createdAt: daysAgo(35) }),
          depAlert({
            key: "d",
            severity: "high",
            createdAt: daysAgo(6),
            dependency: { epss: { percentage: 0.5, percentile: 1 } },
          }),
          depAlert({ key: "e", severity: "high", createdAt: daysAgo(5) }),
        ],
      }),
    );
    const sorted = [...used].sort(compareAlerts).map((u) => u.alert.key);
    expect(sorted).toEqual(["c", "d", "b", "e", "a"]);
  });
});

describe("with the facts typed", () => {
  it("accepts the same facts the grade reads", () => {
    const f: SecurityFacts = facts();
    expect(securityActions({ facts: f, overall: "elite", staleUpdates: 0 })).toEqual([]);
  });
});

describe("dependency groups by manifest", () => {
  const used = (alerts: ReturnType<typeof depAlert>[]) => usedAlerts(facts({ alerts }));

  it("advises each manifest of a monorepo with its own fix, not the highest fix everywhere", () => {
    const list = of(
      actions({
        alerts: [
          depAlert({
            key: "old",
            severity: "high",
            dependency: { lockedVersion: "1.2.0", patchedVersion: "1.2.9", manifestPath: "a/package-lock.json" },
          }),
          depAlert({
            key: "new",
            severity: "high",
            dependency: { lockedVersion: "2.0.0", patchedVersion: "2.4.0", manifestPath: "b/package-lock.json" },
          }),
        ],
      }),
      "upgrade_dependency",
    );
    expect(list.map((a) => [a.manifestPath, a.upgradeTo, a.count])).toEqual([
      ["a/package-lock.json", "1.2.9", 1],
      ["b/package-lock.json", "2.4.0", 1],
    ]);
  });

  it("describes a group with its manifest, locked versions lowest first and relationship", () => {
    const [group] = groupDependencies(
      used([
        depAlert({ key: "1", dependency: { lockedVersion: "1.10.0", relationship: "direct" } }),
        depAlert({ key: "2", dependency: { lockedVersion: "1.9.0", relationship: "direct" } }),
        depAlert({ key: "3", dependency: { lockedVersion: "1.10.0", relationship: "direct" } }),
        depAlert({ key: "4", dependency: { lockedVersion: null, relationship: "direct" } }),
      ]),
    );
    expect(group).toMatchObject({
      manifestPath: "package-lock.json",
      lockedVersions: ["1.9.0", "1.10.0"],
      relationship: "direct",
      alerts: 4,
    });
  });

  it.each([
    ["direct and transitive", ["direct", "transitive"], "mixed"],
    ["only transitive", ["transitive", "transitive"], "transitive"],
    ["only direct", ["direct"], "direct"],
    ["a direct one and one that says nothing", ["direct", null], "direct"],
    ["none that say", [null, null], null],
  ] as const)("calls alerts that are %s: %s", (_, relationships, expected) => {
    const [group] = groupDependencies(
      used(relationships.map((relationship, i) => depAlert({ key: `r${i}`, dependency: { relationship } }))),
    );
    expect(group!.relationship).toBe(expected);
  });

  it("orders locked versions that do not compare by text, once each", () => {
    const [group] = groupDependencies(
      used(
        ["b-snapshot", "a-snapshot", "b-snapshot"].map((lockedVersion, i) =>
          depAlert({ key: `v${i}`, dependency: { lockedVersion } }),
        ),
      ),
    );
    expect(group!.lockedVersions).toEqual(["a-snapshot", "b-snapshot"]);
  });
});

describe("an unrated severity in rankings", () => {
  const used = (alerts: ReturnType<typeof depAlert>[]) => usedAlerts(facts({ alerts }));

  it("sorts an unknown alert after a medium and before a low", () => {
    const list = used([
      depAlert({ key: "low", severity: "low" }),
      depAlert({ key: "unknown", severity: "unknown" }),
      depAlert({ key: "medium", severity: "medium" }),
    ]);
    expect([...list].sort(compareAlerts).map((u) => u.alert.key)).toEqual(["medium", "unknown", "low"]);
  });

  it("calls a package with an unknown and a low alert unknown at worst, and ranks it above a low-only package", () => {
    const groups = groupDependencies(
      used([
        depAlert({ key: "1", severity: "low", dependency: { name: "a" } }),
        depAlert({ key: "2", severity: "low", dependency: { name: "b" } }),
        depAlert({ key: "3", severity: "unknown", dependency: { name: "b" } }),
        depAlert({ key: "4", severity: "medium", dependency: { name: "c" } }),
      ]),
    );
    expect(groups.map((g) => `${g.name}:${g.worstSeverity}`)).toEqual(["c:medium", "b:unknown", "a:low"]);
  });

  it("ranks an action for an unknown alert below a medium one and above a low one at the same band", () => {
    const list = of(
      actions({
        alerts: [
          depAlert({ key: "u", severity: "unknown", createdAt: daysAgo(100), dependency: { name: "u" } }),
          depAlert({ key: "m", severity: "medium", createdAt: daysAgo(100), dependency: { name: "m" } }),
        ],
      }),
      "upgrade_dependency",
    );
    // Both are past the 90 day limit and band high; the real medium comes first, then the unrated one.
    expect(list.map((a) => a.target)).toEqual(["npm:m", "npm:u"]);
  });
});

describe("ordering by code unit", () => {
  it("breaks ties between workflow files by code unit, so a capital sorts before a lower case letter", () => {
    const list = of(
      actions({
        supplyChain: record({
          findings: [finding("prHeadCheckout", ".github/workflows/a.yml"), finding("prHeadCheckout", ".github/workflows/B.yml")],
        }),
      }),
      "fix_pr_head_checkout",
    );
    expect(list.map((a) => a.target)).toEqual([".github/workflows/B.yml", ".github/workflows/a.yml"]);
  });

  it("breaks ties between alerts by key by code unit", () => {
    const [a, b] = usedAlerts(facts({ alerts: [depAlert({ key: "a" }), depAlert({ key: "B" })] }));
    expect(compareAlerts(a!, b!)).toBeGreaterThan(0);
    expect(compareAlerts(b!, a!)).toBeLessThan(0);
  });

  it("breaks ties between packages by name by code unit", () => {
    const groups = groupDependencies(
      usedAlerts(
        facts({ alerts: [depAlert({ key: "1", dependency: { name: "a" } }), depAlert({ key: "2", dependency: { name: "B" } })] }),
      ),
    );
    expect(groups.map((g) => g.name)).toEqual(["B", "a"]);
  });
});

describe("securityPlan", () => {
  it("returns the same actions as securityActions, with the alerts that the path would clear", () => {
    const late = depAlert({ key: "late", severity: "critical", createdAt: daysAgo(10) });
    const fresh = depAlert({ key: "fresh", severity: "critical", createdAt: daysAgo(1) });
    const elsewhere = depAlert({
      key: "other",
      severity: "critical",
      createdAt: daysAgo(1),
      dependency: { manifestPath: "web/package-lock.json" },
    });
    const f = facts({ alerts: [late, fresh, elsewhere] });
    const input = { facts: f, overall: gradeSecurity(f).grade!.overall.band, staleUpdates: 0 };
    const plan = securityPlan(input);
    expect(plan.actions).toEqual(securityActions(input));
    // The package in the first manifest is on the path (band low through `late`), and upgrading it clears `fresh` too.
    // The other manifest's alert is a separate, medium action that is not on the path.
    expect(plan.onPathAlerts.map((a) => a.key).sort()).toEqual(["fresh", "late"]);
  });
});
