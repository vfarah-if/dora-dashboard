import type { AlertSource, LockedPackage, NotUsedReason, Repo, SecurityAlert, SourceState } from "@dora-dashboard/core";
import {
  DAY_MS,
  failedSource,
  isLockfileComplete,
  isUsable,
  osvFindings,
  osvPackageKey,
  presentLockfiles,
  reconcileOsvAlerts,
} from "@dora-dashboard/core";
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

/** The sources the code host's own port answers; OSV is looked up from the locked packages instead. */
type HostSource = Exclude<AlertSource, "osv">;

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
 * distinct ones, so a package named by several lockfiles keeps all its entries. `dropped` holds the entries past the
 * limit, which are not looked up, so the lockfiles that name them cannot be said to have been read.
 */
function capDistinct(packages: readonly LockedPackage[]): { kept: LockedPackage[]; dropped: LockedPackage[] } {
  const allowed = new Set<string>();
  const kept: LockedPackage[] = [];
  const dropped: LockedPackage[] = [];
  for (const pkg of packages) {
    const key = JSON.stringify([pkg.ecosystem, pkg.name, pkg.version]);
    if (!allowed.has(key)) {
      if (allowed.size === MAX_OSV_PACKAGES) {
        dropped.push(pkg);
        continue;
      }
      allowed.add(key);
    }
    kept.push(pkg);
  }
  return { kept, dropped };
}

/** True for an npm package whose scope is the repository's owner or one the operator listed as private. */
function isPrivateScope(
  pkg: { ecosystem: string | null; name: string | null },
  owner: string,
  scopes: ReadonlySet<string>,
): boolean {
  if (pkg.ecosystem !== "npm" || pkg.name === null || !pkg.name.startsWith("@")) return false;
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
   * Runs one stage of the step. Anything but a rejected credential, including a failure of the store, is recorded by
   * `record` against that stage and the step goes on, so one broken stage never costs the stages after it. If recording
   * fails too, that is logged at error level and nothing escapes.
   */
  private async stage(repo: Repo, label: string, run: () => Promise<void>, record: (err: unknown) => void): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      try {
        record(err);
      } catch (inner) {
        this.log.error({ err: inner, repoId: repo.id }, `could not record that the ${label} failed`);
      }
    }
  }

  /** A failure is logged as a warning when it is one the person can act on, else as an error. */
  private logFailure(err: unknown, context: Record<string, unknown>, message: string): void {
    if (err instanceof AppError) this.log.warn({ err, ...context }, message);
    else this.log.error({ err, ...context }, `${message} unexpectedly`);
  }

  /**
   * Stores the posture and answers whether this read succeeded and says the repository is public. A failure other than
   * a rejected credential is logged and stored beside the earlier posture, which is kept, so the report can say the
   * branch facts are from an earlier read.
   */
  private async readPosture(token: string, repo: Repo): Promise<boolean> {
    const at = this.now().toISOString();
    let publicNow = false;
    await this.stage(
      repo,
      "posture read",
      async () => {
        const posture = await this.source.posture(token, repo.owner, repo.name, repo.deployBranch);
        this.store.savePosture(repo.id, posture, at);
        publicNow = posture.visibility === "public";
      },
      (err) => {
        this.logFailure(err, { repoId: repo.id }, "could not read the repository's security posture; the earlier one is kept");
        this.store.failPosture(repo.id, err instanceof AppError ? scrub(err.message, token) : POSTURE_FAILURE, at);
      },
    );
    return publicNow;
  }

  private async readAlerts<S extends HostSource>(
    token: string,
    repo: Repo,
    source: S,
    ask: () => Promise<AlertRead<S>>,
  ): Promise<void> {
    const at = this.now().toISOString();
    await this.stage(
      repo,
      `${SOURCE_LABEL[source]} read`,
      async () => this.saveRead(repo, source, await ask(), at),
      (err) => this.failSource(repo, source, err, at, token),
    );
  }

  private saveRead<S extends HostSource>(repo: Repo, source: S, read: AlertRead<S>, at: string): void {
    if (read.status !== "ok") {
      // `off` is the host saying the feature is not switched on, so nothing is left to show. `no_access` only says this
      // credential cannot see the list, so what a more privileged one stored stays; core uses only a source that was
      // read, and the state carries no read time, so the kept alerts are not counted while access is lacking.
      if (read.status === "off") this.store.clearSecurityAlerts(repo.id, source);
      this.store.setSourceState(repo.id, source, { status: read.status, reason: read.reason, attemptedAt: at } as SourceState);
      return;
    }
    if (read.skipped > 0)
      this.log.warn({ repoId: repo.id, source, skipped: read.skipped }, "skipped alerts that could not be mapped");
    // A read that stopped short holds only the newest updates, and one that skipped an alert it could not even number
    // may have left out ones stored earlier; neither may prune what it did not see. An alert that was numbered but could
    // not be mapped is still there, so what is stored for it stays and does not block the pruning for the rest.
    const unnumbered = read.skipped - read.skippedKeys.length;
    const unmapped = new Set(read.skippedKeys);
    const present = this.store.securityAlertsOf(repo.id, source).filter((alert: SecurityAlert) => unmapped.has(alert.key));
    this.store.saveSecurityAlerts(
      repo.id,
      source,
      [...read.alerts, ...present],
      read.truncated || unnumbered > 0 ? "merge" : "replace",
    );
    this.store.setSourceState(repo.id, source, {
      status: "ok",
      readAt: at,
      attemptedAt: at,
      truncated: read.truncated,
      skipped: read.skipped,
    });
  }

  /**
   * Records the failure and keeps the previous alerts. Core's `failedSource` carries the last good read only from an
   * `ok` state or from an earlier failure that had one, so a failure after `off`, `no_access` or `not_used` cannot make
   * older alerts count again.
   */
  private failSource(repo: Repo, source: AlertSource, err: unknown, at: string, token = ""): void {
    const message = err instanceof AppError ? scrub(err.message, token) : UNEXPECTED_FAILURE;
    this.logFailure(err, { repoId: repo.id, source }, `reading ${SOURCE_LABEL[source]} alerts failed`);
    this.store.setSourceState(repo.id, source, failedSource(this.store.sourceStates(repo.id)[source], message, at));
  }

  private skipOsv(repo: Repo, reason: NotUsedReason, at: string): void {
    this.store.clearSecurityAlerts(repo.id, "osv");
    this.store.setSourceState(repo.id, "osv", { status: "not_used", reason, attemptedAt: at });
  }

  private async readOsv(repo: Repo): Promise<void> {
    const at = this.now().toISOString();
    await this.stage(
      repo,
      "OSV lookup",
      () => this.lookUp(repo, at),
      (err) => this.failSource(repo, "osv", err, at),
    );
  }

  private async lookUp(repo: Repo, at: string): Promise<void> {
    if (!this.osv) return this.skipOsv(repo, "lookup_off", at);
    const dependabot: SourceState = this.store.sourceStates(repo.id).dependabot;
    if (isUsable(dependabot)) return this.skipOsv(repo, "dependabot_ok", at);
    // Without a record of what the clone held nothing is known about the lockfiles, which is not the same as there being
    // none, so what was stored is left as it is.
    const record = this.store.supplyChain(repo.id);
    if (record === null) {
      // A state that says the lookup was off or Dependabot's alerts were used would be untrue now, so it is cleared to
      // `not_read`. A state that holds a read, or a failure, is left, so alerts already in use stay in use.
      if (this.store.sourceStates(repo.id).osv.status === "not_used") {
        this.store.setSourceState(repo.id, "osv", { status: "not_read" });
      }
      return;
    }
    const lockfiles = record.facts.lockfiles;
    // `no_inventory` says the clone holds no lockfile that could name a public package. A lockfile that exists but could
    // not be read might, and its alerts are left alone below.
    const couldHold = lockfiles.some((l) => l.read !== "not_supported" && !(l.read === "parsed" && l.publicPackages === 0));
    if (!couldHold) return this.skipOsv(repo, "no_inventory", at);

    // Only public packages ever leave, and never one whose scope could name a private registry (ADR 0034).
    const held = this.store.lockedPackages(repo.id);
    const withheld = held.filter((pkg) => isPrivateScope(pkg, repo.owner, this.scopes));
    const { kept: packages, dropped } = capDistinct(held.filter((pkg) => !isPrivateScope(pkg, repo.owner, this.scopes)));
    if (dropped.length > 0) {
      this.log.warn({ repoId: repo.id, limit: MAX_OSV_PACKAGES }, "too many distinct packages; looking up the first ones only");
    }
    const { results } = packages.length === 0 ? { results: [] } : await this.osv.lookup(packages);

    // A package that was withheld, past the limit or not answered in full says nothing about its alerts, which stay as
    // they were. Every other package of a lockfile read in full is answered, so what it no longer has closes.
    const unanswered = new Set([...withheld, ...dropped].map(osvPackageKey));
    let cutShort = dropped.length > 0 || lockfiles.some((l) => l.read === "parsed" && l.capped);
    packages.forEach((pkg, i) => {
      if (results[i] !== null) return;
      unanswered.add(osvPackageKey(pkg));
      cutShort = true;
    });
    const lockfilesRead = new Set(lockfiles.filter(isLockfileComplete).map((l) => l.path));
    // A lockfile no longer in the latest record was deleted, so its alerts close, but only when the listing it came from
    // was complete; one still there but unread keeps them.
    const lockfilesPresent = presentLockfiles(record.facts);

    const found = osvFindings(packages, results, at);
    this.store.saveSecurityAlerts(
      repo.id,
      "osv",
      reconcileOsvAlerts(this.store.securityAlertsOf(repo.id, "osv"), found, {
        now: at,
        lockfilesRead,
        lockfilesPresent,
        unanswered,
      }),
      "replace",
    );
    this.store.setSourceState(repo.id, "osv", {
      status: "ok",
      readAt: at,
      attemptedAt: at,
      truncated: cutShort,
      skipped: 0,
    });
  }

  private async readScorecard(repo: Repo, full: boolean, publicNow: boolean): Promise<void> {
    if (!this.scorecard) return;
    // Only a repository the host said is public in this very crawl is ever named to the service. A stored posture is
    // not enough: if this read failed, the repository may have been made private since.
    if (!publicNow) return;
    const scorecard = this.scorecard;
    await this.stage(
      repo,
      "Scorecard read",
      async () => {
        const now = this.now();
        const held = this.store.scorecard(repo.id);
        if (!full && held?.readAt && now.getTime() - Date.parse(held.readAt) < DAY_MS) return;
        this.store.saveScorecard(repo.id, now.toISOString(), await scorecard.scorecard(repo.owner, repo.name));
      },
      (err) => {
        this.logFailure(err, { repoId: repo.id }, "could not read the OpenSSF Scorecard");
        this.store.failScorecard(
          repo.id,
          err instanceof AppError ? scrub(err.message, "") : SCORECARD_FAILURE,
          this.now().toISOString(),
        );
      },
    );
  }
}
