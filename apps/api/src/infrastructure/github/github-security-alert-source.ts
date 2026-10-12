import type {
  AlertOf,
  AlertSource,
  AlertState,
  BranchRules,
  CloseReason,
  CodeAlert,
  DependabotAlert,
  RepoPosture,
  SecretAlert,
  Severity,
} from "@dora-dashboard/core";
import { NotFoundError, UpstreamError } from "../../core/errors.js";
import type { AlertRead, SecurityAlertSource } from "../../interfaces/security-alert-source.js";
import type { Fetch } from "../http/fetch.js";
import { API, knownMessage, type PageResult, requestPage } from "./github-http.js";

/** Pages read per source. GitHub lists the most recently updated alerts first, so what is left out is the oldest. */
const MAX_PAGES = 10;
/** Pages read of a branch's rules or of the repository's advisories, 100 to a page. Far more than any repository has. */
const MAX_LIST_PAGES = 5;
/** What a 403 says when the credential may not see a part, as against a refusal that is something else. */
const NOT_PERMITTED = /resource not accessible by|must have admin rights/i;
const MAX_TITLE = 300;

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A fraction GitHub may send as a number or as text such as "0.16001e0"; anything that is not finite is dropped. */
const fraction = (value: unknown): number | null => {
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const field = (parent: Json | null, key: string): unknown => (parent && Object.hasOwn(parent, key) ? parent[key] : undefined);
const title = (value: string): string => value.slice(0, MAX_TITLE);

/** A value that is one of a fixed set of GitHub codes, or null. Never a free-text value. */
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const SEVERITIES = new Map<string, Severity>([
  ["critical", "critical"],
  ["high", "high"],
  ["moderate", "medium"],
  ["medium", "medium"],
  ["low", "low"],
]);
const severityOf = (value: unknown): Severity | null => (typeof value === "string" ? (SEVERITIES.get(value) ?? null) : null);

const DEPENDABOT_DISMISSALS = ["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"] as const;
const CODE_DISMISSALS = new Map<string, CloseReason>([
  ["false positive", "false_positive"],
  ["won't fix", "wont_fix"],
  ["used in tests", "used_in_tests"],
]);
const SECRET_RESOLUTIONS = [
  "false_positive",
  "wont_fix",
  "revoked",
  "used_in_tests",
  "pattern_edited",
  "pattern_deleted",
] as const;

/** `CWE-79` for any case of `cwe-79` or zero padded `cwe-079`, and nothing for text that is not a weakness id. */
const cweOf = (value: unknown): string | null => {
  const match = /^cwe-0*(\d{1,6})$/i.exec(str(value) ?? "");
  return match ? `CWE-${Number(match[1])}` : null;
};

/** Where an alert's own page is, when GitHub sent an address on its own site, else the page we know it has. */
const pageOf = (html: unknown, web: string, fallback: string): string => {
  const url = str(html);
  return url !== null && url.startsWith(`${web}/`) ? url : fallback;
};

function dependabotAlert(raw: Json, web: string, address: (kind: string, number: number) => string): DependabotAlert | null {
  const number = num(raw.number);
  const createdAt = str(raw.created_at);
  const state = oneOf(raw.state, ["open", "fixed", "dismissed", "auto_dismissed"] as const);
  if (number === null || createdAt === null || state === null) return null;
  const advisory = obj(raw.security_advisory);
  const vulnerability = obj(raw.security_vulnerability);
  const dependency = obj(raw.dependency);
  const pkg = obj(dependency?.package);
  const alertState: AlertState = state === "auto_dismissed" ? "dismissed" : state;
  const epssRaw = field(advisory, "epss");
  const epss = obj(Array.isArray(epssRaw) ? epssRaw[0] : epssRaw);
  const percentage = fraction(epss?.percentage);
  const percentile = fraction(epss?.percentile);
  const severities = obj(advisory?.cvss_severities);
  const scores = [
    field(obj(severities?.cvss_v4), "score"),
    field(obj(severities?.cvss_v3), "score"),
    field(obj(advisory?.cvss), "score"),
  ];
  const cvssScore = scores.map(num).find((score) => score !== null && score > 0) ?? null;
  const cwes = Array.isArray(advisory?.cwes) ? advisory.cwes.flatMap((cwe: unknown) => cweOf(obj(cwe)?.cwe_id) ?? []) : [];
  const closedAt =
    alertState === "open"
      ? null
      : (str(state === "fixed" ? raw.fixed_at : state === "auto_dismissed" ? raw.auto_dismissed_at : raw.dismissed_at) ??
        str(raw.updated_at));
  return {
    source: "dependabot",
    key: String(number),
    state: alertState,
    createdAt,
    closedAt,
    closeReason:
      alertState === "open"
        ? null
        : state === "fixed"
          ? "fixed"
          : state === "auto_dismissed"
            ? "auto_dismissed"
            : oneOf(raw.dismissed_reason, DEPENDABOT_DISMISSALS),
    title: title(str(advisory?.summary) ?? str(pkg?.name) ?? "Vulnerable dependency"),
    url: pageOf(raw.html_url, web, address("dependabot", number)),
    severity: severityOf(advisory?.severity) ?? severityOf(vulnerability?.severity) ?? "unknown",
    dependency: {
      // A package GitHub did not name stays unnamed, so unrelated alerts are never grouped under a made-up package.
      ecosystem: str(pkg?.ecosystem),
      name: str(pkg?.name),
      manifestPath: str(dependency?.manifest_path),
      scope: oneOf(dependency?.scope, ["runtime", "development"] as const),
      relationship: oneOf(dependency?.relationship, ["direct", "transitive"] as const),
      lockedVersion: null,
      patchedVersion: str(obj(vulnerability?.first_patched_version)?.identifier),
      vulnerableRange: str(vulnerability?.vulnerable_version_range),
      advisoryId: str(advisory?.ghsa_id) ?? str(advisory?.cve_id),
      cveId: str(advisory?.cve_id),
      epss: percentage !== null && percentile !== null ? { percentage, percentile } : null,
      cvssScore,
      cwes,
    },
  };
}

function codeAlert(raw: Json, web: string, address: (kind: string, number: number) => string): CodeAlert | null {
  const number = num(raw.number);
  const createdAt = str(raw.created_at);
  const state = oneOf(raw.state, ["open", "fixed", "dismissed"] as const);
  if (number === null || createdAt === null || state === null) return null;
  const rule = obj(raw.rule);
  const instance = obj(raw.most_recent_instance);
  const location = obj(instance?.location);
  const tags = Array.isArray(rule?.tags) ? rule.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const dismissed = typeof raw.dismissed_reason === "string" ? (CODE_DISMISSALS.get(raw.dismissed_reason) ?? null) : null;
  const ruleId = str(rule?.id);
  return {
    source: "code_scanning",
    key: String(number),
    state,
    createdAt,
    closedAt: state === "open" ? null : (str(state === "fixed" ? raw.fixed_at : raw.dismissed_at) ?? str(raw.updated_at)),
    closeReason: state === "open" ? null : state === "fixed" ? "fixed" : dismissed,
    title: title(str(rule?.description) ?? str(rule?.name) ?? ruleId ?? "Code scanning alert"),
    url: pageOf(raw.html_url, web, address("code_scanning", number)),
    code: {
      ruleId,
      tool: str(obj(raw.tool)?.name) ?? "unknown",
      ruleSeverity: oneOf(rule?.severity, ["none", "note", "warning", "error"] as const),
      securitySeverity: oneOf(rule?.security_severity_level, ["critical", "high", "medium", "low"] as const),
      securityTagged: tags.includes("security"),
      path: str(location?.path),
      line: num(location?.start_line),
      cwes: [
        ...new Set(
          tags.flatMap((tag) =>
            tag.toLowerCase().startsWith("external/cwe/") ? (cweOf(tag.slice("external/cwe/".length)) ?? []) : [],
          ),
        ),
      ],
    },
  };
}

function secretAlert(raw: Json, web: string, address: (kind: string, number: number) => string): SecretAlert | null {
  const number = num(raw.number);
  const createdAt = str(raw.created_at);
  const state = oneOf(raw.state, ["open", "resolved"] as const);
  if (number === null || createdAt === null || state === null) return null;
  const resolution = oneOf(raw.resolution, SECRET_RESOLUTIONS);
  const name = str(raw.secret_type_display_name) ?? str(raw.secret_type) ?? "Secret";
  const alertState: AlertState = state === "open" ? "open" : resolution === "revoked" ? "fixed" : "dismissed";
  return {
    source: "secret_scanning",
    key: String(number),
    state: alertState,
    createdAt,
    closedAt: state === "open" ? null : (str(raw.resolved_at) ?? str(raw.updated_at)),
    closeReason: state === "open" ? null : resolution,
    title: title(name),
    url: pageOf(raw.html_url, web, address("secret_scanning", number)),
    exposure: {
      type: title(name),
      validity: oneOf(raw.validity, ["active", "inactive"] as const) ?? "unknown",
      publiclyLeaked: raw.publicly_leaked === true,
      pushProtectionBypassed: raw.push_protection_bypassed === true,
    },
  };
}

type Rules = Record<Exclude<keyof BranchRules, "requiredApprovals">, boolean> & { requiredApprovals: number };

const BOOLEAN_RULES = [
  "requirePullRequest",
  "dismissStaleReviews",
  "requireCodeOwnerReview",
  "requireStatusChecks",
  "blockForcePushes",
  "blockDeletion",
  "requireSignedCommits",
  "requireLinearHistory",
] as const;

const noRules = (): Rules => ({
  requirePullRequest: false,
  requiredApprovals: 0,
  dismissStaleReviews: false,
  requireCodeOwnerReview: false,
  requireStatusChecks: false,
  blockForcePushes: false,
  blockDeletion: false,
  requireSignedCommits: false,
  requireLinearHistory: false,
});

/** What the branch's rulesets enforce. Only the rule types and their counts and switches are read. */
function fromRulesets(list: unknown[]): Rules {
  const rules = noRules();
  for (const item of list) {
    const rule = obj(item);
    const parameters = obj(rule?.parameters);
    switch (rule?.type) {
      case "pull_request":
        rules.requirePullRequest = true;
        rules.requiredApprovals = Math.max(rules.requiredApprovals, num(parameters?.required_approving_review_count) ?? 0);
        rules.dismissStaleReviews ||= parameters?.dismiss_stale_reviews_on_push === true;
        rules.requireCodeOwnerReview ||= parameters?.require_code_owner_review === true;
        break;
      case "required_status_checks":
        rules.requireStatusChecks = true;
        break;
      case "non_fast_forward":
        rules.blockForcePushes = true;
        break;
      case "deletion":
        rules.blockDeletion = true;
        break;
      case "required_signatures":
        rules.requireSignedCommits = true;
        break;
      case "required_linear_history":
        rules.requireLinearHistory = true;
        break;
    }
  }
  return rules;
}

/** What classic branch protection enforces, from the administrator's view of it. Reviewer and team lists are never read. */
function fromProtection(body: Json): Rules {
  const reviews = obj(body.required_pull_request_reviews);
  return {
    requirePullRequest: reviews !== null,
    requiredApprovals: reviews === null ? 0 : (num(reviews.required_approving_review_count) ?? 0),
    dismissStaleReviews: reviews?.dismiss_stale_reviews === true,
    requireCodeOwnerReview: reviews?.require_code_owner_reviews === true,
    requireStatusChecks: obj(body.required_status_checks) !== null,
    blockForcePushes: obj(body.allow_force_pushes)?.enabled !== true,
    blockDeletion: obj(body.allow_deletions)?.enabled !== true,
    requireSignedCommits: obj(body.required_signatures)?.enabled === true,
    requireLinearHistory: obj(body.required_linear_history)?.enabled === true,
  };
}

/**
 * A rule is true when either source enforces it, false only when every source that could enforce it was read in full
 * and none does, and null otherwise, so a rule nobody could see is never reported as missing.
 */
function mergeRules(classic: Rules | null, rulesets: Rules | null, rulesetsComplete: boolean): BranchRules {
  const merged: BranchRules = {
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
  for (const rule of BOOLEAN_RULES) {
    merged[rule] = classic?.[rule] || rulesets?.[rule] ? true : classic && rulesets && rulesetsComplete ? false : null;
  }
  if (merged.requirePullRequest === false) merged.requiredApprovals = 0;
  else if (merged.requirePullRequest === true) {
    merged.requiredApprovals = Math.max(classic?.requiredApprovals ?? 0, rulesets?.requiredApprovals ?? 0);
  }
  return merged;
}

/**
 * The answer for a refusal of a part of the posture: null when the credential may not see it, which leaves the part
 * unknown. Any other refusal, such as a single sign-on block, raises so the crawl keeps the earlier posture.
 */
/** `: message` for a message of a known kind, else nothing, so no free text from upstream reaches an error. */
const shown = (message: string): string => (knownMessage(message) ? `: ${knownMessage(message)}` : "");

function unseen(page: { status: number; message: string }, label: string): null {
  if (page.status === 403 && NOT_PERMITTED.test(page.message)) return null;
  throw new UpstreamError(`GitHub refused to read ${label}${shown(page.message)}`, page.status);
}

const enabledOf = (body: Json | null, key = "status"): boolean | null => {
  const status = body ? body[key] : undefined;
  return status === "enabled" ? true : status === "disabled" ? false : null;
};

/**
 * GitHub's security alerts and repository settings over its REST API, read with the token the crawl already holds.
 * What follows is GitHub's side of the `SecurityAlertSource` contract.
 *
 * - Lists are read 100 to a page, most recently updated first, following GitHub's `next` link for at most ten pages.
 *   A link to another host, or to http, is never followed, so the token cannot be sent anywhere else. A list cut by
 *   the page limit, or whose next link was refused, is `ok` with `truncated` set, so nothing unread is pruned.
 * - Dependabot: a 403 that says Dependabot alerts are disabled is `off` (`disabled`); a 403 that says the resource is
 *   not accessible or that admin rights are needed, and any 404, is `no_access` (`forbidden`).
 * - Code scanning: a 403 that says Advanced Security must be enabled or code scanning is not enabled is `off`
 *   (`needs_advanced_security`); a 404 whose message says "no analysis found" is `off` (`not_set_up`), and any other
 *   404 is `no_access` (`forbidden`); a 403 that says the resource is not accessible is `no_access` (`forbidden`).
 * - Secret scanning is read with `hide_secret=true`, and a 404, which GitHub also sends to a person who is not an
 *   administrator, is `no_access` (`admin_only_or_off`); so is a 403 that says the resource is not accessible.
 * - Any other 403, such as a single sign-on block, raises `UpstreamError` with GitHub's message. A rate limit raises
 *   too, whatever the status and whether or not GitHub sent its headers, and is never read as "off".
 * - The posture reads each part on its own. A part is left null only when GitHub says this credential may not see it
 *   (a 403 that says the resource is not accessible or that admin rights are needed) or, for the parts that need an
 *   administrator or a plan that has them, a 404. Any other refusal raises, and so does a 404 for the repository or the
 *   deploy branch, so the crawl keeps the earlier posture rather than saving one made of nulls.
 * - Rule 9 (ADR 0031): the whole reply is parsed, but only these are mapped: GitHub's codes and numbers, times,
 *   package, rule and tool names, paths, CWE ids, and the published titles (an advisory summary, a rule description
 *   or a secret type's display name, each cut to 300 characters). No person, comment, rule help or advisory
 *   description is mapped, and the secret value is never requested (`hide_secret=true`) and never mapped.
 */
export class GitHubSecurityAlertSource implements SecurityAlertSource {
  readonly kind = "github";

  constructor(
    private readonly http: Fetch = fetch,
    private readonly base = API,
    private readonly web = "https://github.com",
  ) {}

  settingsUrl(owner: string, name: string): string {
    return `${this.web}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings/security_analysis`;
  }

  dependencyAlerts(token: string, owner: string, name: string): Promise<AlertRead<"dependabot">> {
    return this.readAlerts("dependabot", token, owner, name, "dependabot/alerts", "Dependabot", dependabotAlert, (refusal) => {
      if (refusal.status === 403 && /dependabot alerts are disabled/i.test(refusal.message)) {
        return { status: "off", reason: "disabled" };
      }
      if (refusal.status === 404 || NOT_PERMITTED.test(refusal.message)) {
        return { status: "no_access", reason: "forbidden" };
      }
      return null;
    });
  }

  codeAlerts(token: string, owner: string, name: string): Promise<AlertRead<"code_scanning">> {
    return this.readAlerts("code_scanning", token, owner, name, "code-scanning/alerts", "code scanning", codeAlert, (refusal) => {
      // GitHub's 404 for an analysis-less repository says so; any other 404 is a credential that cannot see the list.
      if (refusal.status === 404) {
        return /no analysis found/i.test(refusal.message)
          ? { status: "off", reason: "not_set_up" }
          : { status: "no_access", reason: "forbidden" };
      }
      if (/advanced security must be enabled|code scanning is not enabled/i.test(refusal.message)) {
        return { status: "off", reason: "needs_advanced_security" };
      }
      if (NOT_PERMITTED.test(refusal.message)) return { status: "no_access", reason: "forbidden" };
      return null;
    });
  }

  secretAlerts(token: string, owner: string, name: string): Promise<AlertRead<"secret_scanning">> {
    return this.readAlerts(
      "secret_scanning",
      token,
      owner,
      name,
      "secret-scanning/alerts",
      "secret scanning",
      secretAlert,
      (refusal) => {
        if (refusal.status === 404 || NOT_PERMITTED.test(refusal.message)) {
          return { status: "no_access", reason: "admin_only_or_off" };
        }
        return null;
      },
    );
  }

  async posture(token: string, owner: string, name: string, branch: string): Promise<RepoPosture> {
    const repoPath = this.repoPath(owner, name);
    const branchPath = branch.split("/").map(encodeURIComponent).join("/");
    const repo = await this.fetchOne(token, repoPath, "the repository", {
      missing: () => new NotFoundError("GitHub could not find the repository, or the credential cannot see it"),
    });
    const analysis = obj(repo?.security_and_analysis);
    const permissions = obj(repo?.permissions);
    const visibility =
      oneOf(repo?.visibility, ["public", "private", "internal"] as const) ??
      (bool(repo?.private) === null ? null : repo?.private === true ? "private" : "public");

    const branchBody = await this.fetchOne(token, `${repoPath}/branches/${branchPath}`, `the branch "${branch}"`, {
      missing: () =>
        new NotFoundError(`GitHub could not find the deploy branch "${branch}", so its protection could not be read`),
    });
    const isProtected = bool(branchBody?.protected);
    const hint = obj(obj(branchBody?.protection)?.required_status_checks);
    const hintChecks =
      hint !== null &&
      hint.enforcement_level !== "off" &&
      ((Array.isArray(hint.contexts) && hint.contexts.length > 0) || (Array.isArray(hint.checks) && hint.checks.length > 0));
    // An unprotected branch has no classic protection to read, so it is asked nothing and counts as fully known.
    const classicRead =
      isProtected === true ? await this.readProtection(token, `${repoPath}/branches/${branchPath}/protection`) : null;
    const protection = classicRead?.kind === "rules" ? classicRead.body : null;
    const noClassic = isProtected === false || classicRead?.kind === "none";
    const ruleList = await this.fetchList(token, `${repoPath}/rules/branches/${branchPath}?per_page=100`, "the branch's rules");

    const classic = protection ? fromProtection(protection) : noClassic ? noRules() : null;
    const rulesets = ruleList ? fromRulesets(ruleList.items) : null;
    // Rules past the page limit were not seen, so the rulesets can still say a rule is enforced but never that it is not.
    const rulesetsComplete = ruleList?.complete === true;
    const rules = mergeRules(classic, rulesets, rulesetsComplete);
    if (rules.requireStatusChecks === null && hintChecks) rules.requireStatusChecks = true;

    // The repository read only carries the settings for an administrator, so anyone else is asked the endpoint.
    const fixes =
      enabledOf(obj(analysis?.dependabot_security_updates)) ??
      bool((await this.fetchOne(token, `${repoPath}/automated-security-fixes`, "automated security fixes"))?.enabled);
    // Both features exist only for public repositories, and GitHub answers 404 for a private one, so it is not asked.
    const isPublic = visibility === "public";
    const reporting = isPublic
      ? bool(
          (await this.fetchOne(token, `${repoPath}/private-vulnerability-reporting`, "private vulnerability reporting"))?.enabled,
        )
      : null;
    const advisories = isPublic
      ? await this.fetchList(token, `${repoPath}/security-advisories?per_page=100`, "the repository's advisories")
      : null;

    return {
      visibility,
      isAdmin: bool(permissions?.admin),
      branch: {
        name: branch,
        protected: isProtected,
        rules,
        // Rules a partly read ruleset list left unseen are null whatever the detail says. A branch known to be unprotected
        // whose rulesets were cut is "full" only when they were read in full: otherwise a ruleset past the cut might
        // protect it, so with nothing seen to be enforced the rules are not known (`none`), and core does not grade it
        // as unprotected.
        detail: protection
          ? "full"
          : rulesets
            ? noClassic
              ? rulesetsComplete
                ? "full"
                : Object.values(rules).some((rule) => rule === true || (typeof rule === "number" && rule > 0))
                  ? "rulesets_only"
                  : "none"
              : "rulesets_only"
            : "none",
      },
      settings: {
        dependabotSecurityUpdates: fixes,
        secretScanning: enabledOf(obj(analysis?.secret_scanning)),
        pushProtection: enabledOf(obj(analysis?.secret_scanning_push_protection)),
        validityChecks: enabledOf(obj(analysis?.secret_scanning_validity_checks)),
        privateVulnerabilityReporting: reporting,
      },
      // A list cut at the page limit would understate the counts, so it is reported as not read.
      advisories: advisories?.complete ? countAdvisories(advisories.items) : null,
    };
  }

  /**
   * Classic protection, "none" when GitHub says the branch is not protected, or null when this credential cannot see
   * it. A 404 with any other message is what GitHub sends a person who is not an administrator, so it is null too.
   */
  private async readProtection(token: string, url: string): Promise<{ kind: "rules"; body: Json } | { kind: "none" } | null> {
    const page = await requestPage<unknown>(this.http, token, url, [403, 404]);
    if ("body" in page) {
      const body = obj(page.body);
      return body ? { kind: "rules", body } : null;
    }
    if (page.status === 404) return /branch not protected/i.test(page.message) ? { kind: "none" } : null;
    return unseen(page, "the branch's protection");
  }

  private repoPath(owner: string, name: string): string {
    return `${this.base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** A page on the host's own site for one alert, used when GitHub's `html_url` is missing or elsewhere. */
  private alertPage(owner: string, name: string): (kind: string, number: number) => string {
    const root = `${this.web}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/security`;
    const paths: Record<string, string> = {
      dependabot: "dependabot",
      code_scanning: "code-scanning",
      secret_scanning: "secret-scanning",
    };
    return (kind, number) => `${root}/${paths[kind] ?? kind}/${number}`;
  }

  /**
   * One object from GitHub, or null when the credential may not see it. A 404 is read as "not visible" unless `missing`
   * says it is an error, as it is for the repository and the deploy branch; any other refusal raises.
   */
  private async fetchOne(
    token: string,
    url: string,
    label: string,
    options: { missing?: () => Error } = {},
  ): Promise<Json | null> {
    const page = await requestPage<unknown>(this.http, token, url, [403, 404]);
    if ("body" in page) return obj(page.body);
    if (page.status === 404 && options.missing) throw options.missing();
    return page.status === 404 ? null : unseen(page, label);
  }

  /**
   * A list from GitHub, 100 to a page, following `next` for at most `MAX_LIST_PAGES`. `complete` is false when the
   * list went on past the limit or its next link was refused. Null when the credential may not see the list, or when
   * the first page is not a list.
   */
  private async fetchList(token: string, url: string, label: string): Promise<{ items: unknown[]; complete: boolean } | null> {
    const items: unknown[] = [];
    let next: string | null = url;
    for (let pages = 0; next !== null; pages++) {
      if (pages === MAX_LIST_PAGES) return { items, complete: false };
      const page: PageResult<unknown> = await requestPage<unknown>(this.http, token, next, [403, 404]);
      if ("status" in page) {
        if (pages > 0) throw new UpstreamError(`GitHub refused to list ${label}${shown(page.message)}`, page.status);
        return page.status === 404 ? null : unseen(page, label);
      }
      if (!Array.isArray(page.body)) {
        if (pages === 0) return null;
        throw new UpstreamError(`GitHub sent no list of ${label}`, 502);
      }
      items.push(...page.body);
      if (page.next.kind === "refused") return { items, complete: false };
      next = page.next.kind === "next" ? page.next.url : null;
    }
    return { items, complete: true };
  }

  private async readAlerts<S extends AlertSource>(
    _source: S,
    token: string,
    owner: string,
    name: string,
    path: string,
    label: string,
    mapper: (raw: Json, web: string, address: (kind: string, number: number) => string) => AlertOf<S> | null,
    classify: (refusal: { status: number; message: string }) => Exclude<AlertRead<S>, { status: "ok" }> | null,
  ): Promise<AlertRead<S>> {
    const secrets = path.startsWith("secret-scanning");
    const address = this.alertPage(owner, name);
    const map = (raw: Json): AlertOf<S> | null => mapper(raw, this.web, address);
    const alerts: AlertOf<S>[] = [];
    let skipped = 0;
    const skippedKeys: string[] = [];
    let url: string | null = `${this.repoPath(owner, name)}/${path}?per_page=100&sort=updated&direction=desc`;
    for (let pages = 0; url !== null; pages++) {
      if (pages === MAX_PAGES) return { status: "ok", alerts, truncated: true, skipped, skippedKeys };
      const page: PageResult<unknown> = await requestPage<unknown>(
        this.http,
        token,
        secrets ? withHiddenSecret(url) : url,
        [403, 404],
      );
      if ("status" in page) {
        const answer = pages === 0 ? classify(page) : null;
        if (answer) return answer;
        throw new UpstreamError(`GitHub refused to list ${label} alerts${shown(page.message)}`, page.status);
      }
      if (!Array.isArray(page.body)) throw new UpstreamError(`GitHub sent no list of ${label} alerts`, 502);
      for (const item of page.body) {
        const raw = obj(item);
        const alert = raw ? map(raw) : null;
        if (alert) alerts.push(alert);
        else {
          skipped++;
          const number = num(raw?.number);
          if (number !== null) skippedKeys.push(String(number));
        }
      }
      // A next link that was refused means the list went on, so what was read is only part of it.
      if (page.next.kind === "refused") return { status: "ok", alerts, truncated: true, skipped, skippedKeys };
      url = page.next.kind === "next" ? page.next.url : null;
    }
    return { status: "ok", alerts, truncated: false, skipped, skippedKeys };
  }
}

/** Sets `hide_secret=true` on an address, so a next link that dropped it cannot bring the secret values back. */
function withHiddenSecret(address: string): string {
  const url = new URL(address);
  url.searchParams.set("hide_secret", "true");
  return url.toString();
}

function countAdvisories(list: unknown[]): NonNullable<RepoPosture["advisories"]> {
  const counts = { draft: 0, triage: 0, published: 0, closed: 0 };
  for (const item of list) {
    const state = oneOf(obj(item)?.state, ["draft", "triage", "published", "closed"] as const);
    if (state) counts[state]++;
  }
  return counts;
}
