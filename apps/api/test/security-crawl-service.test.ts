import type { DatabaseSync } from "node:sqlite";
import type { AlertSource, LockedPackage, LockfileSummary, Repo } from "@dora-dashboard/core";
import { isUsable } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { MAX_OSV_PACKAGES, SecurityCrawlService, scrub } from "../src/services/security-crawl-service.js";
import { SecurityReportService } from "../src/services/security-report-service.js";
import {
  FakeScorecardSource,
  FakeSecurityAlertSource,
  FakeVulnerabilityDatabase,
  codeScanningAlert,
  dependabotAlert,
  lockedPackage,
  osvAlert,
  repoPosture,
  scorecardResult,
  secretScanningAlert,
  supplyChainFacts,
  supplyChainRecord,
  vulnerability,
} from "./fakes.js";

const T0 = new Date("2026-09-29T10:00:00.000Z");
const HOUR = 3_600_000;

const rawDb = (store: SqliteRepoStore) => (store as unknown as { db: DatabaseSync }).db;

function recordingLog() {
  const lines: { level: string; context: Record<string, unknown>; message: string }[] = [];
  const at = (level: string) => (context: object, message: string) =>
    void lines.push({ level, context: context as Record<string, unknown>, message });
  const log: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
}

describe("the security crawl step", () => {
  let store: SqliteRepoStore;
  let source: FakeSecurityAlertSource;
  let osv: FakeVulnerabilityDatabase;
  let scorecard: FakeScorecardSource;
  let logged: ReturnType<typeof recordingLog>;
  let clock: Date;
  let repo: Repo;

  const build = (options: { osv?: boolean; scorecard?: boolean; scopes?: string[] } = {}): SecurityCrawlService =>
    new SecurityCrawlService(
      store,
      source,
      options.osv ? osv : null,
      options.scorecard ? scorecard : null,
      () => clock,
      logged.log,
      options.scopes ?? [],
    );
  const states = () => store.sourceStates(repo.id);
  const keys = (alertSource: AlertSource) =>
    store
      .securityAlerts(repo.id)
      .filter((a) => a.source === alertSource)
      .map((a) => a.key);

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    source = new FakeSecurityAlertSource();
    osv = new FakeVulnerabilityDatabase();
    scorecard = new FakeScorecardSource();
    logged = recordingLog();
    clock = T0;
    repo = store.addRepo("acme", "widgets", [], "release");
  });

  describe("the repository's posture", () => {
    it("is read first for the deploy branch with the crawl's token, and saved with its time", async () => {
      source.postureIs = repoPosture({ visibility: "public" });

      await build().read("tok", repo, false);

      expect(source.calls.map((c) => c.method)).toEqual(["posture", "dependabot", "code_scanning", "secret_scanning"]);
      expect(source.calls[0]).toMatchObject({ token: "tok", owner: "acme", name: "widgets", branch: "release" });
      expect(store.posture(repo.id)).toEqual({ value: repoPosture({ visibility: "public" }), readAt: T0.toISOString() });
    });

    it("keeps the old posture and logs when a read fails for any reason but a rejected credential", async () => {
      await build().read("tok", repo, false);
      source.postureFailWith = new UpstreamError("GitHub answered 500", 500);
      clock = new Date(T0.getTime() + HOUR);

      await build().read("tok", repo, false);

      expect(store.posture(repo.id)!.readAt).toBe(T0.toISOString());
      expect(logged.lines.find((l) => l.message.includes("posture"))).toMatchObject({ level: "warn" });
      expect(source.count("dependabot")).toBe(2);
    });

    it("stores a failed read beside the earlier posture, and a good read clears it", async () => {
      await build().read("tok", repo, false);
      source.postureFailWith = new UpstreamError("GitHub answered 500", 500);
      clock = new Date(T0.getTime() + HOUR);

      await build().read("tok", repo, false);

      expect(store.postureFailure(repo.id)).toEqual({
        message: "GitHub answered 500",
        attemptedAt: new Date(T0.getTime() + HOUR).toISOString(),
      });
      expect(store.posture(repo.id)!.readAt).toBe(T0.toISOString());

      source.postureFailWith = null;
      await build().read("tok", repo, false);
      expect(store.postureFailure(repo.id)).toBeNull();
    });

    it("stores a neutral message when the posture fails for a reason that is not an AppError", async () => {
      source.postureFailWith = new TypeError("fetch failed for https://api.github.com/x?access_token=ghp_secret");

      await build().read("tok", repo, false);

      expect(store.postureFailure(repo.id)!.message).toBe(
        "The repository's security settings could not be read. See the API log.",
      );
      expect(store.posture(repo.id)).toBeNull();
    });

    it("fails the crawl on a 401 before reading anything else, leaving every stored state as it was", async () => {
      await build().read("tok", repo, false);
      const before = states();
      source.postureFailWith = new UnauthorisedError("sign in again");

      await expect(build().read("tok", repo, false)).rejects.toBeInstanceOf(UnauthorisedError);

      expect(source.count("dependabot")).toBe(1);
      expect(states()).toEqual(before);
    });
  });

  describe("the alert sources", () => {
    it("saves what each source returned and records it as read", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      source.seed("code_scanning", [codeScanningAlert({ key: "2" })]);
      source.seed("secret_scanning", [secretScanningAlert({ key: "3" })]);

      await build().read("tok", repo, false);

      expect(store.securityAlerts(repo.id).map((a) => `${a.source}:${a.key}`)).toEqual([
        "code_scanning:2",
        "dependabot:1",
        "secret_scanning:3",
      ]);
      for (const name of ["dependabot", "code_scanning", "secret_scanning"] as const) {
        expect(states()[name]).toEqual({
          status: "ok",
          readAt: T0.toISOString(),
          attemptedAt: T0.toISOString(),
          truncated: false,
          skipped: 0,
        });
      }
    });

    it("prunes what a complete read no longer lists", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })]);
      await build().read("tok", repo, false);

      source.seed("dependabot", [dependabotAlert({ key: "2" })]);
      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["2"]);
    });

    it("does not prune on a truncated read, and says so", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })]);
      await build().read("tok", repo, false);

      source.seed("dependabot", [dependabotAlert({ key: "2" })], { truncated: true });
      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["1", "2"]);
      expect(states().dependabot).toMatchObject({ status: "ok", truncated: true });
    });

    it("does not prune on a read that skipped alerts it could not map, since one may be stored already", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })]);
      await build().read("tok", repo, false);

      source.seed("dependabot", [dependabotAlert({ key: "2" })], { skipped: 1 });
      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["1", "2"]);
      expect(states().dependabot).toMatchObject({ status: "ok", truncated: false, skipped: 1 });
    });

    it("prunes beside an alert that was numbered but could not be mapped, and keeps what is stored for that one", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" }), dependabotAlert({ key: "3" })]);
      await build().read("tok", repo, false);

      // Alert 1 now has a state this port does not know, so it is skipped, but it is still there. Alert 3 is gone.
      source.seed("dependabot", [dependabotAlert({ key: "2" })], { skippedKeys: ["1"] });
      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["1", "2"]);
      expect(states().dependabot).toMatchObject({ status: "ok", truncated: false, skipped: 1 });
    });

    it("does not prune when a skipped alert could not even be numbered, though another was", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" }), dependabotAlert({ key: "3" })]);
      await build().read("tok", repo, false);

      source.seed("dependabot", [dependabotAlert({ key: "2" })], { skipped: 2, skippedKeys: ["1"] });
      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["1", "2", "3"]);
    });

    it("does not carry an alert of another source over for a skipped number", async () => {
      source.seed("code_scanning", [codeScanningAlert({ key: "5" })]);
      await build().read("tok", repo, false);

      source.seed("dependabot", [dependabotAlert({ key: "5" })], { skippedKeys: ["5"] });
      source.seed("code_scanning", []);
      await build().read("tok", repo, false);

      expect(keys("code_scanning")).toEqual([]);
      expect(keys("dependabot")).toEqual(["5"]);
    });

    it("does not let a failure after a no access answer make the older alerts count again", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      await build().read("tok", repo, false);
      clock = new Date(T0.getTime() + HOUR);
      source.set("dependabot", { status: "no_access", reason: "forbidden" });
      await build().read("tok", repo, false);
      // The alerts stay stored but the state carries no read, so they are not used while access is lacking.
      expect(states().dependabot).toEqual({
        status: "no_access",
        reason: "forbidden",
        attemptedAt: new Date(T0.getTime() + HOUR).toISOString(),
      });
      expect(isUsable(states().dependabot)).toBe(false);

      clock = new Date(T0.getTime() + 2 * HOUR);
      source.fail("dependabot", new UpstreamError("GitHub answered 502", 502));
      await build().read("tok", repo, false);

      expect(states().dependabot).toMatchObject({ status: "error", lastGood: null });
      expect(isUsable(states().dependabot)).toBe(false);
      expect(keys("dependabot")).toEqual(["1"]);
    });

    it("keeps the last good read time through repeated failures after a good read", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      await build().read("tok", repo, false);
      source.fail("dependabot", new UpstreamError("GitHub answered 502", 502));
      for (const hours of [1, 2]) {
        clock = new Date(T0.getTime() + hours * HOUR);
        await build().read("tok", repo, false);
      }

      expect(states().dependabot).toMatchObject({
        status: "error",
        lastGood: { readAt: T0.toISOString(), truncated: false, skipped: 0 },
      });
      expect(isUsable(states().dependabot)).toBe(true);
    });

    it("logs how many alerts could not be mapped", async () => {
      source.seed("dependabot", [dependabotAlert()], { skipped: 3 });

      await build().read("tok", repo, false);

      expect(logged.lines.find((l) => l.context.skipped === 3)).toMatchObject({
        level: "warn",
        context: { source: "dependabot" },
      });
    });

    it("clears a source that GitHub says is switched off, and records why", async () => {
      source.seed("code_scanning", [codeScanningAlert()]);
      await build().read("tok", repo, false);
      expect(keys("code_scanning")).toHaveLength(1);

      source.set("code_scanning", { status: "off", reason: "needs_advanced_security" });
      await build().read("tok", repo, false);

      expect(keys("code_scanning")).toEqual([]);
      expect(states().code_scanning).toEqual({
        status: "off",
        reason: "needs_advanced_security",
        attemptedAt: T0.toISOString(),
      });
    });

    it("keeps what a more privileged crawl stored when this credential has no access, but does not use it", async () => {
      source.seed("code_scanning", [codeScanningAlert({ key: "7" })]);
      await build().read("tok", repo, false);
      clock = new Date(T0.getTime() + HOUR);

      source.set("code_scanning", { status: "no_access", reason: "forbidden" });
      await build().read("tok", repo, false);

      expect(keys("code_scanning")).toEqual(["7"]);
      expect(states().code_scanning).toEqual({
        status: "no_access",
        reason: "forbidden",
        attemptedAt: new Date(T0.getTime() + HOUR).toISOString(),
      });
      expect(isUsable(states().code_scanning)).toBe(false);
    });

    it("records a source that was never read, and answers no access, as no access", async () => {
      source.set("secret_scanning", { status: "no_access", reason: "admin_only_or_off" });

      await build().read("tok", repo, false);

      expect(states().secret_scanning).toEqual({
        status: "no_access",
        reason: "admin_only_or_off",
        attemptedAt: T0.toISOString(),
      });
    });

    it("keeps an earlier source's alerts and read time when it fails, while the others save", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      source.seed("code_scanning", [codeScanningAlert({ key: "2" })]);
      await build().read("tok", repo, false);
      clock = new Date(T0.getTime() + HOUR);
      source.fail("dependabot", new UpstreamError("GitHub answered 502", 502));
      source.seed("code_scanning", [codeScanningAlert({ key: "2" }), codeScanningAlert({ key: "4" })]);

      await build().read("tok", repo, false);

      expect(keys("dependabot")).toEqual(["1"]);
      expect(states().dependabot).toMatchObject({
        status: "error",
        error: "GitHub answered 502",
        lastGood: { readAt: T0.toISOString(), truncated: false, skipped: 0 },
        attemptedAt: new Date(T0.getTime() + HOUR).toISOString(),
      });
      expect(keys("code_scanning")).toEqual(["2", "4"]);
      expect(states().code_scanning.status).toBe("ok");
    });

    it("stores a neutral message for a failure that is not an AppError, and logs the detail", async () => {
      source.fail("secret_scanning", new TypeError("fetch failed at 10.0.0.1 with token ghp_secret"));

      await build().read("tok", repo, false);

      expect(states().secret_scanning).toMatchObject({
        status: "error",
        error: "Reading this source failed unexpectedly. See the API log.",
      });
      expect(JSON.stringify(store.sourceStates(repo.id))).not.toContain("ghp_secret");
      expect(logged.lines.find((l) => l.level === "error")).toMatchObject({ context: { source: "secret_scanning" } });
    });

    it("stores a rate limit message as it is, since the person can act on it", async () => {
      source.fail("dependabot", new RateLimitedError("GitHub's rate limit was reached. Try again later."));

      await build().read("tok", repo, false);

      expect(states().dependabot).toMatchObject({ error: "GitHub's rate limit was reached. Try again later." });
    });

    it("fails the crawl on a 401 from a source and leaves that source's state untouched", async () => {
      source.seed("code_scanning", [codeScanningAlert()]);
      await build().read("tok", repo, false);
      const before = states();
      source.fail("code_scanning", new UnauthorisedError("sign in again"));

      await expect(build().read("tok", repo, false)).rejects.toBeInstanceOf(UnauthorisedError);

      expect(states().code_scanning).toEqual(before.code_scanning);
      expect(keys("code_scanning")).toHaveLength(1);
      // Secret scanning was never reached the second time.
      expect(source.count("secret_scanning")).toBe(1);
    });

    it("does not let an error after an off answer make the cleared source usable", async () => {
      source.set("dependabot", { status: "off", reason: "disabled" });
      await build().read("tok", repo, false);
      source.fail("dependabot", new UpstreamError("down", 502));

      await build().read("tok", repo, false);

      expect(states().dependabot).toMatchObject({ status: "error", lastGood: null });
    });

    it("carries the last good read through a failure after an error that had one", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      await build().read("tok", repo, false);
      source.fail("dependabot", new UpstreamError("one", 502));
      await build().read("tok", repo, false);
      source.fail("dependabot", new UpstreamError("two", 502));
      await build().read("tok", repo, false);

      expect(states().dependabot).toMatchObject({ error: "two", lastGood: { readAt: T0.toISOString() } });
    });
  });

  describe("the OSV lookup", () => {
    const seedInventory = (
      packages = [lockedPackage()],
      lockfiles: LockfileSummary[] = [
        { path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false },
      ],
    ) => {
      store.saveSupplyChain(repo.id, supplyChainRecord({ facts: supplyChainFacts({ lockfiles }) }), packages);
    };
    const dependabotOff = () => source.set("dependabot", { status: "off", reason: "disabled" });
    /** Core's report after the crawl, which counts OSV only while it is usable and otherwise says nothing watches. */
    const reportNow = () => {
      rawDb(store).prepare("UPDATE repos SET last_crawled_at = ? WHERE id = ?").run(T0.toISOString(), repo.id);
      return new SecurityReportService(store, store, {
        codeAnalysis: true,
        scorecardLookup: false,
        settingsUrl: () => "",
        fileUrl: () => null,
      }).report(repo.id);
    };

    it("is never called, and says so, when the lookup is off", async () => {
      dependabotOff();
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

      await build({ osv: false }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(keys("osv")).toEqual([]);
      expect(states().osv).toEqual({ status: "not_used", reason: "lookup_off", attemptedAt: T0.toISOString() });
    });

    it("says not read, rather than lookup_off, when the lookup was switched on but nothing is known of the lockfiles", async () => {
      dependabotOff();
      await build({ osv: false }).read("tok", repo, false);
      expect(states().osv).toMatchObject({ status: "not_used", reason: "lookup_off" });

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(states().osv).toEqual({ status: "not_read" });
    });

    it("leaves an OSV state that holds a read as it is when the record cannot be read", async () => {
      dependabotOff();
      seedInventory();
      await build({ osv: true }).read("tok", repo, false);
      const before = states().osv;
      rawDb(store).exec("UPDATE supply_chain SET facts = '{}'");

      await build({ osv: true }).read("tok", repo, false);

      expect(states().osv).toEqual(before);
    });

    describe("a lockfile missing from the listing", () => {
      const facts = (listingComplete: boolean) =>
        supplyChainRecord({
          facts: supplyChainFacts({
            lockfiles: [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false }],
            listingComplete,
          }),
        });
      const withDeleted = (listingComplete: boolean) => {
        dependabotOff();
        store.saveSupplyChain(repo.id, facts(listingComplete), [lockedPackage()]);
        store.saveSecurityAlerts(
          repo.id,
          "osv",
          [osvAlert({ key: "GHSA-9|npm|lodash|old/package-lock.json", dependency: { manifestPath: "old/package-lock.json" } })],
          "replace",
        );
      };
      const stateOfOld = () => store.securityAlerts(repo.id).find((a) => a.key.startsWith("GHSA-9"))!.state;

      it("closes the alerts of a lockfile that is gone when the listing was complete", async () => {
        withDeleted(true);
        await build({ osv: true }).read("tok", repo, false);
        expect(stateOfOld()).toBe("fixed");
      });

      it("keeps them when the listing was cut, since the lockfile may simply not have been reached", async () => {
        withDeleted(false);
        await build({ osv: true }).read("tok", repo, false);
        expect(stateOfOld()).toBe("open");
      });
    });

    it("rewrites OSV's state from the earlier build, which read as not read, at the next crawl", async () => {
      rawDb(store)
        .prepare(
          "INSERT INTO security_sources (repo_id, source, status, reason, attempted_at) VALUES (?, 'osv', 'off', 'lookup_off', '2026-09-01T00:00:00.000Z')",
        )
        .run(repo.id);
      expect(states().osv).toEqual({ status: "not_read" });

      await build({ osv: false }).read("tok", repo, false);

      expect(states().osv).toEqual({ status: "not_used", reason: "lookup_off", attemptedAt: T0.toISOString() });
    });

    it("is never called when Dependabot is usable, and its alerts are cleared", async () => {
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(keys("osv")).toEqual([]);
      expect(states().osv).toMatchObject({ status: "not_used", reason: "dependabot_ok" });
    });

    it("clears the OSV alerts when Dependabot recovers", async () => {
      dependabotOff();
      seedInventory();
      osv.know(lockedPackage(), [vulnerability()]);
      await build({ osv: true }).read("tok", repo, false);
      expect(keys("osv")).toHaveLength(1);

      source.set("dependabot", { status: "ok", alerts: [], truncated: false, skipped: 0, skippedKeys: [] });
      await build({ osv: true }).read("tok", repo, false);

      expect(keys("osv")).toEqual([]);
      expect(osv.asked).toHaveLength(1);
    });

    it("says there is no inventory when the record lists no lockfile that could name a public package", async () => {
      dependabotOff();
      seedInventory(
        [],
        [
          { path: "pnpm-lock.yaml", read: "not_supported", packages: 0, publicPackages: 0, capped: false },
          { path: "go.sum", read: "parsed", packages: 3, publicPackages: 0, capped: false },
        ],
      );
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(keys("osv")).toEqual([]);
      expect(states().osv).toMatchObject({ status: "not_used", reason: "no_inventory" });
    });

    it("says there is no inventory when the record lists no lockfile at all", async () => {
      dependabotOff();
      seedInventory([], []);

      await build({ osv: true }).read("tok", repo, false);

      expect(states().osv).toMatchObject({ status: "not_used", reason: "no_inventory" });
    });

    describe("when no lockfile that could hold public packages was read", () => {
      const only = (read: LockfileSummary["read"]) => [
        { path: "package-lock.json", read, packages: 0, publicPackages: 0, capped: false },
      ];

      it.each(["unreadable", "malformed"] as const)(
        "records a failed read, and not an ok one, when the only lockfile is %s, and keeps its alert open",
        async (read) => {
          dependabotOff();
          seedInventory([], only(read));
          store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

          await build({ osv: true }).read("tok", repo, false);

          // Nothing was asked and nothing was found, which is not an all clear.
          expect(osv.asked).toEqual([]);
          expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
          expect(states().osv).toEqual({
            status: "error",
            error: "No lockfile could be read, so nothing was looked up",
            attemptedAt: T0.toISOString(),
            lastGood: null,
          });
          expect(isUsable(states().osv)).toBe(false);
        },
      );

      it("does not count as a source in use, so a repository with Dependabot switched off is still told nothing watches it", async () => {
        dependabotOff();
        store.saveSupplyChain(
          repo.id,
          supplyChainRecord({ facts: supplyChainFacts({ lockfiles: only("unreadable"), manifestsByEcosystem: { npm: 1 } }) }),
          [],
        );

        await build({ osv: true }).read("tok", repo, false);

        const sources = states();
        expect(sources.dependabot).toMatchObject({ status: "off", reason: "disabled" });
        expect(isUsable(sources.osv)).toBe(false);
        const report = reportNow();
        expect(report.used.osv).toBe(false);
        expect(report.checks.find((c) => c.check === "dependenciesUnwatched")?.value).toBe(true);
      });

      it("keeps the last good read, so alerts already in use stay in use, when a later crawl cannot read the lockfile", async () => {
        dependabotOff();
        seedInventory();
        osv.know(lockedPackage(), [vulnerability()]);
        await build({ osv: true }).read("tok", repo, false);
        seedInventory([], only("unreadable"));
        clock = new Date(T0.getTime() + HOUR);

        await build({ osv: true }).read("tok", repo, false);

        expect(keys("osv")).toHaveLength(1);
        expect(states().osv).toMatchObject({ status: "error", lastGood: { readAt: T0.toISOString() } });
        expect(isUsable(states().osv)).toBe(true);
      });

      it.each(["unreadable", "malformed"] as const)(
        "says only part was read when one lockfile is read and another is %s",
        async (read) => {
          dependabotOff();
          seedInventory(
            [lockedPackage()],
            [
              { path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false },
              { path: "web/package-lock.json", read, packages: 0, publicPackages: 0, capped: false },
            ],
          );

          await build({ osv: true }).read("tok", repo, false);

          expect(osv.asked).toHaveLength(1);
          expect(states().osv).toMatchObject({ status: "ok", truncated: true });
        },
      );

      it("says the lookup was complete when every lockfile that could hold packages was read in full", async () => {
        dependabotOff();
        seedInventory();

        await build({ osv: true }).read("tok", repo, false);

        expect(states().osv).toMatchObject({ status: "ok", truncated: false });
      });
    });

    describe("a listing of the clone that stopped short", () => {
      it("does not erase the stored alerts, or say there is no inventory, when the record lists no lockfile", async () => {
        dependabotOff();
        // The walk reached its limit before the lockfile, so the record names none although the repository has one.
        store.saveSupplyChain(
          repo.id,
          supplyChainRecord({ facts: supplyChainFacts({ lockfiles: [], listingComplete: false }) }),
          [],
        );
        store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

        await build({ osv: true }).read("tok", repo, false);

        expect(store.securityAlerts(repo.id)[0]).toMatchObject({
          state: "open",
          closedAt: null,
          createdAt: osvAlert().createdAt,
        });
        // No lockfile was seen at all, so the failure says the listing stopped short rather than that one was unreadable.
        expect(states().osv).toEqual({
          status: "error",
          error: "The listing of the clone stopped short before it found any lockfile, so nothing was looked up",
          attemptedAt: T0.toISOString(),
          lastGood: null,
        });
        expect(states().osv).not.toMatchObject({ reason: "no_inventory" });
      });

      it("keeps the last good read when it was an ok one", async () => {
        dependabotOff();
        seedInventory();
        await build({ osv: true }).read("tok", repo, false);
        store.saveSupplyChain(
          repo.id,
          supplyChainRecord({ facts: supplyChainFacts({ lockfiles: [], listingComplete: false }) }),
          [],
        );
        clock = new Date(T0.getTime() + HOUR);

        await build({ osv: true }).read("tok", repo, false);

        expect(states().osv).toMatchObject({ status: "error", lastGood: { readAt: T0.toISOString() } });
      });

      it("says only part was read when other lockfiles were read but the listing was cut", async () => {
        dependabotOff();
        store.saveSupplyChain(
          repo.id,
          supplyChainRecord({
            facts: supplyChainFacts({
              lockfiles: [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false }],
              listingComplete: false,
            }),
          }),
          [lockedPackage()],
        );

        await build({ osv: true }).read("tok", repo, false);

        expect(states().osv).toMatchObject({ status: "ok", truncated: true });
      });

      it("still says there is no inventory when the listing was complete and holds no lockfile", async () => {
        dependabotOff();
        seedInventory([], []);
        store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

        await build({ osv: true }).read("tok", repo, false);

        expect(keys("osv")).toEqual([]);
        expect(states().osv).toMatchObject({ status: "not_used", reason: "no_inventory" });
      });
    });

    describe("which state of Dependabot lets OSV stand in", () => {
      const ask = () => {
        seedInventory();
        osv.know(lockedPackage(), [vulnerability()]);
      };

      it("looks the packages up when Dependabot answers no access, which is the commonest reason for the fallback", async () => {
        source.set("dependabot", { status: "no_access", reason: "forbidden" });
        ask();

        await build({ osv: true }).read("tok", repo, false);

        expect(osv.asked).toHaveLength(1);
        expect(keys("osv")).toHaveLength(1);
        expect(states().osv).toMatchObject({ status: "ok" });
      });

      it("looks the packages up when Dependabot fails and no earlier read of it is in use", async () => {
        source.fail("dependabot", new UpstreamError("down", 502));
        ask();

        await build({ osv: true }).read("tok", repo, false);

        expect(osv.asked).toHaveLength(1);
        expect(states().osv).toMatchObject({ status: "ok" });
      });

      it("sends nothing, and says Dependabot's alerts are in use, when it fails after a good read", async () => {
        source.seed("dependabot", [dependabotAlert({ key: "1" })]);
        ask();
        await build({ osv: true }).read("tok", repo, false);
        expect(osv.asked).toEqual([]);
        source.fail("dependabot", new UpstreamError("down", 502));
        clock = new Date(T0.getTime() + HOUR);

        await build({ osv: true }).read("tok", repo, false);

        // The earlier read is still in use, so no package name leaves for a source that is not needed.
        expect(osv.asked).toEqual([]);
        expect(states().dependabot).toMatchObject({ status: "error", lastGood: { readAt: T0.toISOString() } });
        expect(states().osv).toMatchObject({ status: "not_used", reason: "dependabot_ok" });
      });
    });

    describe("an answer that does not line up with the packages asked about", () => {
      const withAlert = () => {
        dependabotOff();
        seedInventory();
        store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");
      };

      it.each([
        ["a short list", () => []],
        ["a long list", () => [[], []]],
      ])("fails the stage, and closes nothing, for %s", async (_case, reply) => {
        withAlert();
        osv.replyWith = reply;

        await build({ osv: true }).read("tok", repo, false);

        expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
        expect(states().osv).toMatchObject({ status: "error", error: expect.stringContaining("different number") });
      });

      it("treats an entry that is not a list as unanswered, so its alert stays open", async () => {
        withAlert();
        osv.replyWith = () => [undefined];

        await build({ osv: true }).read("tok", repo, false);

        expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
        expect(states().osv).toMatchObject({ status: "ok", truncated: true });
      });
    });

    describe("when the lookup could hold packages but sends none", () => {
      const NO_PUBLIC: LockfileSummary = {
        path: "package-lock.json",
        read: "parsed",
        packages: 4,
        publicPackages: 0,
        capped: false,
      };
      /** A record with npm manifests, so core raises the unwatched dependencies check when no source watches them. */
      const seed = (packages: LockedPackage[], lockfiles: LockfileSummary[], listingComplete = true) =>
        store.saveSupplyChain(
          repo.id,
          supplyChainRecord({ facts: supplyChainFacts({ lockfiles, listingComplete, manifestsByEcosystem: { npm: 2 } }) }),
          packages,
        );
      const twoAlerts = () =>
        store.saveSecurityAlerts(
          repo.id,
          "osv",
          [
            osvAlert(),
            osvAlert({ key: "GHSA-x|npm|lodash|web/package-lock.json", dependency: { manifestPath: "web/package-lock.json" } }),
          ],
          "replace",
        );
      const failedWith = (error: string) => ({ status: "error", error, attemptedAt: T0.toISOString(), lastGood: null });
      const expectUnwatched = () => {
        expect(isUsable(states().osv)).toBe(false);
        const report = reportNow();
        expect(report.used.osv).toBe(false);
        expect(report.checks.find((c) => c.check === "dependenciesUnwatched")?.value).toBe(true);
      };

      const UNREAD =
        "A lockfile could not be read, and those that were read hold no public package that can be sent, so nothing was looked up";
      const CUT =
        "The listing of the clone stopped short, and the lockfiles it found hold no public package that can be sent, so nothing was looked up";
      const NOT_KEPT = "Not every public package of the lockfiles that were read was kept, so nothing was looked up";

      it.each(["unreadable", "malformed"] as const)(
        "records a failed read, keeps every stored alert and leaves OSV unused when a lockfile with no public package sits beside one that is %s",
        async (read) => {
          dependabotOff();
          seed([], [NO_PUBLIC, { path: "web/package-lock.json", read, packages: 0, publicPackages: 0, capped: false }]);
          twoAlerts();

          await build({ osv: true }).read("tok", repo, false);

          // The lockfile that was read names no public package, but nothing was asked, so even its own alert stays open.
          expect(osv.asked).toEqual([]);
          expect(store.securityAlerts(repo.id).map((a) => [a.key, a.state, a.closedAt])).toEqual([
            ["GHSA-aaaa-bbbb-cccc|npm|lodash|package-lock.json", "open", null],
            ["GHSA-x|npm|lodash|web/package-lock.json", "open", null],
          ]);
          expect(states().osv).toEqual(failedWith(UNREAD));
          expectUnwatched();
        },
      );

      it("records a failed read when the listing stopped short and the lockfiles it reached name no public package", async () => {
        dependabotOff();
        seed(
          [],
          [NO_PUBLIC, { path: "pnpm-lock.yaml", read: "not_supported", packages: 0, publicPackages: 0, capped: false }],
          false,
        );
        twoAlerts();

        await build({ osv: true }).read("tok", repo, false);

        expect(osv.asked).toEqual([]);
        expect(store.securityAlerts(repo.id).map((a) => a.state)).toEqual(["open", "open"]);
        expect(states().osv).toEqual(failedWith(CUT));
        expectUnwatched();
      });

      it("records a failed read when the record's lockfiles name public packages that are not stored with it", async () => {
        dependabotOff();
        seed([], [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false }]);
        twoAlerts();

        await build({ osv: true }).read("tok", repo, false);

        expect(osv.asked).toEqual([]);
        expect(store.securityAlerts(repo.id).map((a) => a.state)).toEqual(["open", "open"]);
        expect(states().osv).toEqual(failedWith(NOT_KEPT));
        expectUnwatched();
      });

      describe("because every public package is withheld by a private scope", () => {
        const PRIVATE_ONLY: LockfileSummary = {
          path: "package-lock.json",
          read: "parsed",
          packages: 2,
          publicPackages: 2,
          capped: false,
        };
        const privatePackages = () => [
          lockedPackage({ name: "@acme/ui" }),
          lockedPackage({ name: "@corp/internal", version: "2.0.0" }),
        ];

        it("makes no request, says OSV is not used, and no longer keeps open the finding of a package that left the lockfile", async () => {
          dependabotOff();
          // A lockfile of a kind that is not read cannot hold a package to send, as for `no_inventory`, so it does not count
          // as something left unread.
          seed(privatePackages(), [
            PRIVATE_ONLY,
            { path: "pnpm-lock.yaml", read: "not_supported", packages: 0, publicPackages: 0, capped: false },
          ]);
          store.saveSecurityAlerts(
            repo.id,
            "osv",
            [
              osvAlert({ dependency: { name: "lodash" } }),
              osvAlert({ dependency: { name: "@acme/ui" }, key: "GHSA-x|npm|@acme/ui|package-lock.json" }),
            ],
            "replace",
          );

          await build({ osv: true, scopes: ["@corp"] }).read("tok", repo, false);

          // The lockfile was read in full from a complete listing and holds nothing that may be sent, which is a reason not
          // to use OSV rather than a failure. As with every such reason the stored alerts are cleared, so the finding of
          // lodash, which has left the lockfile, no longer stays open, and nor does the withheld package's.
          expect(osv.asked).toEqual([]);
          expect(keys("osv")).toEqual([]);
          expect(states().osv).toEqual({ status: "not_used", reason: "all_withheld", attemptedAt: T0.toISOString() });
          expectUnwatched();
        });

        it("drops an earlier good read, so it no longer stands in for Dependabot, once every package left is private", async () => {
          dependabotOff();
          seed([lockedPackage()], [{ ...PRIVATE_ONLY, packages: 1, publicPackages: 1 }]);
          osv.know(lockedPackage(), [vulnerability()]);
          await build({ osv: true }).read("tok", repo, false);
          expect(keys("osv")).toHaveLength(1);
          expect(isUsable(states().osv)).toBe(true);
          seed(privatePackages(), [PRIVATE_ONLY]);
          clock = new Date(T0.getTime() + HOUR);

          await build({ osv: true, scopes: ["@corp"] }).read("tok", repo, false);

          expect(osv.asked).toHaveLength(1);
          expect(keys("osv")).toEqual([]);
          expect(states().osv).toMatchObject({ status: "not_used", reason: "all_withheld" });
          expectUnwatched();
        });

        it.each<[string, LockfileSummary[], boolean, string]>([
          [
            "another lockfile could not be read",
            [PRIVATE_ONLY, { path: "web/package-lock.json", read: "unreadable", packages: 0, publicPackages: 0, capped: false }],
            true,
            UNREAD,
          ],
          ["the listing of the clone stopped short", [PRIVATE_ONLY], false, CUT],
          ["the lockfile held more public packages than were kept", [{ ...PRIVATE_ONLY, capped: true }], true, NOT_KEPT],
          ["the record counts more public packages than are stored", [{ ...PRIVATE_ONLY, publicPackages: 3 }], true, NOT_KEPT],
        ])(
          "records a failed read instead, keeps every stored alert and leaves OSV unused, when %s",
          async (_case, lockfiles, listingComplete, error) => {
            dependabotOff();
            seed(privatePackages(), lockfiles, listingComplete);
            twoAlerts();

            await build({ osv: true, scopes: ["@corp"] }).read("tok", repo, false);

            // Something that could hold a public package was not read, so the private scopes alone cannot explain why
            // nothing was sent.
            expect(osv.asked).toEqual([]);
            expect(store.securityAlerts(repo.id).map((a) => a.state)).toEqual(["open", "open"]);
            expect(states().osv).toEqual(failedWith(error));
            expectUnwatched();
          },
        );
      });
    });

    it("leaves what was stored alone when nothing is known about the lockfiles, rather than saying there are none", async () => {
      dependabotOff();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open" });
      expect(states().osv.status).toBe("not_read");
    });

    it("saves the findings as open OSV alerts, created now, when it is the dependency source", async () => {
      dependabotOff();
      seedInventory();
      osv.know(lockedPackage(), [vulnerability()]);

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([[lockedPackage()]]);
      expect(store.securityAlerts(repo.id)).toEqual([
        expect.objectContaining({
          source: "osv",
          state: "open",
          key: "GHSA-aaaa-bbbb-cccc|npm|lodash|package-lock.json",
          createdAt: T0.toISOString(),
        }),
      ]);
      expect(states().osv).toEqual({
        status: "ok",
        readAt: T0.toISOString(),
        attemptedAt: T0.toISOString(),
        truncated: false,
        skipped: 0,
      });
    });

    it("sends only public packages, minus the owner's scope and every configured scope, in any case", async () => {
      dependabotOff();
      seedInventory([
        lockedPackage({ name: "lodash" }),
        lockedPackage({ name: "@Acme/ui", version: "1.0.0" }),
        lockedPackage({ name: "@corp/internal", version: "2.0.0" }),
        lockedPackage({ name: "@other/internal", version: "2.0.0" }),
        lockedPackage({ name: "@types/node", version: "20.0.0" }),
        lockedPackage({ ecosystem: "PyPI", name: "@acme/not-npm", version: "1.0.0" }),
      ]);

      await build({ osv: true, scopes: ["@CORP", "other"] }).read("tok", repo, false);

      expect(osv.asked[0]!.map((p) => `${p.ecosystem}:${p.name}`)).toEqual([
        "npm:lodash",
        "npm:@types/node",
        "PyPI:@acme/not-npm",
      ]);
    });

    it("leaves the alerts of a package the operator has since withheld as they were, and still reads the others", async () => {
      dependabotOff();
      seedInventory([
        lockedPackage({ name: "@corp/internal", version: "2.0.0" }),
        lockedPackage({ name: "left-pad", version: "1.0.0" }),
      ]);
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [osvAlert({ dependency: { name: "@corp/internal" }, key: "GHSA-y|npm|@corp/internal|package-lock.json" })],
        "replace",
      );
      osv.know(lockedPackage({ name: "left-pad", version: "1.0.0" }), [vulnerability({ id: "GHSA-z" })]);

      await build({ osv: true, scopes: ["@corp"] }).read("tok", repo, false);

      expect(osv.asked[0]!.map((p) => p.name)).toEqual(["left-pad"]);
      expect(keys("osv").sort()).toEqual([
        "GHSA-y|npm|@corp/internal|package-lock.json",
        "GHSA-z|npm|left-pad|package-lock.json",
      ]);
      expect(store.securityAlerts(repo.id).find((a) => a.key.startsWith("GHSA-y"))).toMatchObject({
        state: "open",
        closedAt: null,
      });
    });

    it("keeps an alert's first sighting, and closes it when its lockfile was read and the finding has gone", async () => {
      dependabotOff();
      seedInventory();
      osv.know(lockedPackage(), [vulnerability()]);
      await build({ osv: true }).read("tok", repo, false);
      clock = new Date(T0.getTime() + HOUR);
      await build({ osv: true }).read("tok", repo, false);
      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", createdAt: T0.toISOString() });

      osv.know(lockedPackage(), []);
      clock = new Date(T0.getTime() + 2 * HOUR);
      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({
        state: "fixed",
        closeReason: "not_found",
        closedAt: new Date(T0.getTime() + 2 * HOUR).toISOString(),
        createdAt: T0.toISOString(),
      });
    });

    it("closes nothing for a lockfile that was not read this time", async () => {
      dependabotOff();
      seedInventory(
        [lockedPackage({ lockfile: "web/package-lock.json" })],
        [{ path: "web/package-lock.json", read: "unreadable", packages: 0, publicPackages: 0, capped: false }],
      );
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [
          osvAlert({
            dependency: { manifestPath: "web/package-lock.json" },
            key: "GHSA-aaaa-bbbb-cccc|npm|lodash|web/package-lock.json",
          }),
        ],
        "replace",
      );

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
    });

    it("closes nothing in a lockfile that has a package the lookup could not answer in full, and says it was truncated", async () => {
      dependabotOff();
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");
      osv.leaveIncomplete(lockedPackage());

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open" });
      expect(states().osv).toMatchObject({ status: "ok", truncated: true });
    });

    it("still closes the alerts of a lockfile whose packages were all answered, beside one with an incomplete package", async () => {
      dependabotOff();
      seedInventory(
        [
          lockedPackage({ lockfile: "a/package-lock.json" }),
          lockedPackage({ name: "left-pad", version: "1.0.0", lockfile: "b/package-lock.json" }),
        ],
        [
          { path: "a/package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false },
          { path: "b/package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false },
        ],
      );
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [
          osvAlert({ key: "GHSA-1|npm|lodash|a/package-lock.json", dependency: { manifestPath: "a/package-lock.json" } }),
          osvAlert({
            key: "GHSA-2|npm|left-pad|b/package-lock.json",
            dependency: { name: "left-pad", manifestPath: "b/package-lock.json" },
          }),
        ],
        "replace",
      );
      osv.leaveIncomplete(lockedPackage({ name: "left-pad", version: "1.0.0" }));

      await build({ osv: true }).read("tok", repo, false);

      const byKey = Object.fromEntries(store.securityAlerts(repo.id).map((a) => [a.key, a.state]));
      // Package a was answered with nothing found, so its alert closes; b's answer was incomplete, so its alert stays.
      expect(byKey).toEqual({
        "GHSA-1|npm|lodash|a/package-lock.json": "fixed",
        "GHSA-2|npm|left-pad|b/package-lock.json": "open",
      });
    });

    it("carries no last good read into an error after the lookup was recorded as not used", async () => {
      dependabotOff();
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");
      await build({ osv: false }).read("tok", repo, false);
      expect(states().osv).toMatchObject({ status: "not_used", reason: "lookup_off" });
      // Switching the lookup on clears nothing here, but a failure of the first lookup has no earlier read to fall back on.
      seedInventory();
      osv.failWith = new UpstreamError("OSV answered 503", 503);

      await build({ osv: true }).read("tok", repo, false);

      expect(states().osv).toMatchObject({ status: "error", lastGood: null });
      expect(isUsable(states().osv)).toBe(false);
    });

    it("keeps the earlier alerts and read time when the database fails", async () => {
      dependabotOff();
      seedInventory();
      osv.know(lockedPackage(), [vulnerability()]);
      await build({ osv: true }).read("tok", repo, false);
      osv.failWith = new UpstreamError("OSV answered 503", 503);
      clock = new Date(T0.getTime() + HOUR);

      await build({ osv: true }).read("tok", repo, false);

      expect(keys("osv")).toHaveLength(1);
      expect(states().osv).toMatchObject({
        status: "error",
        error: "OSV answered 503",
        lastGood: { readAt: T0.toISOString() },
      });
    });

    it("closes the alerts of a lockfile that is no longer in the latest supply chain record", async () => {
      dependabotOff();
      seedInventory([lockedPackage({ lockfile: "package-lock.json" })]);
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [
          osvAlert({
            dependency: { manifestPath: "old/package-lock.json" },
            key: "GHSA-aaaa-bbbb-cccc|npm|lodash|old/package-lock.json",
          }),
        ],
        "replace",
      );

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "fixed", closeReason: "not_found" });
    });

    it("sends at most 20,000 distinct packages and keeps every entry of those", async () => {
      dependabotOff();
      const many = Array.from({ length: MAX_OSV_PACKAGES + 5 }, (_, i) => lockedPackage({ name: `pkg-${i}`, version: "1.0.0" }));
      // The same package named by a second lockfile is not a new distinct package.
      many.push(lockedPackage({ name: "pkg-0", version: "1.0.0", lockfile: "web/package-lock.json" }));
      seedInventory(many);

      await build({ osv: true }).read("tok", repo, false);

      const sent = osv.asked[0]!;
      expect(new Set(sent.map((p) => `${p.name}@${p.version}`)).size).toBe(MAX_OSV_PACKAGES);
      expect(sent).toHaveLength(MAX_OSV_PACKAGES + 1);
      expect(states().osv).toMatchObject({ status: "ok", truncated: true });
    });

    it("leaves the alert of a package past the limit open, and closes one the lockfile no longer names", async () => {
      dependabotOff();
      const many = Array.from({ length: MAX_OSV_PACKAGES }, (_, i) => lockedPackage({ name: `pkg-${i}`, version: "1.0.0" }));
      many.push(lockedPackage({ name: "past-the-limit", version: "1.0.0" }));
      seedInventory(many);
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [
          osvAlert({ key: "GHSA-1|npm|past-the-limit|package-lock.json", dependency: { name: "past-the-limit" } }),
          osvAlert({ key: "GHSA-2|npm|pkg-7|package-lock.json", dependency: { name: "pkg-7" } }),
          osvAlert({ key: "GHSA-3|npm|removed|package-lock.json", dependency: { name: "removed" } }),
        ],
        "replace",
      );

      await build({ osv: true }).read("tok", repo, false);

      const byKey = Object.fromEntries(store.securityAlerts(repo.id).map((a) => [a.key.split("|")[0], a.state]));
      // The package past the limit was not looked up. pkg-7 was, and nothing was found. "removed" is not in the lockfile.
      expect(byKey).toEqual({ "GHSA-1": "open", "GHSA-2": "fixed", "GHSA-3": "fixed" });
    });

    it("leaves every alert of a lockfile that was capped open, and says the lookup was cut short", async () => {
      dependabotOff();
      seedInventory(
        [lockedPackage({ name: "left-pad", version: "1.0.0" })],
        [{ path: "package-lock.json", read: "parsed", packages: 30000, publicPackages: 30000, capped: true }],
      );
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], "replace");

      await build({ osv: true }).read("tok", repo, false);

      // The lockfile held more public packages than were kept, so a package that is not among them may still be there.
      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
      expect(states().osv).toMatchObject({ status: "ok", truncated: true });
    });

    it("closes the alert of a package a complete lockfile no longer names, and keeps one whose answer was cut short", async () => {
      dependabotOff();
      seedInventory([lockedPackage({ name: "left-pad", version: "1.0.0" }), lockedPackage({ name: "is-odd", version: "3.0.1" })]);
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [
          osvAlert({ key: "GHSA-1|npm|left-pad|package-lock.json", dependency: { name: "left-pad" } }),
          osvAlert({ key: "GHSA-2|npm|is-odd|package-lock.json", dependency: { name: "is-odd" } }),
          osvAlert({ key: "GHSA-3|npm|gone|package-lock.json", dependency: { name: "gone" } }),
        ],
        "replace",
      );
      osv.leaveIncomplete({ ecosystem: "npm", name: "is-odd", version: "3.0.1" });

      await build({ osv: true }).read("tok", repo, false);

      const byKey = Object.fromEntries(store.securityAlerts(repo.id).map((a) => [a.key.split("|")[0], a.state]));
      // left-pad was answered with nothing found; is-odd was cut short; gone is no longer in the lockfile.
      expect(byKey).toEqual({ "GHSA-1": "fixed", "GHSA-2": "open", "GHSA-3": "fixed" });
    });

    it("never receives the token or the repository", async () => {
      dependabotOff();
      seedInventory();

      await build({ osv: true }).read("tok", repo, false);

      expect(JSON.stringify(osv.asked)).not.toMatch(/tok|acme|widgets/);
    });
  });

  describe("the Scorecard", () => {
    const publicRepo = () => (source.postureIs = repoPosture({ visibility: "public" }));

    it("is not asked unless one is wired", async () => {
      publicRepo();
      await build().read("tok", repo, false);
      expect(scorecard.asked).toEqual([]);
      expect(store.scorecard(repo.id)).toBeNull();
    });

    it.each(["private", "internal", null] as const)("is never asked about a %s repository", async (visibility) => {
      source.postureIs = repoPosture({ visibility });
      await build({ scorecard: true }).read("tok", repo, true);
      expect(scorecard.asked).toEqual([]);
    });

    it("is not asked when the posture could not be read at all", async () => {
      source.postureFailWith = new UpstreamError("down", 502);
      await build({ scorecard: true }).read("tok", repo, true);
      expect(scorecard.asked).toEqual([]);
    });

    it("is not asked when this crawl's posture read failed, even though a public posture is stored", async () => {
      publicRepo();
      await build({ scorecard: true }).read("tok", repo, true);
      expect(scorecard.asked).toHaveLength(1);
      source.postureFailWith = new UpstreamError("down", 502);

      await build({ scorecard: true }).read("tok", repo, true);

      expect(store.posture(repo.id)!.value.visibility).toBe("public");
      expect(scorecard.asked).toHaveLength(1);
    });

    it("reads a public repository's score, after its posture, and stores it", async () => {
      publicRepo();
      scorecard.set("acme/widgets", scorecardResult({ score: 8.1 }));

      await build({ scorecard: true }).read("tok", repo, false);

      expect(scorecard.asked).toEqual(["acme/widgets"]);
      expect(store.scorecard(repo.id)).toEqual({
        readAt: T0.toISOString(),
        result: scorecardResult({ score: 8.1 }),
        failure: null,
      });
    });

    it("is asked at most once a day, unless the crawl is full", async () => {
      publicRepo();
      const step = build({ scorecard: true });
      await step.read("tok", repo, false);
      clock = new Date(T0.getTime() + 23 * HOUR);
      await step.read("tok", repo, false);
      expect(scorecard.asked).toHaveLength(1);

      await step.read("tok", repo, true);
      expect(scorecard.asked).toHaveLength(2);

      clock = new Date(T0.getTime() + 47 * HOUR + 1);
      await step.read("tok", repo, false);
      expect(scorecard.asked).toHaveLength(3);
    });

    it("asks again at exactly 24 hours, and not a millisecond before", async () => {
      publicRepo();
      const step = build({ scorecard: true });
      await step.read("tok", repo, false);

      clock = new Date(T0.getTime() + 24 * HOUR - 1);
      await step.read("tok", repo, false);
      expect(scorecard.asked).toHaveLength(1);

      clock = new Date(T0.getTime() + 24 * HOUR);
      await step.read("tok", repo, false);
      expect(scorecard.asked).toHaveLength(2);
    });

    it("stores a 404 as not scanned and does not ask again within the day", async () => {
      publicRepo();
      scorecard.set("acme/widgets", null);
      const step = build({ scorecard: true });

      await step.read("tok", repo, false);
      await step.read("tok", repo, false);

      expect(store.scorecard(repo.id)).toEqual({ readAt: T0.toISOString(), result: null, failure: null });
      expect(scorecard.asked).toHaveLength(1);
    });

    it("logs a failure, stores it beside the last good score, and clears it on the next good read", async () => {
      publicRepo();
      scorecard.set("acme/widgets", scorecardResult());
      await build({ scorecard: true }).read("tok", repo, false);
      scorecard.set("acme/widgets", new UpstreamError("Scorecard answered 500", 500));

      await build({ scorecard: true }).read("tok", repo, true);

      // The failure's own message is stored, with the time of the attempt, beside the last good result.
      expect(store.scorecard(repo.id)).toMatchObject({
        readAt: T0.toISOString(),
        result: scorecardResult(),
        failure: { message: "Scorecard answered 500", attemptedAt: T0.toISOString() },
      });
      expect(logged.lines.find((l) => l.message.includes("Scorecard"))).toMatchObject({ level: "warn" });

      scorecard.set("acme/widgets", scorecardResult({ score: 9 }));
      await build({ scorecard: true }).read("tok", repo, true);
      expect(store.scorecard(repo.id)).toMatchObject({ failure: null, result: { score: 9 } });
    });

    it("stores the scrubbed message of a failure that names an address, and a neutral one for any other failure", async () => {
      publicRepo();
      scorecard.set(
        "acme/widgets",
        new UpstreamError("Scorecard answered 500 for https://api.securityscorecards.dev/x?token=abc", 500),
      );
      await build({ scorecard: true }).read("tok", repo, true);
      expect(store.scorecard(repo.id)!.failure!.message).toBe("Scorecard answered 500 for https://api.securityscorecards.dev/x");

      scorecard.set("acme/widgets", new TypeError("x is not a function"));
      clock = new Date(T0.getTime() + HOUR);
      await build({ scorecard: true }).read("tok", repo, true);
      expect(store.scorecard(repo.id)!.failure).toEqual({
        message: "The OpenSSF Scorecard could not be read. See the API log.",
        attemptedAt: clock.toISOString(),
      });
    });

    it("asks again on the next crawl after a failure, since no read time was stored", async () => {
      publicRepo();
      scorecard.set("acme/widgets", new UpstreamError("down", 502));
      const step = build({ scorecard: true });

      await step.read("tok", repo, false);
      await step.read("tok", repo, false);

      expect(scorecard.asked).toHaveLength(2);
    });
  });

  describe("a failure that is not the source's own", () => {
    const NEUTRAL = "Reading this source failed unexpectedly. See the API log.";
    const publicRepo = () => (source.postureIs = repoPosture({ visibility: "public" }));

    it("records a corrupt package list against OSV, and still asks for the Scorecard", async () => {
      publicRepo();
      source.set("dependabot", { status: "off", reason: "disabled" });
      store.saveSupplyChain(
        repo.id,
        supplyChainRecord({
          facts: supplyChainFacts({
            lockfiles: [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false }],
          }),
        }),
        [lockedPackage()],
      );
      rawDb(store).exec("UPDATE supply_chain SET packages = '{broken'");
      scorecard.set("acme/widgets", scorecardResult({ score: 6 }));

      await build({ osv: true, scorecard: true }).read("tok", repo, false);

      expect(states().osv).toMatchObject({ status: "error", error: NEUTRAL });
      expect(osv.asked).toEqual([]);
      expect(scorecard.asked).toEqual(["acme/widgets"]);
      expect(store.scorecard(repo.id)).toMatchObject({ result: { score: 6 } });
      expect(logged.lines.find((l) => l.level === "error" && l.context.source === "osv")).toBeDefined();
    });

    it("records a store failure in one source against it, and goes on to the next sources", async () => {
      // An alert filed under another source cannot be saved as this one; the store refuses it.
      source.seed("dependabot", [osvAlert({ key: "9" }) as never]);
      source.seed("code_scanning", [codeScanningAlert({ key: "2" })]);

      await build().read("tok", repo, false);

      expect(states().dependabot).toMatchObject({ status: "error", error: NEUTRAL });
      expect(logged.lines.find((l) => l.level === "error" && l.context.source === "dependabot")).toBeDefined();
      expect(keys("code_scanning")).toEqual(["2"]);
      expect(states().code_scanning.status).toBe("ok");
      expect(source.count("secret_scanning")).toBe(1);
    });

    it("leaves a stored alert as it was when its own write fails, because the save is one transaction", async () => {
      source.seed("dependabot", [dependabotAlert({ key: "1" })]);
      await build().read("tok", repo, false);
      source.seed("dependabot", [dependabotAlert({ key: "1", title: "changed" }), osvAlert({ key: "9" }) as never]);

      await build().read("tok", repo, false);

      expect(store.securityAlerts(repo.id)).toEqual([dependabotAlert({ key: "1" })]);
    });

    it("does not let a failure to record a failure escape, and logs it at error level", async () => {
      source.fail("dependabot", new UpstreamError("GitHub answered 502", 502));
      vi.spyOn(store, "setSourceState").mockImplementation(() => {
        throw new Error("database is locked");
      });
      vi.spyOn(store, "failPosture").mockImplementation(() => {
        throw new Error("database is locked");
      });
      source.postureFailWith = new UpstreamError("down", 502);

      await expect(build().read("tok", repo, false)).resolves.toBeUndefined();

      const recorded = logged.lines.filter((l) => l.message.startsWith("could not record that the"));
      expect(recorded.every((l) => l.level === "error")).toBe(true);
      expect(recorded.map((l) => l.message)).toContain("could not record that the posture read failed");
      expect(recorded.map((l) => l.message)).toContain("could not record that the Dependabot read failed");
      // Every source was still asked.
      expect(source.count("secret_scanning")).toBe(1);
    });

    it("records a Scorecard store failure as a failed read and does not throw", async () => {
      publicRepo();
      vi.spyOn(store, "scorecard").mockImplementation(() => {
        throw new Error("database is locked");
      });
      const failure = vi.spyOn(store, "failScorecard");

      await build({ scorecard: true }).read("tok", repo, false);

      expect(failure).toHaveBeenCalledWith(
        repo.id,
        "The OpenSSF Scorecard could not be read. See the API log.",
        T0.toISOString(),
      );
      expect(logged.lines.find((l) => l.message.includes("Scorecard"))).toMatchObject({ level: "error" });
    });

    it("lets a rejected credential through whichever stage it comes from", async () => {
      source.seed("dependabot", [dependabotAlert()]);
      vi.spyOn(store, "setSourceState").mockImplementation(() => {
        throw new UnauthorisedError("sign in again");
      });
      source.set("dependabot", { status: "no_access", reason: "forbidden" });

      await expect(build().read("tok", repo, false)).rejects.toBeInstanceOf(UnauthorisedError);
    });
  });

  describe("how a failure is logged", () => {
    it("logs a posture failure that is an AppError as a warning and any other as an error", async () => {
      source.postureFailWith = new UpstreamError("GitHub answered 500", 500);
      await build().read("tok", repo, false);
      const warned = logged.lines.find((l) => l.message.includes("posture"));
      expect(warned).toMatchObject({ level: "warn" });

      logged.lines.length = 0;
      source.postureFailWith = new TypeError("x is not a function");
      await build().read("tok", repo, false);
      expect(logged.lines.find((l) => l.message.includes("posture"))).toMatchObject({ level: "error" });
    });

    it("logs a posture the store could not save as an error", async () => {
      vi.spyOn(store, "savePosture").mockImplementation(() => {
        throw new Error("disk full");
      });

      await build().read("tok", repo, false);

      expect(logged.lines.find((l) => l.message.includes("posture"))).toMatchObject({ level: "error" });
      expect(store.postureFailure(repo.id)!.message).toBe(
        "The repository's security settings could not be read. See the API log.",
      );
    });
  });

  describe("what a stored failure message may carry", () => {
    it("never carries the token, or a query string from the address that failed", async () => {
      source.fail(
        "dependabot",
        new UpstreamError(
          "GitHub answered 500 for https://api.github.com/repos/acme/widgets/alerts?per_page=100&access_token=tok",
          500,
        ),
      );
      source.postureFailWith = new UpstreamError(
        "Bearer tok was refused at https://api.github.com/repos/acme/widgets?x=1#frag",
        502,
      );

      await build().read("tok", repo, false);

      const stored = JSON.stringify([states(), store.postureFailure(repo.id)]);
      expect(stored).not.toContain('tok"');
      expect(stored).not.toContain("access_token");
      expect(stored).not.toContain("per_page");
      expect(stored).not.toContain("frag");
      expect(states().dependabot).toMatchObject({
        error: "GitHub answered 500 for https://api.github.com/repos/acme/widgets/alerts",
      });
      expect(store.postureFailure(repo.id)!.message).toBe(
        "Bearer [token] was refused at https://api.github.com/repos/acme/widgets",
      );
    });

    it("leaves a message with neither alone, and ignores an empty token", () => {
      expect(scrub("GitHub's rate limit was reached", "")).toBe("GitHub's rate limit was reached");
    });
  });
});
