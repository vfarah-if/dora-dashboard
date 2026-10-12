import type { AlertSource, DependencyAlert, LockedPackage, Repo, SourceState } from "@dora-dashboard/core";
import { DAY_MS, isUsable, osvFindings, reconcileOsvAlerts } from "@dora-dashboard/core";
import { AppError, UnauthorisedError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import type { AlertRead, SecurityAlertSource } from "../interfaces/security-alert-source.js";
import type { ScorecardSource } from "../interfaces/scorecard-source.js";
import type { SecurityStore } from "../interfaces/security-store.js";
import type { VulnerabilityDatabase } from "../interfaces/vulnerability-database.js";
import type { SecurityStep } from "./crawl-service.js";

/** Stored in place of a failure's own message when it is not one the person can act on; the detail is in the log. */
const UNEXPECTED_FAILURE = "Reading this source failed unexpectedly. See the API log.";
const POSTURE_FAILURE = "The repository's security settings could not be read. See the API log.";
const SCORECARD_FAILURE = "The OpenSSF Scorecard could not be read. See the API log.";
/** The most distinct packages (ecosystem, name and version) one repository sends to the vulnerability database. */
export const MAX_OSV_PACKAGES = 20_000;

type GitHubSource = Exclude<AlertSource, "osv">;

const SOURCE_LABEL: Record<AlertSource, string> = {
  dependabot: "Dependabot",
  code_scanning: "code scanning",
  secret_scanning: "secret scanning",
  osv: "OSV",
};

/**
 * A stored failure message with the token and any query string removed, so nothing that could authorise a request or
 * name what was asked for is ever kept. `token` is empty for a source that holds none.
 */
export function scrub(message: string, token: string): string {
  const bare = token === "" ? message : message.split(token).join("[token]");
  return bare.replace(/(https?:\/\/[^\s?#"'<>)]*)[?#][^\s"'<>)]*/g, "$1");
}

/**
 * The packages to look up: every entry whose ecosystem, name and version is among the first `MAX_OSV_PACKAGES`
 * distinct ones, so a package named by several lockfiles keeps all its entries. `capped` says the limit bit.
 */
function capDistinct(packages: readonly LockedPackage[]): { kept: LockedPackage[]; capped: boolean } {
  const allowed = new Set<string>();
  const kept: LockedPackage[] = [];
  let capped = false;
  for (const pkg of packages) {
    const key = JSON.stringify([pkg.ecosystem, pkg.name, pkg.version]);
    if (!allowed.has(key)) {
      if (allowed.size === MAX_OSV_PACKAGES) {
        capped = true;
        continue;
      }
      allowed.add(key);
    }
    kept.push(pkg);
  }
  return { kept, capped };
}

/** True for an npm package whose scope is the repository's owner or one the operator listed as private. */
function isPrivateScope(pkg: LockedPackage, owner: string, scopes: ReadonlySet<string>): boolean {
  if (pkg.ecosystem !== "npm" || !pkg.name.startsWith("@")) return false;
  const scope = pkg.name.split("/")[0]!.toLowerCase();
  return scope === `@${owner.toLowerCase()}` || scopes.has(scope);
}

/**
 * The security step of a crawl (ADR 0031, 0034, 0035). Order: the repository's posture, then each alert source on its
 * own, then the optional OSV lookup, then the optional Scorecard. Each source stores its own outcome, so one failing
 * leaves the others and its own earlier alerts alone. Only a rejected GitHub credential escapes, and fails the crawl.
 */
export class SecurityCrawlService implements SecurityStep {
  private readonly scopes: ReadonlySet<string>;

  constructor(
    private readonly store: SecurityStore,
    private readonly source: SecurityAlertSource,
    private readonly osv: VulnerabilityDatabase | null,
    private readonly scorecard: ScorecardSource | null,
    private readonly now: () => Date,
    private readonly log: Logger,
    privateNpmScopes: readonly string[],
  ) {
    // A scope is accepted with or without its leading `@`.
    this.scopes = new Set(
      privateNpmScopes.map((scope) => scope.trim().toLowerCase().replace(/^@?/, "@")).filter((scope) => scope !== "@"),
    );
  }

  async read(token: string, repo: Repo, full: boolean): Promise<void> {
    const publicNow = await this.readPosture(token, repo);
    await this.readAlerts(token, repo, "dependabot", () => this.source.dependencyAlerts(token, repo.owner, repo.name));
    await this.readAlerts(token, repo, "code_scanning", () => this.source.codeAlerts(token, repo.owner, repo.name));
    await this.readAlerts(token, repo, "secret_scanning", () => this.source.secretAlerts(token, repo.owner, repo.name));
    await this.readOsv(repo);
    await this.readScorecard(repo, full, publicNow);
  }

  /**
   * Stores the posture and answers whether this read succeeded and says the repository is public. A failure other than
   * a rejected credential is logged and stored beside the earlier posture, which is kept, so the report can say the
   * branch facts are from an earlier read.
   */
  private async readPosture(token: string, repo: Repo): Promise<boolean> {
    const at = this.now().toISOString();
    try {
      const posture = await this.source.posture(token, repo.owner, repo.name, repo.deployBranch);
      this.store.savePosture(repo.id, posture, at);
      return posture.visibility === "public";
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      this.log.warn({ err, repoId: repo.id }, "could not read the repository's security posture; the earlier one is kept");
      this.store.failPosture(repo.id, err instanceof AppError ? scrub(err.message, token) : POSTURE_FAILURE, at);
      return false;
    }
  }

  private async readAlerts(token: string, repo: Repo, source: GitHubSource, ask: () => Promise<AlertRead>): Promise<void> {
    const at = this.now().toISOString();
    let read: AlertRead;
    try {
      read = await ask();
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      this.failSource(repo, source, err, at, token);
      return;
    }
    if (read.status !== "ok") {
      // `off` is GitHub saying the feature is not switched on, so nothing is left to show. `no_access` only says this
      // credential cannot see the list, so what a more privileged one stored stays, with its read time; core grades
      // only a source that was read, so the kept alerts are not counted while access is lacking.
      if (read.status === "off") this.store.clearSecurityAlerts(repo.id, source);
      const kept = read.status === "no_access" ? this.store.sourceStates(repo.id)[source].readAt : null;
      this.store.setSourceState(repo.id, source, {
        status: read.status,
        reason: read.reason,
        readAt: kept,
        attemptedAt: at,
        truncated: false,
        error: null,
      });
      return;
    }
    if (read.skipped > 0)
      this.log.warn({ repoId: repo.id, source, skipped: read.skipped }, "skipped alerts that could not be mapped");
    // A read that stopped at the page limit holds only the newest updates, and one that skipped alerts it could not map
    // may have left out ones stored earlier; neither may prune what it did not see.
    this.store.saveSecurityAlerts(repo.id, source, read.alerts, !read.truncated && read.skipped === 0);
    this.store.setSourceState(repo.id, source, {
      status: "ok",
      reason: null,
      readAt: at,
      attemptedAt: at,
      truncated: read.truncated,
      error: null,
    });
  }

  /** Records the failure and keeps the previous alerts and read time, so the last good figures still stand. */
  private failSource(repo: Repo, source: AlertSource, err: unknown, at: string, token = ""): void {
    const message = err instanceof AppError ? scrub(err.message, token) : UNEXPECTED_FAILURE;
    if (err instanceof AppError) this.log.warn({ err, repoId: repo.id, source }, `reading ${SOURCE_LABEL[source]} alerts failed`);
    else this.log.error({ err, repoId: repo.id, source }, `reading ${SOURCE_LABEL[source]} alerts failed unexpectedly`);
    const previous = this.store.sourceStates(repo.id)[source];
    this.store.setSourceState(repo.id, source, {
      ...previous,
      status: "error",
      reason: null,
      attemptedAt: at,
      error: message,
    });
  }

  private skipOsv(repo: Repo, reason: "lookup_off" | "dependabot_ok" | "no_inventory", at: string): void {
    this.store.clearSecurityAlerts(repo.id, "osv");
    this.store.setSourceState(repo.id, "osv", {
      status: "off",
      reason,
      readAt: null,
      attemptedAt: at,
      truncated: false,
      error: null,
    });
  }

  private async readOsv(repo: Repo): Promise<void> {
    const at = this.now().toISOString();
    if (!this.osv) return this.skipOsv(repo, "lookup_off", at);
    const dependabot: SourceState = this.store.sourceStates(repo.id).dependabot;
    if (isUsable(dependabot)) return this.skipOsv(repo, "dependabot_ok", at);
    const held = this.store.lockedPackages(repo.id);
    if (held.length === 0) return this.skipOsv(repo, "no_inventory", at);

    // Only public packages ever leave, and never one whose scope could name a private registry (ADR 0034).
    const { kept: packages, capped } = capDistinct(held.filter((pkg) => !isPrivateScope(pkg, repo.owner, this.scopes)));
    if (capped)
      this.log.warn({ repoId: repo.id, limit: MAX_OSV_PACKAGES }, "too many distinct packages; looking up the first ones only");
    try {
      const looked = packages.length === 0 ? { results: [], truncated: false } : await this.osv.lookup(packages);
      const truncated = looked.truncated || capped;
      const results = looked.results;
      const stored = this.store.securityAlerts(repo.id).filter((alert): alert is DependencyAlert => alert.source === "osv");
      // A lookup that stopped short says nothing about the packages it did not reach, so it closes nothing.
      const lockfiles = this.store.supplyChain(repo.id)?.facts.lockfiles ?? [];
      const lockfilesRead = new Set(truncated ? [] : lockfiles.filter((l) => l.read === "parsed").map((l) => l.path));
      // A lockfile no longer in the latest record was deleted, so its alerts close; one still there but unread keeps them.
      const lockfilesPresent = new Set(lockfiles.map((l) => l.path));
      const found = osvFindings(packages, results, at);
      this.store.saveSecurityAlerts(
        repo.id,
        "osv",
        reconcileOsvAlerts(stored, found, { now: at, lockfilesRead, lockfilesPresent }),
        true,
      );
      this.store.setSourceState(repo.id, "osv", {
        status: "ok",
        reason: null,
        readAt: at,
        attemptedAt: at,
        truncated,
        error: null,
      });
    } catch (err) {
      this.failSource(repo, "osv", err, at);
    }
  }

  private async readScorecard(repo: Repo, full: boolean, publicNow: boolean): Promise<void> {
    if (!this.scorecard) return;
    // Only a repository the host said is public in this very crawl is ever named to the service. A stored posture is
    // not enough: if this read failed, the repository may have been made private since.
    if (!publicNow) return;
    const now = this.now();
    const held = this.store.scorecard(repo.id);
    if (!full && held?.readAt && now.getTime() - Date.parse(held.readAt) < DAY_MS) return;
    try {
      this.store.saveScorecard(repo.id, now.toISOString(), await this.scorecard.scorecard(repo.owner, repo.name));
    } catch (err) {
      this.log.warn({ err, repoId: repo.id }, "could not read the OpenSSF Scorecard");
      this.store.failScorecard(repo.id, SCORECARD_FAILURE);
    }
  }
}
