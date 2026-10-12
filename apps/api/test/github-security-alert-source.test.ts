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
      dependency: { ecosystem: "unknown", name: "unknown", manifestPath: "", advisoryId: "" },
    });
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
  ])("does not follow a next link to %s, so the token goes nowhere else", async (_label, target) => {
    const http = host({ [listUrl("dependabot/alerts")]: () => json([dependabotRaw], 200, { link: `<${target}>; rel="next"` }) });

    const read = (await new GitHubSecurityAlertSource(http).dependencyAlerts("secret-token", "acme", "widgets")) as {
      alerts: unknown[];
    };

    expect(read.alerts).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(1);
    expect(urlsOf(http).join(" ")).not.toContain("evil.example.test");
  });

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

  it("skips and counts an alert with no number, no creation time or a state it does not know", async () => {
    const http = host({
      [listUrl("dependabot/alerts")]: () =>
        json([
          dependabotRaw,
          { ...dependabotRaw, number: undefined },
          { ...dependabotRaw, created_at: undefined },
          { ...dependabotRaw, state: "mystery" },
          "junk",
          null,
        ]),
    });

    const read = (await new GitHubSecurityAlertSource(http).dependencyAlerts("t", "acme", "widgets")) as {
      alerts: unknown[];
      skipped: number;
      status: string;
    };

    expect(read.status).toBe("ok");
    expect(read.alerts).toHaveLength(1);
    expect(read.skipped).toBe(5);
  });

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
    expect(read).toEqual({ status: "ok", alerts: [], truncated: false, skipped: 0 });
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
      [`${REPO}/rules/branches/main`]: () => json(rulesBody),
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
      [`${REPO}/rules/branches/main`]: () => json([]),
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
      advisories: { draft: 0, triage: 0, published: 0, closed: 0 },
    });
    expect(urlsOf(http).some((url) => url.endsWith("/protection"))).toBe(false);
  });

  it("leaves rules unknown for an unprotected branch whose rulesets could not be read, as detail none", async () => {
    const http = host({
      [REPO]: () => json({ visibility: "private" }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/rules/branches/main`]: () => refusal(404, "Not Found"),
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
      [`${REPO}/rules/branches/main`]: () => json([{ type: "deletion" }]),
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
      [`${REPO}/rules/branches/main`]: () => json([]),
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
        [`${REPO}/rules/branches/main`]: () => json([]),
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
      [REPO]: () => json({ visibility: "public" }),
      [`${REPO}/branches/main`]: () => json({ protected: false }),
      [`${REPO}/rules/branches/main`]: () => json([]),
      [`${REPO}/automated-security-fixes`]: () => json({ enabled: false }),
      [`${REPO}/private-vulnerability-reporting`]: () => json({ enabled: true }),
      [`${REPO}/security-advisories?per_page=100`]: () => json([{ state: "draft" }]),
    });
    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");
    expect(posture.settings.privateVulnerabilityReporting).toBe(true);
    expect(posture.advisories).toEqual({ draft: 1, triage: 0, published: 0, closed: 0 });
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
      [`${REPO}/rules/branches/main`]: () => json([{ type: "deletion" }]),
      [`${REPO}/automated-security-fixes`]: () => refusal(403, "no"),
      [`${REPO}/private-vulnerability-reporting`]: () => refusal(404, "no"),
      [`${REPO}/security-advisories?per_page=100`]: () => refusal(403, "no"),
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

  it("answers detail none, with every part null, when nothing can be read", async () => {
    const http = host({
      [REPO]: () => refusal(404, "Not Found"),
      [`${REPO}/branches/main`]: () => refusal(404, "Branch not found"),
      [`${REPO}/rules/branches/main`]: () => refusal(404, "Not Found"),
      [`${REPO}/automated-security-fixes`]: () => refusal(404, "Not Found"),
      [`${REPO}/private-vulnerability-reporting`]: () => refusal(404, "Not Found"),
      [`${REPO}/security-advisories?per_page=100`]: () => json({ message: "not a list" }),
    });

    const posture = await new GitHubSecurityAlertSource(http).posture("t", "acme", "widgets", "main");

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
      [`${REPO}/rules/branches/release/2026`]: () => json([]),
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
      [`${REPO}/rules/branches/a%3Fb%23c`]: () => json([]),
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
      [`${REPO}/rules/branches/main`]: () =>
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
