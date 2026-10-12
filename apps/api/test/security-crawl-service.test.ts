import type { AlertSource, LockfileSummary, Repo } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it } from "vitest";
import { RateLimitedError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { MAX_OSV_PACKAGES, SecurityCrawlService, scrub } from "../src/services/security-crawl-service.js";
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
      expect(store.posture(repo.id)).toEqual({ posture: repoPosture({ visibility: "public" }), readAt: T0.toISOString() });
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
        error: "GitHub answered 500",
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

      expect(store.postureFailure(repo.id)!.error).toBe("The repository's security settings could not be read. See the API log.");
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
          reason: null,
          readAt: T0.toISOString(),
          attemptedAt: T0.toISOString(),
          truncated: false,
          error: null,
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
      expect(states().dependabot).toMatchObject({ status: "ok", truncated: false });
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
        readAt: null,
        attemptedAt: T0.toISOString(),
        truncated: false,
        error: null,
      });
    });

    it("keeps what a more privileged crawl stored when this credential has no access, and its read time", async () => {
      source.seed("code_scanning", [codeScanningAlert({ key: "7" })]);
      await build().read("tok", repo, false);
      clock = new Date(T0.getTime() + HOUR);

      source.set("code_scanning", { status: "no_access", reason: "forbidden" });
      await build().read("tok", repo, false);

      expect(keys("code_scanning")).toEqual(["7"]);
      expect(states().code_scanning).toEqual({
        status: "no_access",
        reason: "forbidden",
        readAt: T0.toISOString(),
        attemptedAt: new Date(T0.getTime() + HOUR).toISOString(),
        truncated: false,
        error: null,
      });
    });

    it("records no read time for a source that was never read when it answers no access", async () => {
      source.set("secret_scanning", { status: "no_access", reason: "admin_only_or_off" });

      await build().read("tok", repo, false);

      expect(states().secret_scanning).toMatchObject({ status: "no_access", readAt: null });
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
        readAt: T0.toISOString(),
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

      expect(states().dependabot.error).toBe("GitHub's rate limit was reached. Try again later.");
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

      expect(states().dependabot).toMatchObject({ status: "error", readAt: null });
    });
  });

  describe("the OSV lookup", () => {
    const seedInventory = (
      packages = [lockedPackage()],
      lockfiles: LockfileSummary[] = [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1 }],
    ) => {
      store.saveSupplyChain(repo.id, supplyChainRecord({ facts: supplyChainFacts({ lockfiles }) }), packages);
    };
    const dependabotOff = () => source.set("dependabot", { status: "off", reason: "disabled" });

    it("is never called, and says so, when the lookup is off", async () => {
      dependabotOff();
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], true);

      await build({ osv: false }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(keys("osv")).toEqual([]);
      expect(states().osv).toMatchObject({ status: "off", reason: "lookup_off", readAt: null });
    });

    it("is never called when Dependabot is usable, and its alerts are cleared", async () => {
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], true);

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(keys("osv")).toEqual([]);
      expect(states().osv).toMatchObject({ status: "off", reason: "dependabot_ok" });
    });

    it("clears the OSV alerts when Dependabot recovers", async () => {
      dependabotOff();
      seedInventory();
      osv.know(lockedPackage(), [vulnerability()]);
      await build({ osv: true }).read("tok", repo, false);
      expect(keys("osv")).toHaveLength(1);

      source.set("dependabot", { status: "ok", alerts: [], truncated: false, skipped: 0 });
      await build({ osv: true }).read("tok", repo, false);

      expect(keys("osv")).toEqual([]);
      expect(osv.asked).toHaveLength(1);
    });

    it("says there is no inventory when no packages are stored", async () => {
      dependabotOff();

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(states().osv).toMatchObject({ status: "off", reason: "no_inventory" });
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
        reason: null,
        readAt: T0.toISOString(),
        attemptedAt: T0.toISOString(),
        truncated: false,
        error: null,
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

    it("makes no request when every package is private, and closes what it had found", async () => {
      dependabotOff();
      seedInventory([lockedPackage({ name: "@acme/ui" })]);
      store.saveSecurityAlerts(
        repo.id,
        "osv",
        [osvAlert({ dependency: { name: "@acme/ui" }, key: "GHSA-x|npm|@acme/ui|package-lock.json" })],
        true,
      );

      await build({ osv: true }).read("tok", repo, false);

      expect(osv.asked).toEqual([]);
      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "fixed", closeReason: "not_found" });
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
        [{ path: "web/package-lock.json", read: "unreadable", packages: 0, publicPackages: 0 }],
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
        true,
      );

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open", closedAt: null });
    });

    it("closes nothing when the lookup stopped short, and says it was truncated", async () => {
      dependabotOff();
      seedInventory();
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], true);
      osv.truncated = true;

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open" });
      expect(states().osv).toMatchObject({ status: "ok", truncated: true });
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
      expect(states().osv).toMatchObject({ status: "error", error: "OSV answered 503", readAt: T0.toISOString() });
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
        true,
      );

      await build({ osv: true }).read("tok", repo, false);

      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "fixed", closeReason: "not_found" });
    });

    it("sends at most 20,000 distinct packages, keeps every entry of those, and closes nothing", async () => {
      dependabotOff();
      const many = Array.from({ length: MAX_OSV_PACKAGES + 5 }, (_, i) => lockedPackage({ name: `pkg-${i}`, version: "1.0.0" }));
      // The same package named by a second lockfile is not a new distinct package.
      many.push(lockedPackage({ name: "pkg-0", version: "1.0.0", lockfile: "web/package-lock.json" }));
      seedInventory(many);
      store.saveSecurityAlerts(repo.id, "osv", [osvAlert()], true);

      await build({ osv: true }).read("tok", repo, false);

      const sent = osv.asked[0]!;
      expect(new Set(sent.map((p) => `${p.name}@${p.version}`)).size).toBe(MAX_OSV_PACKAGES);
      expect(sent).toHaveLength(MAX_OSV_PACKAGES + 1);
      expect(states().osv).toMatchObject({ status: "ok", truncated: true });
      expect(store.securityAlerts(repo.id)[0]).toMatchObject({ state: "open" });
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

      expect(store.posture(repo.id)!.posture.visibility).toBe("public");
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
        error: null,
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

    it("stores a 404 as not scanned and does not ask again within the day", async () => {
      publicRepo();
      scorecard.set("acme/widgets", null);
      const step = build({ scorecard: true });

      await step.read("tok", repo, false);
      await step.read("tok", repo, false);

      expect(store.scorecard(repo.id)).toEqual({ readAt: T0.toISOString(), result: null, error: null });
      expect(scorecard.asked).toHaveLength(1);
    });

    it("logs a failure, stores it beside the last good score, and clears it on the next good read", async () => {
      publicRepo();
      scorecard.set("acme/widgets", scorecardResult());
      await build({ scorecard: true }).read("tok", repo, false);
      scorecard.set("acme/widgets", new UpstreamError("Scorecard answered 500", 500));

      await build({ scorecard: true }).read("tok", repo, true);

      expect(store.scorecard(repo.id)).toMatchObject({
        readAt: T0.toISOString(),
        result: scorecardResult(),
        error: expect.stringContaining("OpenSSF Scorecard"),
      });
      expect(logged.lines.find((l) => l.message.includes("Scorecard"))).toMatchObject({ level: "warn" });

      scorecard.set("acme/widgets", scorecardResult({ score: 9 }));
      await build({ scorecard: true }).read("tok", repo, true);
      expect(store.scorecard(repo.id)).toMatchObject({ error: null, result: { score: 9 } });
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
      expect(states().dependabot.error).toBe("GitHub answered 500 for https://api.github.com/repos/acme/widgets/alerts");
      expect(store.postureFailure(repo.id)!.error).toBe(
        "Bearer [token] was refused at https://api.github.com/repos/acme/widgets",
      );
    });

    it("leaves a message with neither alone, and ignores an empty token", () => {
      expect(scrub("GitHub's rate limit was reached", "")).toBe("GitHub's rate limit was reached");
    });
  });
});
