import { describe, expect, it, vi } from "vitest";
import type { AlertRead } from "../src/interfaces/security-alert-source.js";
import { RATE_LIMIT_MESSAGE } from "../src/infrastructure/github/github-http.js";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { GitHubSecurityAlertSource } from "../src/infrastructure/github/github-security-alert-source.js";

/** An `ok` read, with alerts whose fields the test looks into by name, or a failure if the read was not `ok`. */
const ok = (read: AlertRead): Loose & { skipped: number; status: string } => {
  if (read.status !== "ok") throw new Error(`expected an ok read, got ${read.status}`);
  return read as unknown as Loose & { skipped: number; status: string };
};

type Loose = {
  alerts: { severity: string; key: string; url: string | null; dependency: { epss: unknown }; exposure: unknown }[];
  truncated: boolean;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const refusal = (status: number, message: string, headers: Record<string, string> = {}) => json({ message }, status, headers);

const API = "https://api.github.com";
const REPO = `${API}/repos/acme/widgets`;

/** A fetch that answers by exact URL (query string included) and records each request. */
function host(routes: Record<string, () => Response>) {
  const http = vi.fn(async (url: string | URL | Request) => {
    const answer = routes[String(url)];
    if (!answer) throw new Error(`unexpected request ${String(url)}`);
    return answer();
  });
  return http;
}

const urlsOf = (http: ReturnType<typeof vi.fn>) => http.mock.calls.map((call) => String(call[0]));
const headersOf = (http: ReturnType<typeof vi.fn>, call = 0) =>
  (http.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
const listUrl = (path: string, extra = "") => `${REPO}/${path}?per_page=100&sort=updated&direction=desc${extra}`;

const dependabotRaw = {
  number: 7,
  state: "dismissed",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-04T10:00:00Z",
  dismissed_at: "2026-09-03T10:00:00Z",
  dismissed_by: { login: "dismisser-login" },
  dismissed_reason: "tolerable_risk",
  dismissed_comment: "free text the dismisser typed",
  assignees: [{ login: "assignee-login" }],
  html_url: "https://github.com/acme/widgets/security/dependabot/7",
  dependency: {
    package: { ecosystem: "npm", name: "lodash" },
    manifest_path: "package-lock.json",
    scope: "runtime",
    relationship: "transitive",
  },
  security_advisory: {
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    cve_id: "CVE-2021-23337",
    summary: "Prototype pollution in lodash",
    description: "A long description written by the advisory author",
    severity: "moderate",
    cvss: { score: 6.1 },
    cvss_severities: { cvss_v3: { score: 7.2 }, cvss_v4: { score: 0 } },
    epss: [{ percentage: 0.12, percentile: 0.93 }],
    cwes: [{ cwe_id: "CWE-094", name: "Code Injection" }, { cwe_id: "not-a-cwe" }],
  },
  security_vulnerability: {
    severity: "high",
    vulnerable_version_range: "< 4.17.21",
    first_patched_version: { identifier: "4.17.21" },
  },
};

const codeRaw = {
  number: 12,
  state: "dismissed",
  created_at: "2026-09-02T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
  dismissed_at: "2026-09-04T10:00:00Z",
  dismissed_by: { login: "dismisser-login" },
  dismissed_reason: "won't fix",
  dismissed_comment: "we will not fix this",
  html_url: "https://github.com/acme/widgets/security/code-scanning/12",
  rule: {
    id: "js/weak-cryptographic-algorithm",
    severity: "error",
    security_severity_level: "high",
    description: "Use of a broken or weak cryptographic algorithm",
    help: "LONG HELP TEXT that must never be stored",
    full_description: "LONG FULL DESCRIPTION that must never be stored",
    tags: [
      "security",
      "external/cwe/cwe-327",
      "external/cwe/cwe-0328",
      "external/cwe/cwe-020",
      "external/cwe/CWE-20",
      "maintainability",
    ],
  },
  tool: { name: "CodeQL", version: "2.17.0" },
  most_recent_instance: {
    location: { path: "src/crypto.ts", start_line: 14 },
    message: { text: "message with a person's code" },
  },
};

const secretRaw = {
  number: 3,
  state: "resolved",
  resolution: "revoked",
  created_at: "2026-09-03T10:00:00Z",
  updated_at: "2026-09-06T10:00:00Z",
  resolved_at: "2026-09-05T10:00:00Z",
  resolved_by: { login: "resolver-login" },
  resolution_comment: "rotated it",
  secret: "ghp_THISISTHESECRETVALUE0123456789",
  secret_type: "github_personal_access_token",
  secret_type_display_name: "GitHub Personal Access Token",
  validity: "inactive",
  publicly_leaked: true,
  push_protection_bypassed: true,
  push_protection_bypassed_by: { login: "bypasser-login" },
  html_url: "https://github.com/acme/widgets/security/secret-scanning/3",
};

describe("GitHubSecurityAlertSource alerts", () => {
  it("maps a Dependabot alert, asking for 100 to a page with the token and no secret parameter", async () => {
    const http = host({ [listUrl("dependabot/alerts")]: () => json([dependabotRaw]) });

    const read = await new GitHubSecurityAlertSource(http).dependencyAlerts("tok", "acme", "widgets");

    expect(read).toEqual({
      status: "ok",
      truncated: false,
      skipped: 0,
      skippedKeys: [],
      alerts: [
        {
          source: "dependabot",
          key: "7",
          state: "dismissed",
          createdAt: "2026-09-01T10:00:00Z",
          closedAt: "2026-09-03T10:00:00Z",
          closeReason: "tolerable_risk",
          title: "Prototype pollution in lodash",
          url: "https://github.com/acme/widgets/security/dependabot/7",
          severity: "medium",
          dependency: {
            ecosystem: "npm",
            name: "lodash",
            manifestPath: "package-lock.json",
            scope: "runtime",
            relationship: "transitive",
            lockedVersion: null,
            patchedVersion: "4.17.21",
            vulnerableRange: "< 4.17.21",
            advisoryId: "GHSA-aaaa-bbbb-cccc",
            cveId: "CVE-2021-23337",
            // The v4 score is 0, which GitHub sends for "none", so the v3 score is used.
            cvssScore: 7.2,
            epss: { percentage: 0.12, percentile: 0.93 },
            cwes: ["CWE-94"],
          },
        },
      ],
    });
    expect(headersOf(http)["Authorization"]).toBe("Bearer tok");
    expect(urlsOf(http)[0]).not.toContain("hide_secret");
  });

  it.each([
    ["fixed", { state: "fixed", fixed_at: "2026-09-02T00:00:00Z" }, "fixed", "2026-09-02T00:00:00Z", "fixed"],
    [
      "auto_dismissed",
      { state: "auto_dismissed", auto_dismissed_at: "2026-09-02T01:00:00Z" },
      "dismissed",
      "2026-09-02T01:00:00Z",
      "auto_dismissed",
    ],
    ["open", { state: "open" }, "open", null, null],
    // A dismissal reason GitHub might add later is not stored, because only known codes are.
    [
      "unknown reason",
      { state: "dismissed", dismissed_at: "2026-09-02T02:00:00Z", dismissed_reason: "because I said so" },
      "dismissed",
      "2026-09-02T02:00:00Z",
      null,
    ],
    // A closed alert with no close time takes its last update, the latest it can have closed.
    [
      "no close time",
      { state: "fixed", fixed_at: null, updated_at: "2026-09-07T00:00:00Z" },
      "fixed",
      "2026-09-07T00:00:00Z",
      "fixed",
    ],
  ])("maps a Dependabot %s alert", async (_label, change, state, closedAt, closeReason) => {
    const http = host({
      [listUrl("dependabot/alerts")]: () => json([{ ...dependabotRaw, dismissed_at: null, dismissed_reason: null, ...change }]),
    });
    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));
    const [alert] = read.alerts;
    expect(alert).toMatchObject({ state, closedAt, closeReason });
  });

  it("reads severity from the vulnerability when the advisory has none, and as unknown when neither does", async () => {
    const bare = { ...dependabotRaw, security_advisory: { ghsa_id: "GHSA-x" }, security_vulnerability: { severity: "critical" } };
    const none = {
      ...dependabotRaw,
      number: 8,
      security_advisory: undefined,
      security_vulnerability: undefined,
      dependency: undefined,
    };
    const http = host({ [listUrl("dependabot/alerts")]: () => json([bare, none]) });

    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));

    expect(read.alerts.map((a) => a.severity)).toEqual(["critical", "unknown"]);
    expect(read.alerts[1]).toMatchObject({
      title: "Vulnerable dependency",
      // A package GitHub did not name stays unnamed, rather than becoming one that unrelated alerts would share.
      dependency: { ecosystem: null, name: null, manifestPath: null, advisoryId: null },
    });
  });

  it("leaves a code scanning rule that has no id unnamed, and titles the alert without inventing one", async () => {
    const http = host({ [listUrl("code-scanning/alerts")]: () => json([{ ...codeRaw, rule: { severity: "error" } }]) });

    const read = ok(await new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets"));

    expect(read.alerts[0]).toMatchObject({ title: "Code scanning alert", code: { ruleId: null } });
  });

  it("accepts an exploit prediction sent as one object and one that lacks a figure", async () => {
    const object = {
      ...dependabotRaw,
      security_advisory: { ...dependabotRaw.security_advisory, epss: { percentage: 0.5, percentile: 0.7 } },
    };
    const partial = {
      ...dependabotRaw,
      number: 9,
      security_advisory: { ...dependabotRaw.security_advisory, epss: { percentage: 0.5 } },
    };
    const http = host({ [listUrl("dependabot/alerts")]: () => json([object, partial]) });

    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));

    expect(read.alerts.map((a) => a.dependency.epss)).toEqual([{ percentage: 0.5, percentile: 0.7 }, null]);
  });

  it("reads an exploit prediction sent as text, and drops one that is not a finite number", async () => {
    const withEpss = (number: number, epss: unknown) => ({
      ...dependabotRaw,
      number,
      security_advisory: { ...dependabotRaw.security_advisory, epss },
    });
    const http = host({
      [listUrl("dependabot/alerts")]: () =>
        json([
          withEpss(1, [{ percentage: "0.12345", percentile: "0.16001e0" }]),
          withEpss(2, [{ percentage: 0.5, percentile: "high" }]),
          withEpss(3, [{ percentage: "", percentile: 0.2 }]),
          withEpss(4, [{ percentage: null, percentile: true }]),
        ]),
    });

    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));

    expect(read.alerts.map((a) => a.dependency.epss)).toEqual([{ percentage: 0.12345, percentile: 0.16001 }, null, null, null]);
  });

  it("maps a code scanning alert, keeping the rule's coded fields and CWE tags and nothing it wrote", async () => {
    const http = host({ [listUrl("code-scanning/alerts")]: () => json([codeRaw]) });

    const read = await new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets");

    expect(read).toEqual({
      status: "ok",
      truncated: false,
      skipped: 0,
      skippedKeys: [],
      alerts: [
        {
          source: "code_scanning",
          key: "12",
          state: "dismissed",
          createdAt: "2026-09-02T10:00:00Z",
          closedAt: "2026-09-04T10:00:00Z",
          closeReason: "wont_fix",
          title: "Use of a broken or weak cryptographic algorithm",
          url: "https://github.com/acme/widgets/security/code-scanning/12",
          code: {
            ruleId: "js/weak-cryptographic-algorithm",
            tool: "CodeQL",
            ruleSeverity: "error",
            securitySeverity: "high",
            securityTagged: true,
            path: "src/crypto.ts",
            line: 14,
            cwes: ["CWE-327", "CWE-328", "CWE-20"],
          },
        },
      ],
    });
  });

  it("leaves a quality rule untagged, and falls back to the rule name when it has no description", async () => {
    const quality = {
      ...codeRaw,
      state: "open",
      dismissed_at: null,
      dismissed_reason: null,
      rule: { id: "js/unused-variable", name: "Unused variable", severity: "note", tags: ["maintainability"] },
      most_recent_instance: undefined,
    };
    const http = host({ [listUrl("code-scanning/alerts")]: () => json([quality]) });

    const read = ok(await new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets"));

    expect(read.alerts[0]).toMatchObject({
      title: "Unused variable",
      closedAt: null,
      closeReason: null,
      code: { securityTagged: false, securitySeverity: null, ruleSeverity: "note", path: null, line: null, cwes: [] },
    });
  });

  it("maps a secret scanning alert and sends hide_secret=true", async () => {
    const http = host({ [listUrl("secret-scanning/alerts", "&hide_secret=true")]: () => json([secretRaw]) });

    const read = await new GitHubSecurityAlertSource(http).secretAlerts("t", "acme", "widgets");

    expect(read).toEqual({
      status: "ok",
      truncated: false,
      skipped: 0,
      skippedKeys: [],
      alerts: [
        {
          source: "secret_scanning",
          key: "3",
          state: "fixed",
          createdAt: "2026-09-03T10:00:00Z",
          closedAt: "2026-09-05T10:00:00Z",
          closeReason: "revoked",
          title: "GitHub Personal Access Token",
          url: "https://github.com/acme/widgets/security/secret-scanning/3",
          exposure: {
            type: "GitHub Personal Access Token",
            validity: "inactive",
            publiclyLeaked: true,
            pushProtectionBypassed: true,
          },
        },
      ],
    });
    expect(urlsOf(http)[0]).toContain("hide_secret=true");
  });

  it("treats a secret resolved for any reason but revocation as dismissed, and an open one as open with unknown validity", async () => {
    const wont = { ...secretRaw, number: 4, resolution: "wont_fix" };
    const open = {
      ...secretRaw,
      number: 5,
      state: "open",
      resolution: null,
      resolved_at: null,
      validity: undefined,
      secret_type_display_name: undefined,
      publicly_leaked: false,
      push_protection_bypassed: false,
    };
    const http = host({ [listUrl("secret-scanning/alerts", "&hide_secret=true")]: () => json([wont, open]) });

    const read = ok(await new GitHubSecurityAlertSource(http).secretAlerts("t", "acme", "widgets"));

    expect(read.alerts[0]).toMatchObject({ state: "dismissed", closeReason: "wont_fix" });
    expect(read.alerts[1]).toMatchObject({
      state: "open",
      closedAt: null,
      closeReason: null,
      title: "github_personal_access_token",
    });
    expect(read.alerts[1]!.exposure).toEqual({
      type: "github_personal_access_token",
      validity: "unknown",
      publiclyLeaked: false,
      pushProtectionBypassed: false,
    });
  });

  it("never maps a person, free text, the rule's help or the secret itself, from any source", async () => {
    const http = host({
      [listUrl("dependabot/alerts")]: () => json([dependabotRaw]),
      [listUrl("code-scanning/alerts")]: () => json([codeRaw]),
      [listUrl("secret-scanning/alerts", "&hide_secret=true")]: () => json([secretRaw]),
    });
    const source = new GitHubSecurityAlertSource(http);

    const all = JSON.stringify([
      await source.dependencyAlerts("t", "acme", "widgets"),
      await source.codeAlerts("t", "acme", "widgets"),
      await source.secretAlerts("t", "acme", "widgets"),
    ]);

    for (const forbidden of [
      "dismisser-login",
      "assignee-login",
      "resolver-login",
      "bypasser-login",
      "free text the dismisser typed",
      "we will not fix this",
      "rotated it",
      "LONG HELP TEXT",
      "LONG FULL DESCRIPTION",
      "long description written",
      "message with a person",
      "ghp_THISISTHESECRETVALUE",
    ]) {
      expect(all).not.toContain(forbidden);
    }
    // No stored field is called `secret`, and no field names a person.
    expect(all).not.toMatch(/"secret"|dismissed_by|resolved_by|assignees|dismissed_comment|"login"/);
  });

  it("keeps hide_secret=true on every page even when the next link drops it", async () => {
    const second = `${listUrl("secret-scanning/alerts", "&page=2")}`;
    const http = host({
      [listUrl("secret-scanning/alerts", "&hide_secret=true")]: () => json([secretRaw], 200, { link: `<${second}>; rel="next"` }),
      [`${second}&hide_secret=true`]: () => json([{ ...secretRaw, number: 4 }]),
    });

    const read = ok(await new GitHubSecurityAlertSource(http).secretAlerts("t", "acme", "widgets"));

    expect(read.alerts).toHaveLength(2);
    expect(urlsOf(http).every((url) => url.includes("hide_secret=true"))).toBe(true);
  });

  it("follows the next link to the end and reads nothing after the last page", async () => {
    const page2 = listUrl("dependabot/alerts", "&page=2");
    const page3 = listUrl("dependabot/alerts", "&page=3");
    const http = host({
      [listUrl("dependabot/alerts")]: () =>
        json([dependabotRaw], 200, { link: `<${page2}>; rel="next", <${page3}>; rel="last"` }),
      [page2]: () => json([{ ...dependabotRaw, number: 8 }], 200, { link: `<${page3}>; rel="next"` }),
      [page3]: () => json([{ ...dependabotRaw, number: 9 }]),
    });

    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));

    expect(read.alerts.map((a) => a.key)).toEqual(["7", "8", "9"]);
    expect(read.truncated).toBe(false);
    expect(http).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["another host", "https://evil.example.test/steal?page=2"],
    ["the same host over http", "http://api.github.com/repos/acme/widgets/dependabot/alerts?page=2"],
    ["a different port", "https://api.github.com:8443/repos/acme/widgets/dependabot/alerts?page=2"],
  ])(
    "does not follow a next link to %s, so the token goes nowhere else, and says the list was cut short",
    async (_label, target) => {
      const http = host({
        [listUrl("dependabot/alerts")]: () => json([dependabotRaw], 200, { link: `<${target}>; rel="next"` }),
      });

      const read = (await new GitHubSecurityAlertSource(http).dependencyAlerts("secret-token", "acme", "widgets")) as {
        alerts: unknown[];
        truncated: boolean;
      };

      expect(read.alerts).toHaveLength(1);
      // The list went on, so the caller must not prune the alerts on the pages that were not read.
      expect(read.truncated).toBe(true);
      expect(http).toHaveBeenCalledTimes(1);
      expect(urlsOf(http).join(" ")).not.toContain("evil.example.test");
    },
  );

  it("stops at ten pages and says the list was cut short", async () => {
    let n = 0;
    const http = vi.fn(async () => {
      n++;
      return json([{ ...dependabotRaw, number: n }], 200, {
        link: `<${listUrl("dependabot/alerts", `&page=${n + 1}`)}>; rel="next"`,
      });
    });

    const read = (await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")) as {
      alerts: unknown[];
      truncated: boolean;
    };

    expect(http).toHaveBeenCalledTimes(10);
    expect(read.alerts).toHaveLength(10);
    expect(read.truncated).toBe(true);
  });

  it("does not call a list truncated when its tenth page is the last", async () => {
    let n = 0;
    const http = vi.fn(async () => {
      n++;
      const link: Record<string, string> =
        n < 10 ? { link: `<${listUrl("dependabot/alerts", `&page=${n + 1}`)}>; rel="next"` } : {};
      return json([{ ...dependabotRaw, number: n }], 200, link);
    });

    const read = (await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")) as { truncated: boolean };

    expect(http).toHaveBeenCalledTimes(10);
    expect(read.truncated).toBe(false);
  });

  it.each([
    ["dependencyAlerts", "dependabot/alerts", dependabotRaw, "dependabot"],
    ["codeAlerts", "code-scanning/alerts", codeRaw, "code_scanning"],
    ["secretAlerts", "secret-scanning/alerts", secretRaw, "secret_scanning"],
  ] as const)(
    "skips and counts a %s alert with no number, no creation time or a state it does not know, and names the numbered ones",
    async (read, path, raw, source) => {
      const url = path.startsWith("secret") ? `${listUrl(path)}&hide_secret=true` : listUrl(path);
      const http = host({
        [url]: () =>
          json([
            raw,
            { ...raw, number: undefined },
            { ...raw, created_at: undefined },
            { ...raw, number: 90, state: "mystery" },
            // A closed alert with no time to close it at cannot be told from a stale one, so it is left for the next read.
            {
              ...raw,
              number: 91,
              state: path.startsWith("secret") ? "resolved" : "dismissed",
              updated_at: undefined,
              dismissed_at: undefined,
              resolved_at: undefined,
              fixed_at: undefined,
            },
            "junk",
            null,
          ]),
      });

      const result = (await new GitHubSecurityAlertSource(http)[read]("t", "acme", "widgets")) as {
        alerts: { source: string }[];
        skipped: number;
        status: string;
        skippedKeys: string[];
      };

      expect(result.status).toBe("ok");
      expect(result.alerts.map((alert) => alert.source)).toEqual([source]);
      expect(result.skipped).toBe(6);
      // Only those that had a number can be named; the unnumbered one, the text and the null cannot.
      expect(result.skippedKeys).toEqual([String(raw.number), "90", "91"]);
    },
  );

  it("uses the page it knows for an alert whose address GitHub gave on another site", async () => {
    const http = host({
      [listUrl("dependabot/alerts")]: () =>
        json([
          { ...dependabotRaw, html_url: "https://elsewhere.example.test/x" },
          { ...dependabotRaw, number: 8, html_url: undefined },
        ]),
    });

    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));

    expect(read.alerts.map((a) => a.url)).toEqual([
      "https://github.com/acme/widgets/security/dependabot/7",
      "https://github.com/acme/widgets/security/dependabot/8",
    ]);
  });

  it("raises when GitHub sends something that is not a list", async () => {
    const http = host({ [listUrl("code-scanning/alerts")]: () => json({ alerts: [] }) });
    await expect(new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets")).rejects.toThrow(
      "no list of code scanning alerts",
    );
  });
});

describe("GitHubSecurityAlertSource classification", () => {
  type Read = "dependencyAlerts" | "codeAlerts" | "secretAlerts";
  const paths: Record<Read, string> = {
    dependencyAlerts: listUrl("dependabot/alerts"),
    codeAlerts: listUrl("code-scanning/alerts"),
    secretAlerts: listUrl("secret-scanning/alerts", "&hide_secret=true"),
  };

  it.each<[Read, number, string, unknown]>([
    ["dependencyAlerts", 403, "Dependabot alerts are disabled for this repository.", { status: "off", reason: "disabled" }],
    ["dependencyAlerts", 403, "Resource not accessible by personal access token", { status: "no_access", reason: "forbidden" }],
    ["dependencyAlerts", 404, "Not Found", { status: "no_access", reason: "forbidden" }],
    [
      "codeAlerts",
      403,
      "Advanced Security must be enabled for this repository to use code scanning.",
      { status: "off", reason: "needs_advanced_security" },
    ],
    [
      "codeAlerts",
      403,
      "Code scanning is not enabled for this repository. Please enable code scanning in the repository settings.",
      { status: "off", reason: "needs_advanced_security" },
    ],
    ["codeAlerts", 404, "no analysis found", { status: "off", reason: "not_set_up" }],
    ["codeAlerts", 404, "No analysis found for the repository", { status: "off", reason: "not_set_up" }],
    ["codeAlerts", 404, "Not Found", { status: "no_access", reason: "forbidden" }],
    ["codeAlerts", 404, "", { status: "no_access", reason: "forbidden" }],
    ["codeAlerts", 403, "Resource not accessible by personal access token", { status: "no_access", reason: "forbidden" }],
    [
      "secretAlerts",
      404,
      "Secret scanning is disabled on this repository.",
      { status: "no_access", reason: "admin_only_or_off" },
    ],
    [
      "secretAlerts",
      403,
      "Resource not accessible by personal access token",
      { status: "no_access", reason: "admin_only_or_off" },
    ],
  ])("%s answering %i %j is %j", async (read, status, message, expected) => {
    const http = host({ [paths[read]]: () => refusal(status, message) });
    expect(await new GitHubSecurityAlertSource(http)[read]("t", "acme", "widgets")).toEqual(expected);
  });

  it.each<[Read]>([["dependencyAlerts"], ["codeAlerts"], ["secretAlerts"]])(
    "%s raises, with GitHub's message, for a single sign-on 403 rather than calling the feature off",
    async (read) => {
      const http = host({
        [paths[read]]: () =>
          refusal(403, "Resource protected by organization SAML enforcement. You must grant your credential access."),
      });
      const error = await new GitHubSecurityAlertSource(http)[read]("t", "acme", "widgets").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toContain("SAML enforcement");
      expect((error as UpstreamError).status).toBe(403);
    },
  );

  it.each<[Read]>([["dependencyAlerts"], ["codeAlerts"], ["secretAlerts"]])(
    "%s raises the rate limit error for a rate-limited 403, even when its message says disabled",
    async (read) => {
      const http = host({
        [paths[read]]: () =>
          refusal(403, "Dependabot alerts are disabled; slow down", {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1790000000",
          }),
      });
      const error = await new GitHubSecurityAlertSource(http)[read]("t", "acme", "widgets").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toContain(RATE_LIMIT_MESSAGE);
    },
  );

  it("raises the rate limit error for a secondary limit that arrives with retry-after", async () => {
    const http = host({ [paths.codeAlerts]: () => refusal(403, "secondary rate limit", { "retry-after": "60" }) });
    await expect(new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets")).rejects.toThrow(RATE_LIMIT_MESSAGE);
  });

  it("raises UnauthorisedError for a rejected credential, and UpstreamError for a server fault", async () => {
    const rejected = host({ [paths.dependencyAlerts]: () => refusal(401, "Bad credentials") });
    await expect(new GitHubSecurityAlertSource(rejected).dependencyAlerts("t", "acme", "widgets")).rejects.toBeInstanceOf(
      UnauthorisedError,
    );
    const broken = host({ [paths.dependencyAlerts]: () => new Response("oops", { status: 500 }) });
    await expect(new GitHubSecurityAlertSource(broken).dependencyAlerts("t", "acme", "widgets")).rejects.toMatchObject({
      status: 500,
    });
  });

  it("raises, rather than going quiet, when a later page is refused", async () => {
    const page2 = listUrl("dependabot/alerts", "&page=2");
    const http = host({
      [paths.dependencyAlerts]: () => json([dependabotRaw], 200, { link: `<${page2}>; rel="next"` }),
      [page2]: () => refusal(404, "Not Found"),
    });
    await expect(new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("gives a refusal with no readable message a plain error", async () => {
    const http = host({ [paths.codeAlerts]: () => new Response("<html>nope</html>", { status: 403 }) });
    const error = await new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets").catch((e: unknown) => e);
    expect((error as UpstreamError).message).toBe("GitHub refused to list code scanning alerts");
  });
});

describe("GitHubSecurityAlertSource addresses", () => {
  it("builds the settings page from the web address and escapes the names", () => {
    const source = new GitHubSecurityAlertSource(host({}), API, "https://github.example.test");
    expect(source.settingsUrl("acme", "wid gets")).toBe("https://github.example.test/acme/wid%20gets/settings/security_analysis");
  });

  describe("fileUrl", () => {
    it.each([["a/./b.yml"], ["../outside.yml"], ["a/../b.yml"], ["."], ["a/.."]])(
      "answers null for the path %s, as a dot segment would leave the commit's tree",
      (path) => {
        expect(new GitHubSecurityAlertSource().fileUrl("acme", "widgets", "abc1234", path, 1)).toBeNull();
      },
    );

    it("still links a name that only starts or ends with dots", () => {
      expect(new GitHubSecurityAlertSource().fileUrl("acme", "widgets", "abc1234", ".github/..a/b..", null)).toContain(
        "/blob/abc1234/.github/..a/b..",
      );
    });

    const source = new GitHubSecurityAlertSource(host({}), API, "https://github.example.test");
    const sha = "0123456789abcdef0123456789abcdef01234567";

    it("builds the page for a file at a commit, with a line fragment only when there is a line", () => {
      expect(source.fileUrl("acme", "widgets", sha, ".github/workflows/ci.yml", 12)).toBe(
        `https://github.example.test/acme/widgets/blob/${sha}/.github/workflows/ci.yml#L12`,
      );
      expect(source.fileUrl("acme", "widgets", sha, "Dockerfile", null)).toBe(
        `https://github.example.test/acme/widgets/blob/${sha}/Dockerfile`,
      );
    });

    it("escapes the owner, the name and each path segment but keeps the slashes", () => {
      expect(source.fileUrl("ac me", "wid#gets", sha, "my dir/a?b/c d.yml", 3)).toBe(
        `https://github.example.test/ac%20me/wid%23gets/blob/${sha}/my%20dir/a%3Fb/c%20d.yml#L3`,
      );
    });

    it("accepts a short or an upper case hex commit and a 64 character one", () => {
      expect(source.fileUrl("acme", "widgets", "ABCDEF1", "a", null)).toContain("/blob/ABCDEF1/a");
      expect(source.fileUrl("acme", "widgets", "a".repeat(64), "a", null)).toContain(`/blob/${"a".repeat(64)}/a`);
    });

    it.each(["", "abc12", "g".repeat(40), `${sha}/../x`, "a".repeat(65), "main"])("returns null for the commit %j", (bad) => {
      expect(source.fileUrl("acme", "widgets", bad, "a", null)).toBeNull();
    });

    it("returns null for an empty path", () => {
      expect(source.fileUrl("acme", "widgets", sha, "", 1)).toBeNull();
    });

    it("makes no request", () => {
      const http = vi.fn(host({}));
      new GitHubSecurityAlertSource(http).fileUrl("acme", "widgets", sha, "a", 1);
      expect(http).not.toHaveBeenCalled();
    });
  });

  it("reads from a base address it is given, as an enterprise host would be", async () => {
    const base = "https://ghe.example.test/api/v3";
    const http = host({
      [`${base}/repos/acme/widgets/dependabot/alerts?per_page=100&sort=updated&direction=desc`]: () => json([]),
    });
    const read = await new GitHubSecurityAlertSource(http, base, "https://ghe.example.test").dependencyAlerts(
      "t",
      "acme",
      "widgets",
    );
    expect(read).toEqual({ status: "ok", alerts: [], truncated: false, skipped: 0, skippedKeys: [] });
  });
});

describe("GitHubSecurityAlertSource posture", () => {
  const repoBody = {
    visibility: "private",
    private: true,
    permissions: { admin: true, push: true },
    security_and_analysis: {
      dependabot_security_updates: { status: "disabled" },
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
      secret_scanning_validity_checks: { status: "disabled" },
    },
    owner: { login: "acme-owner-login" },
  };
  const branchBody = {
    name: "main",
    commit: {
      sha: "abc",
      commit: {
        author: { name: "Alice Author", email: "alice.author@example.test", date: "2026-09-01T00:00:00Z" },
        verification: { signature: "-----BEGIN PGP SIGNATURE-----" },
      },
      author: { login: "alice-login" },
    },
    protected: true,
    protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["ci"], checks: [] } },
  };
  const protectionBody = {
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 2,
      dismissal_restrictions: { users: [{ login: "restricted-login" }] },
    },
    required_status_checks: { strict: true, contexts: ["ci"] },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_signatures: { enabled: true },
    required_linear_history: { enabled: false },
    enforce_admins: { enabled: true },
    restrictions: { users: [{ login: "restricted-login" }] },
  };
  const rulesBody = [
    {
      type: "pull_request",
      parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: false, require_code_owner_review: true },
    },
    { type: "non_fast_forward" },
    { type: "required_linear_history" },
    { type: "creation" },
  ];
  const advisoriesBody = [
    { state: "draft" },
    { state: "triage" },
    { state: "triage" },
    { state: "published" },
    { state: "closed" },
    { state: "closed" },
    { state: "weird" },
    "junk",
  ];

  const full = () =>
    host({
      [REPO]: () => json({ ...repoBody, visibility: "public", private: false }),
      [`${REPO}/branches/main`]: () => json(branchBody),
      [`${REPO}/branches/main/protection`]: () => json(protectionBody),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json(rulesBody),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
      [`${REPO}/security-advisories?per_page=100`]: () => json(advisoriesBody),
    });

  it("merges classic protection and rulesets, so a rule counts when either enforces it", async () => {
    const http = full();

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    expect(posture).toEqual({
      visibility: "public",
      isAdmin: true,
      branch: {
        name: "main",
        protected: true,
        detail: "full",
        rules: {
          requirePullRequest: true,
          // The larger of classic's 2 and the ruleset's 1.
          requiredApprovals: 2,
          dismissStaleReviews: true,
          // Only the ruleset asks for it.
          requireCodeOwnerReview: true,
          requireStatusChecks: true,
          blockForcePushes: true,
          blockDeletion: true,
          requireSignedCommits: true,
          // Only the ruleset asks for it.
          requireLinearHistory: true,
        },
      },
      settings: {
        dependabotSecurityUpdates: false,
        secretScanning: true,
        pushProtection: true,
        validityChecks: false,
        privateVulnerabilityReporting: true,
      },
      advisories: { draft: 1, triage: 2, published: 1, closed: 2 },
    });
    // The settings were in the repository read, so the automated-security-fixes endpoint was not needed.
    expect(urlsOf(http).some((url) => url.includes("automated-security-fixes"))).toBe(false);
  });

  it("never carries the branch's commit author, email or signature, or any login", async () => {
    const posture = JSON.stringify(await new GitHubSecurityAlertSource(full()).posture("t", "acme", "widgets", "main"));
    for (const forbidden of [
      "Alice Author",
      "alice.author@example.test",
      "PGP SIGNATURE",
      "alice-login",
      "restricted-login",
      "acme-owner-login",
      "sha",
    ]) {
      expect(posture).not.toContain(forbidden);
    }
    expect(posture).not.toMatch(/login|email|author/i);
  });

  it("calls an unprotected branch with no rulesets unprotected in every rule, and does not ask for its protection", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "public", permissions: { admin: false } }),
      [`${REPO}/branches/main`]: () =>
        json({
          name: "main",
          protected: false,
          protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } },
        }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false, paused: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([]),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    expect(posture.branch).toEqual({
      name: "main",
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
    });
    expect(posture).toMatchObject({
      visibility: "public",
      isAdmin: false,
      settings: {
        dependabotSecurityUpdates: false,
        secretScanning: null,
        pushProtection: null,
        validityChecks: null,
        privateVulnerabilityReporting: false,
      },
      // This credential is not an administrator, so the advisories are not counted (see the test of that below).
      advisories: null,
    });
    expect(urlsOf(http).some((url) => url.endsWith("/protection"))).toBe(false);
  });

  it("leaves rules unknown for an unprotected branch whose rulesets could not be read, as detail none", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private" }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => refusal(404, "Not Found"),
    });
    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
    expect(branch).toMatchObject({
      protected: false,
      detail: "none",
      rules: { requirePullRequest: null, blockForcePushes: null },
    });
  });

  it("treats a 404 saying the branch is not protected as no classic protection, so every rule is known", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: true }),
      [`${REPO}/branches/main/protection`]: () => refusal(404, "Branch not protected"),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([{ type: "deletion" }]),
    });
    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
    expect(branch.detail).toBe("full");
    expect(branch.rules).toMatchObject({ blockDeletion: true, requirePullRequest: false, blockForcePushes: false });
  });

  it("does not read a 404 with any other message from the protection address as no protection", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private" }),
      [`${REPO}/branches/main`]: () => json({ protected: true }),
      [`${REPO}/branches/main/protection`]: () => refusal(404, "Not Found"),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
    });
    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
    expect(branch.detail).toBe("rulesets_only");
    expect(branch.rules.requirePullRequest).toBeNull();
  });

  it("asks nothing about private vulnerability reporting or advisories for a private or internal repository", async () => {
    for (const visibility of ["private", "internal"]) {
      const http = host({
        [REPO]: () => json({ visibility }),
        [`${REPO}/branches/main`]: () => json({ protected: false }),
        [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
        [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
        [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
        [`${REPO}/security-advisories?per_page=100`]: () => json([{ state: "draft" }]),
      });
      const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
      expect(urlsOf(http).some((url) => /private-vulnerability-reporting|security-advisories/.test(url))).toBe(false);
      expect(posture.settings.privateVulnerabilityReporting).toBeNull();
      expect(posture.advisories).toBeNull();
    }
  });

  it("still reads both for a public repository", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "public", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([{ state: "draft" }]),
    });
    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
    expect(posture.settings.privateVulnerabilityReporting).toBe(true);
    expect(posture.advisories).toEqual({ draft: 1, triage: 0, published: 0, closed: 0 });
  });

  it.each([
    ["says it is not one", { admin: false, push: true }],
    ["sends no permissions", undefined],
  ])(
    "does not count the advisories of a public repository when the read %s, since GitHub then leaves out drafts",
    async (_case, permissions) => {
      // GitHub answers 200 to a credential that is no administrator, with only the published and closed advisories listed,
      // so a count of them would say that nothing waits in draft or triage.
      const http = host({
        [REPO]: () => json({ visibility: "public", ...(permissions ? { permissions } : {}) }),
        [`${REPO}/branches/main`]: () => json({ protected: false }),
        [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
        [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
        [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
        [`${REPO}/security-advisories?per_page=100`]: () => json([{ state: "published" }, { state: "closed" }]),
      });

      const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

      expect(posture.advisories).toBeNull();
      expect(posture.settings.privateVulnerabilityReporting).toBe(true);
    },
  );

  it("leaves the rules and the advisories unknown when GitHub answers with an object where a list belongs", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "public", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json({ message: "not a list" }),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [`${REPO}/security-advisories?per_page=100`]: () => json({ message: "not a list" }),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    // Reading the first as an empty list would call an unprotected branch one with no rules of any kind.
    expect(posture.branch.detail).toBe("none");
    expect(posture.branch.protected).toBe(false);
    expect(posture.branch.rules.blockForcePushes).toBeNull();
    expect(posture.advisories).toBeNull();
    expect(urlsOf(http)).toContain(`${REPO}/security-advisories?per_page=100`);
  });

  it("leaves the rules only classic protection could show unknown when its reply is a list and not an object", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: true }),
      [`${REPO}/branches/main/protection`]: () => json([{ allow_force_pushes: { enabled: false } }]),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([{ type: "deletion" }]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
    });

    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    // Reading it as "no classic protection" would make every other rule known to be absent.
    expect(branch.detail).toBe("rulesets_only");
    expect(branch.rules).toMatchObject({ blockDeletion: true, blockForcePushes: null, requirePullRequest: null });
  });

  it("leaves rules it could not see as null, and says only rulesets were read, when a non-administrator meets classic protection", async () => {
    const http = host({
      [REPO]: () => json({ private: false, permissions: {} }),
      [`${REPO}/branches/main`]: () =>
        json({
          ...branchBody,
          protection: {
            enabled: true,
            required_status_checks: { enforcement_level: "everyone", contexts: [], checks: [{ context: "ci" }] },
          },
        }),
      [`${REPO}/branches/main/protection`]: () => refusal(403, "Resource not accessible by personal access token"),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([{ type: "deletion" }]),
      [`${REPO}/automated-security-fixes`]: () => refusal(403, "Resource not accessible by personal access token"),
      [`${REPO}/private-vulnerability-reporting`]: () => refusal(404, "Not Found"),
      [`${REPO}/security-advisories?per_page=100`]: () => refusal(403, "Must have admin rights to Repository."),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    expect(posture.visibility).toBe("public");
    expect(posture.isAdmin).toBeNull();
    expect(posture.branch).toMatchObject({
      protected: true,
      detail: "rulesets_only",
      rules: {
        // The ruleset says so.
        blockDeletion: true,
        // Classic protection might enforce these, and could not be read.
        blockForcePushes: null,
        requirePullRequest: null,
        requiredApprovals: null,
        requireSignedCommits: null,
        // The branch read itself shows a required check.
        requireStatusChecks: true,
      },
    });
    expect(posture.settings).toEqual({
      dependabotSecurityUpdates: null,
      secretScanning: null,
      pushProtection: null,
      validityChecks: null,
      privateVulnerabilityReporting: null,
    });
    expect(posture.advisories).toBeNull();
  });

  it("answers detail none, with every part null, when this credential may see none of it", async () => {
    const hidden = () => refusal(403, "Resource not accessible by personal access token");
    const http = host({
      [REPO]: hidden,
      [`${REPO}/branches/main`]: hidden,
      [`${REPO}/rules/branches/main?per_page=100`]: () => refusal(404, "Not Found"),
      [`${REPO}/automated-security-fixes`]: () => refusal(404, "Not Found"),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    // With no visibility the repository is not known to be public, so neither of the public-only parts is asked for.
    expect(urlsOf(http).some((url) => /private-vulnerability-reporting|security-advisories/.test(url))).toBe(false);
    expect(posture.visibility).toBeNull();
    expect(posture.isAdmin).toBeNull();
    expect(posture.branch.protected).toBeNull();
    expect(posture.branch.detail).toBe("none");
    expect(Object.values(posture.branch.rules).every((value) => value === null)).toBe(true);
    expect(posture.advisories).toBeNull();
  });

  it("derives visibility from the private flag when no visibility is sent, and escapes a branch with a slash", async () => {
    const http = host({
      [REPO]: () => json({ private: true }),
      [`${REPO}/branches/release/2026`]: () => json({ protected: false }),
      [`${REPO}/rules/branches/release/2026?per_page=100`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: true }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([]),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "release/2026");

    expect(posture.visibility).toBe("private");
    expect(posture.settings.dependabotSecurityUpdates).toBe(true);
  });

  it("encodes characters in a branch name that would change the address", async () => {
    const http = host({
      [REPO]: () => json({}),
      [`${REPO}/branches/a%3Fb%23c`]: () => json({ protected: false }),
      [`${REPO}/rules/branches/a%3Fb%23c?per_page=100`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([]),
    });
    await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "a?b#c");
    expect(urlsOf(http)).toContain(`${REPO}/branches/a%3Fb%23c`);
  });

  it("raises for a rejected credential and for a rate limit, and does not swallow either as a null", async () => {
    const rejected = host({ [REPO]: () => refusal(401, "Bad credentials") });
    await expect(new GitHubSecurityAlertSource(rejected).posture("t", "acme", "widgets", "main")).rejects.toBeInstanceOf(
      UnauthorisedError,
    );

    const limited = host({
      [REPO]: () => json({}),
      [`${REPO}/branches/main`]: () => refusal(403, "limit", { "x-ratelimit-remaining": "0" }),
    });
    await expect(new GitHubSecurityAlertSource(limited).posture("t", "acme", "widgets", "main")).rejects.toThrow(
      RATE_LIMIT_MESSAGE,
    );
  });

  it("does not treat classic protection with no reviews as a pull request requirement, and takes a ruleset's approvals when classic is silent", async () => {
    const http = host({
      [REPO]: () => json({ permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: true }),
      [`${REPO}/branches/main/protection`]: () => json({ allow_force_pushes: { enabled: true } }),
      [`${REPO}/rules/branches/main?per_page=100`]: () =>
        json([
          { type: "pull_request", parameters: { required_approving_review_count: 3 } },
          { type: "required_signatures" },
          { type: "required_status_checks" },
        ]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([]),
    });

    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    expect(branch.rules).toMatchObject({
      requirePullRequest: true,
      requiredApprovals: 3,
      // Classic allows force pushes and no ruleset blocks them.
      blockForcePushes: false,
      requireSignedCommits: true,
      requireStatusChecks: true,
    });
  });
});

describe("GitHubSecurityAlertSource refusals that are not a permission", () => {
  const SSO = "Resource protected by organization SAML enforcement. You must grant your credential access.";
  const SECONDARY = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
  const PROTECTION = `${REPO}/branches/main/protection`;

  /** A public repository with a protected branch, every part answering, and `overrides` changing some of the answers. */
  const postureHost = (overrides: Record<string, () => Response> = {}) =>
    host({
      [REPO]: () => json({ visibility: "public", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: true }),
      [PROTECTION]: () => json({ allow_force_pushes: { enabled: false } }),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: true }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([]),
      ...overrides,
    });
  const posture = (http: ReturnType<typeof host>) => new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

  type Posture = Awaited<ReturnType<typeof posture>>;
  /** Each part of the posture, the address that feeds it, and the field that must read as unknown when it is not seen. */
  const PARTS: [string, string, (read: Posture) => unknown][] = [
    ["the repository", REPO, (read) => read.visibility],
    ["the branch", `${REPO}/branches/main`, (read) => read.branch.protected],
    // The rulesets are an empty list here, so only classic protection could say a rule is enforced or is not.
    ["classic protection", PROTECTION, (read) => read.branch.rules.blockForcePushes],
    ["the branch's rules", `${REPO}/rules/branches/main?per_page=100`, (read) => read.branch.rules.requireLinearHistory],
    ["automated security fixes", `${REPO}/automated-security-fixes`, (read) => read.settings.dependabotSecurityUpdates],
    [
      "private vulnerability reporting",
      `${REPO}/private-vulnerability-reporting`,
      (read) => read.settings.privateVulnerabilityReporting,
    ],
    ["the advisories", `${REPO}/security-advisories?per_page=100`, (read) => read.advisories],
  ];

  it.each(PARTS)("raises, rather than saving nulls, for a single sign-on 403 on %s", async (_part, url) => {
    const error = await posture(postureHost({ [url]: () => refusal(403, SSO) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toContain("SAML enforcement");
    expect((error as UpstreamError).status).toBe(403);
  });

  it.each(PARTS)("raises the rate limit error for a secondary limit with no header on %s", async (_part, url) => {
    await expect(posture(postureHost({ [url]: () => refusal(403, SECONDARY) }))).rejects.toThrow(RATE_LIMIT_MESSAGE);
  });

  it.each(PARTS)("leaves %s unknown, and raises nothing, when GitHub says admin rights are needed", async (_part, url, field) => {
    const read = await posture(postureHost({ [url]: () => refusal(403, "Must have admin rights to Repository.") }));
    expect(read.branch.name).toBe("main");
    // Null, and not false or an empty list, because the part was not seen and may well be on.
    expect(field(read)).toBeNull();
  });

  it("raises for a branch GitHub cannot find, naming the branch, so the earlier posture is kept", async () => {
    const error = await posture(postureHost({ [`${REPO}/branches/main`]: () => refusal(404, "Branch not found") })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: "NotFoundError" });
    expect((error as Error).message).toContain('"main"');
  });

  it("raises for a repository GitHub cannot find", async () => {
    await expect(posture(postureHost({ [REPO]: () => refusal(404, "Not Found") }))).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it.each(PARTS.filter(([part]) => part !== "the repository" && part !== "the branch"))(
    "leaves %s unknown for a 404, which GitHub sends when only an administrator can read it",
    async (_part, url, field) => {
      const read = await posture(postureHost({ [url]: () => refusal(404, "Not Found") }));
      expect(read.visibility).toBe("public");
      expect(field(read)).toBeNull();
    },
  );

  it("names what was refused in the error, with GitHub's message", async () => {
    const error = await posture(postureHost({ [PROTECTION]: () => refusal(403, SSO) })).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^GitHub refused to read the branch's protection: Resource protected/);
  });
});

describe("GitHubSecurityAlertSource free text from upstream", () => {
  const PERSON = "Contact alice@example.test, who wrote ghp_secret into this";

  it("keeps no free text in the error for an alert list it was refused, nor for a later page", async () => {
    const first = host({ [listUrl("code-scanning/alerts")]: () => refusal(403, PERSON) });
    const error = await new GitHubSecurityAlertSource(first).codeAlerts("t", "acme", "widgets").catch((e: unknown) => e);
    expect((error as Error).message).toBe("GitHub refused to list code scanning alerts");

    const page2 = listUrl("code-scanning/alerts", "&page=2");
    const later = host({
      [listUrl("code-scanning/alerts")]: () => json([codeRaw], 200, { link: `<${page2}>; rel="next"` }),
      [page2]: () => refusal(403, PERSON),
    });
    const second = await new GitHubSecurityAlertSource(later).codeAlerts("t", "acme", "widgets").catch((e: unknown) => e);
    expect((second as Error).message).toBe("GitHub refused to list code scanning alerts");
  });

  it("keeps a message of a known kind, and none of any other, for a refused part of the posture", async () => {
    const REPO_ = `${API}/repos/acme/widgets`;
    const read = (message: string) =>
      new GitHubSecurityAlertSource(host({ [REPO_]: () => refusal(403, message) })).posture("t", "acme", "widgets", "main");

    await expect(read("Resource protected by organization SAML enforcement")).rejects.toThrow(
      "GitHub refused to read the repository: Resource protected by organization SAML enforcement",
    );
    await expect(read(PERSON)).rejects.toThrow(/^GitHub refused to read the repository$/);
  });
});

describe("GitHubSecurityAlertSource classification messages", () => {
  const list = (path: string) => listUrl(path);

  it("raises, rather than calling Dependabot off, for a 403 that merely contains the word disabled", async () => {
    const http = host({ [list("dependabot/alerts")]: () => refusal(403, "Your account is disabled for this organisation") });
    await expect(new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    "Two-factor authentication is not enabled for this account",
    "Advanced Security billing is overdue for this organisation",
  ])("raises, rather than calling code scanning off, for the 403 %j", async (message) => {
    const http = host({ [list("code-scanning/alerts")]: () => refusal(403, message) });
    await expect(new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets")).rejects.toMatchObject({ status: 403 });
  });

  it("reads a 403 that says admin rights are needed as no access for each source", async () => {
    const message = "Must have admin rights to Repository.";
    const http = host({
      [list("dependabot/alerts")]: () => refusal(403, message),
      [list("code-scanning/alerts")]: () => refusal(403, message),
      [list("secret-scanning/alerts") + "&hide_secret=true"]: () => refusal(403, message),
    });
    const source = new GitHubSecurityAlertSource(http);
    expect(await source.dependencyAlerts("t", "acme", "widgets")).toEqual({ status: "no_access", reason: "forbidden" });
    expect(await source.codeAlerts("t", "acme", "widgets")).toEqual({ status: "no_access", reason: "forbidden" });
    expect(await source.secretAlerts("t", "acme", "widgets")).toEqual({ status: "no_access", reason: "admin_only_or_off" });
  });

  it("raises the rate limit error for a secondary limit that sent no header, whatever the source", async () => {
    const http = host({
      [list("dependabot/alerts")]: () => refusal(403, "You have exceeded a secondary rate limit."),
    });
    await expect(new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")).rejects.toThrow(
      RATE_LIMIT_MESSAGE,
    );
  });
});

describe("GitHubSecurityAlertSource lists that go on", () => {
  const RULES = `${REPO}/rules/branches/main?per_page=100`;
  const ADVISORIES = `${REPO}/security-advisories?per_page=100`;
  const page = (url: string, n: number) => `${url}&page=${n}`;
  const next = (url: string) => ({ link: `<${url}>; rel="next"` });
  const filler = (count: number) => Array.from({ length: count }, () => ({ type: "creation" }));

  /** An unprotected public branch, so classic protection is fully known and only the rulesets decide. */
  const base = (extra: Record<string, () => Response>) =>
    host({
      [REPO]: () => json({ visibility: "public", permissions: { admin: true } }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: false }),
      [RULES]: () => json([]),
      [ADVISORIES]: () => json([]),
      ...extra,
    });
  const posture = (http: ReturnType<typeof host>) => new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

  it("reports detail none for a branch known to be unprotected when its rulesets were cut and nothing seen is enforced", async () => {
    const refused = base({ [RULES]: () => json([{ type: "creation" }], 200, next("https://evil.example.test/rules?page=2")) });
    const { branch } = await posture(refused);
    // A ruleset past the cut might protect the branch, so it is not known to be unprotected.
    expect(branch.detail).toBe("none");
    expect(branch.protected).toBe(false);

    const capped = base({
      [RULES]: () => json(filler(100), 200, next(page(RULES, 2))),
      ...Object.fromEntries([2, 3, 4, 5].map((at) => [page(RULES, at), () => json(filler(100), 200, next(page(RULES, at + 1)))])),
    });
    expect((await posture(capped)).branch.detail).toBe("none");
  });

  it("keeps detail rulesets_only when a cut ruleset list still shows a rule enforced, and full when it was read in full", async () => {
    const seen = base({ [RULES]: () => json([{ type: "deletion" }], 200, next("https://evil.example.test/rules?page=2")) });
    expect((await posture(seen)).branch.detail).toBe("rulesets_only");

    expect((await posture(base({}))).branch.detail).toBe("full");
  });

  it("asks for 100 rules to a page and follows the next link, so a rule on page two is seen", async () => {
    const http = base({
      [RULES]: () => json(filler(100), 200, next(page(RULES, 2))),
      [page(RULES, 2)]: () => json([{ type: "non_fast_forward" }]),
    });

    const { branch } = await posture(http);

    // Page one alone would have said force pushes are allowed.
    expect(branch.rules.blockForcePushes).toBe(true);
    expect(branch.rules.blockDeletion).toBe(false);
    expect(urlsOf(http).filter((url) => url.includes("/rules/branches/main"))).toEqual([RULES, page(RULES, 2)]);
  });

  it("stops after five pages of rules and leaves a rule it did not see unknown, not missing", async () => {
    let n = 0;
    const http = base({
      [RULES]: () => json(filler(100), 200, next(page(RULES, 2))),
      ...Object.fromEntries(
        [2, 3, 4, 5, 6].map((at) => [
          page(RULES, at),
          () => {
            n++;
            return json(at === 3 ? [{ type: "deletion" }] : filler(100), 200, next(page(RULES, at + 1)));
          },
        ]),
      ),
    });

    const { branch } = await posture(http);

    expect(n).toBe(4);
    expect(urlsOf(http).filter((url) => url.includes("/rules/branches/main"))).toHaveLength(5);
    // Seen on page three.
    expect(branch.rules.blockDeletion).toBe(true);
    // Not seen in what was read, but the list went on, so it is not known to be absent.
    expect(branch.rules.blockForcePushes).toBeNull();
    expect(branch.rules.requireSignedCommits).toBeNull();
  });

  it("leaves unseen rules unknown when the next link of the rules was refused", async () => {
    const http = base({
      [RULES]: () => json([{ type: "deletion" }], 200, next("https://evil.example.test/rules?page=2")),
    });
    const { branch } = await posture(http);
    expect(branch.rules).toMatchObject({ blockDeletion: true, blockForcePushes: null, requirePullRequest: null });
    expect(urlsOf(http).join(" ")).not.toContain("evil");
  });

  it("raises when a later page of rules is refused, rather than saving half a list", async () => {
    const http = base({
      [RULES]: () => json(filler(100), 200, next(page(RULES, 2))),
      [page(RULES, 2)]: () => refusal(403, "Resource protected by organization SAML enforcement."),
    });
    await expect(posture(http)).rejects.toMatchObject({ status: 403 });
  });

  it("raises when a later page of rules is not a list", async () => {
    const http = base({
      [RULES]: () => json(filler(100), 200, next(page(RULES, 2))),
      [page(RULES, 2)]: () => json({ message: "oops" }),
    });
    await expect(posture(http)).rejects.toThrow("no list of the branch's rules");
  });

  it("follows the next link of the advisories and counts those on every page", async () => {
    const http = base({
      [ADVISORIES]: () => json([{ state: "draft" }, { state: "closed" }], 200, next(page(ADVISORIES, 2))),
      [page(ADVISORIES, 2)]: () => json([{ state: "draft" }, { state: "published" }]),
    });
    expect((await posture(http)).advisories).toEqual({ draft: 2, triage: 0, published: 1, closed: 1 });
  });

  it("reports the advisories as not read when the list went on past what was read", async () => {
    const refused = base({
      [ADVISORIES]: () => json([{ state: "draft" }], 200, next("http://api.github.com/x?page=2")),
    });
    expect((await posture(refused)).advisories).toBeNull();

    const forever = base({
      [ADVISORIES]: () => json([{ state: "draft" }], 200, next(page(ADVISORIES, 2))),
      ...Object.fromEntries(
        [2, 3, 4, 5].map((at) => [page(ADVISORIES, at), () => json([{ state: "draft" }], 200, next(page(ADVISORIES, at + 1)))]),
      ),
    });
    const http = forever;
    expect((await posture(http)).advisories).toBeNull();
    expect(urlsOf(http).filter((url) => url.includes("security-advisories"))).toHaveLength(5);
  });

  it("marks an alert list truncated when a next link is too long to read, so nothing unread is pruned", async () => {
    const http = host({
      [listUrl("code-scanning/alerts")]: () =>
        json([codeRaw], 200, {
          link: `<${listUrl("code-scanning/alerts", "&page=2")}>; rel="next"; title="${"x".repeat(5000)}"`,
        }),
    });
    const read = ok(await new GitHubSecurityAlertSource(http).codeAlerts("t", "acme", "widgets"));
    expect(read.alerts).toHaveLength(1);
    expect(read.truncated).toBe(true);
  });
});

describe("GitHubSecurityAlertSource mapping details", () => {
  const one = async (path: string, call: "dependencyAlerts" | "codeAlerts" | "secretAlerts", raw: unknown, extra = "") => {
    const http = host({ [listUrl(path, extra)]: () => json([raw]) });
    return ok(await new GitHubSecurityAlertSource(http)[call]("t", "acme", "widgets")).alerts[0] as unknown as {
      closedAt: string | null;
      closeReason: string | null;
      title: string;
      url: string;
      exposure?: { type: string };
    };
  };

  it.each([
    ["false positive", "false_positive"],
    ["used in tests", "used_in_tests"],
    ["won't fix", "wont_fix"],
  ])("maps the code scanning dismissal %j to %s", async (reason, code) => {
    const alert = await one("code-scanning/alerts", "codeAlerts", { ...codeRaw, dismissed_reason: reason });
    expect(alert.closeReason).toBe(code);
  });

  it("leaves a code scanning dismissal with a reason it does not know without a reason", async () => {
    const alert = await one("code-scanning/alerts", "codeAlerts", { ...codeRaw, dismissed_reason: "free text a person typed" });
    expect(alert.closeReason).toBeNull();
  });

  it("closes a fixed code alert at fixed_at, and at updated_at when it has none", async () => {
    const fixed = { ...codeRaw, state: "fixed", dismissed_reason: null, dismissed_at: null, fixed_at: "2026-09-07T10:00:00Z" };
    const withTime = await one("code-scanning/alerts", "codeAlerts", fixed);
    expect(withTime).toMatchObject({ closedAt: "2026-09-07T10:00:00Z", closeReason: "fixed" });
    const without = await one("code-scanning/alerts", "codeAlerts", { ...fixed, fixed_at: null });
    expect(without.closedAt).toBe("2026-09-05T10:00:00Z");
  });

  it("closes a fixed Dependabot alert at fixed_at, and at updated_at when it has none", async () => {
    const fixed = {
      ...dependabotRaw,
      state: "fixed",
      dismissed_at: null,
      dismissed_reason: null,
      fixed_at: "2026-09-08T10:00:00Z",
    };
    expect((await one("dependabot/alerts", "dependencyAlerts", fixed)).closedAt).toBe("2026-09-08T10:00:00Z");
    expect((await one("dependabot/alerts", "dependencyAlerts", { ...fixed, fixed_at: null })).closedAt).toBe(
      "2026-09-04T10:00:00Z",
    );
  });

  it.each([
    ["dependabot/alerts", "dependencyAlerts", "", () => ({ ...dependabotRaw, state: "fixed", fixed_at: null })],
    ["code-scanning/alerts", "codeAlerts", "", () => ({ ...codeRaw, state: "fixed", fixed_at: null })],
    ["secret-scanning/alerts", "secretAlerts", "&hide_secret=true", () => ({ ...secretRaw, resolved_at: null })],
  ] as const)("skips and counts a closed %s entry with no close or update time", async (path, call, extra, raw) => {
    // With no time the close cannot be placed in a week, so the alert would read as open for ever in the weekly chart.
    const closed = { ...raw(), updated_at: null };
    const http = host({ [listUrl(path, extra)]: () => json([closed]) });
    const read = ok(await new GitHubSecurityAlertSource(http)[call]("t", "acme", "widgets"));
    expect(read.alerts).toEqual([]);
    expect(read.skipped).toBe(1);
  });

  it("closes a resolved secret alert at resolved_at, and at updated_at when it has none", async () => {
    const hidden = "&hide_secret=true";
    expect((await one("secret-scanning/alerts", "secretAlerts", secretRaw, hidden)).closedAt).toBe("2026-09-05T10:00:00Z");
    const without = await one("secret-scanning/alerts", "secretAlerts", { ...secretRaw, resolved_at: null }, hidden);
    expect(without.closedAt).toBe("2026-09-06T10:00:00Z");
  });

  it("cuts a published title to 300 characters, for each source", async () => {
    const long = "a".repeat(400);
    const dependabot = await one("dependabot/alerts", "dependencyAlerts", {
      ...dependabotRaw,
      security_advisory: { ...dependabotRaw.security_advisory, summary: long },
    });
    expect(dependabot.title).toBe("a".repeat(300));
    const code = await one("code-scanning/alerts", "codeAlerts", { ...codeRaw, rule: { ...codeRaw.rule, description: long } });
    expect(code.title).toBe("a".repeat(300));
    const secret = await one(
      "secret-scanning/alerts",
      "secretAlerts",
      { ...secretRaw, secret_type_display_name: long },
      "&hide_secret=true",
    );
    expect(secret.title).toBe("a".repeat(300));
    expect(secret.exposure?.type).toBe("a".repeat(300));
  });
});

describe("GitHubSecurityAlertSource alert pages", () => {
  const known = "https://github.com/acme/widgets/security/dependabot/7";

  it.each([
    "https://github.com.evil.example.test/acme/widgets/security/dependabot/7",
    "https://github.com@evil.example.test/acme/widgets/security/dependabot/7",
    "https://evil.example.test/https://github.com/acme/widgets",
    "http://github.com/acme/widgets/security/dependabot/7",
  ])("uses the page it knows, not %s", async (html) => {
    const http = host({ [listUrl("dependabot/alerts")]: () => json([{ ...dependabotRaw, html_url: html }]) });
    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));
    expect(read.alerts[0]!.url).toBe(known);
  });

  it("keeps an address on the site's own host", async () => {
    const own = "https://github.com/acme/widgets/security/dependabot/7?query=1";
    const http = host({ [listUrl("dependabot/alerts")]: () => json([{ ...dependabotRaw, html_url: own }]) });
    const read = ok(await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets"));
    expect(read.alerts[0]!.url).toBe(own);
  });
});

describe("GitHubSecurityAlertSource status check hint", () => {
  it("leaves required checks unknown when the branch's hint says enforcement is off and nothing else can see them", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private" }),
      [`${REPO}/branches/main`]: () =>
        json({
          protected: true,
          protection: { enabled: true, required_status_checks: { enforcement_level: "off", contexts: ["ci"], checks: [] } },
        }),
      [`${REPO}/branches/main/protection`]: () => refusal(403, "Resource not accessible by personal access token"),
      [`${REPO}/rules/branches/main?per_page=100`]: () => json([{ type: "deletion" }]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
    });

    const { branch } = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

    expect(branch.detail).toBe("rulesets_only");
    expect(branch.rules.requireStatusChecks).toBeNull();
  });
});
