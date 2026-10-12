import type { DatabaseSync } from "node:sqlite";
import type { SourceState } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import {
  SecurityReportService,
  describeSecurity,
  githubSettingsUrl,
  type SecurityReportOptions,
} from "../src/services/security-report-service.js";
import { noopLogger } from "../src/interfaces/logger.js";
import { SecurityCrawlService } from "../src/services/security-crawl-service.js";
import {
  FakeSecurityAlertSource,
  dependabotAlert,
  issue,
  pr,
  repoPosture,
  scorecardResult,
  supplyChainFacts,
  supplyChainRecord,
} from "./fakes.js";

const NOW = new Date("2026-09-29T10:00:00.000Z");
const HOUR = 3_600_000;

const okState = (): SourceState => ({
  status: "ok",
  reason: null,
  readAt: "2026-09-29T09:00:00.000Z",
  attemptedAt: "2026-09-29T09:00:00.000Z",
  truncated: false,
  error: null,
});
const raw = (store: SqliteRepoStore) => (store as unknown as { db: DatabaseSync }).db;

describe("the security report service", () => {
  let store: SqliteRepoStore;
  let clock: Date;
  let options: SecurityReportOptions;

  const service = () => new SecurityReportService(store, store, options, () => clock);
  /** A repository crawled, with Dependabot read ok and these alerts. */
  const repoWith = (name: string, alerts: ReturnType<typeof dependabotAlert>[] = []) => {
    const id = store.addRepo("acme", name, [], "main").id;
    raw(store).prepare("UPDATE repos SET last_crawled_at = '2026-09-29T09:00:00.000Z' WHERE id = ?").run(id);
    store.saveSecurityAlerts(id, "dependabot", alerts, true);
    store.setSourceState(id, "dependabot", okState());
    return id;
  };

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    clock = NOW;
    options = { codeAnalysis: true, scorecardLookup: false };
  });

  describe("report", () => {
    it("answers 404 for an unknown repository", () => {
      expect(() => service().report(99)).toThrow(NotFoundError);
    });

    it.each([
      [{ from: "2026/01/01" }, "from must be a date as YYYY-MM-DD"],
      [{ from: "2026-09-20", to: "2026-09-10" }, "from must not be after to"],
      [{ from: "2026-09-30" }, "from must not be after today"],
      [{ to: "2026-02-30" }, "to must be a real calendar date"],
    ])("refuses the range %j", (range, message) => {
      const id = repoWith("widgets");
      expect(() => service().report(id, range)).toThrow(new ValidationError(message));
    });

    it("describes now from the stored alerts and the range from the dates asked for", () => {
      const id = repoWith("widgets", [
        dependabotAlert({ key: "1", severity: "high", createdAt: "2026-09-20T10:00:00Z" }),
        dependabotAlert({
          key: "2",
          severity: "low",
          createdAt: "2026-09-21T10:00:00Z",
          state: "fixed",
          closedAt: "2026-09-25T10:00:00Z",
        }),
      ]);

      const report = service().report(id, { from: "2026-09-01", to: "2026-09-28" });

      expect(report.repo).toMatchObject({ id, owner: "acme", name: "widgets" });
      expect(report.range).toEqual({ from: "2026-09-01", to: "2026-09-28" });
      expect(report.gradedAt).toBe(NOW.toISOString());
      expect(report.open.total).toBe(1);
      expect(report.open.bySeverity.high).toBe(1);
      expect(report.fixedInRange).toBe(1);
      // Nine days old and a high alert has 30 days, so the repository is graded high on the vulnerabilities.
      expect(report.grade?.overall.band).toBe("high");
    });

    it("works from stored data on a repository nothing has read, and says so", () => {
      const id = store.addRepo("acme", "widgets", [], "main").id;

      const report = service().report(id);

      expect(report.grade).toBeNull();
      expect(report.gradeMissing).toBe("not_crawled");
      expect(report.sources.dependabot.status).toBe("not_read");
      expect(report.posture).toBeNull();
      expect(report.scorecardStatus).toBe("off");
    });

    it("says why there is no supply chain record, and shows a record whenever one is held", () => {
      const id = repoWith("widgets");
      expect(service().report(id).supplyChain).toEqual({ status: "none", reason: "not_read" });

      options = { ...options, codeAnalysis: false };
      expect(service().report(id).supplyChain).toEqual({ status: "none", reason: "analysis_off" });

      store.saveSupplyChain(id, supplyChainRecord({ facts: supplyChainFacts({ workflowsRead: 2 }) }), []);
      expect(service().report(id).supplyChain).toMatchObject({ status: "ok", workflowsRead: 2 });
    });

    it("uses the GitHub settings page by default and the alert source's when it gives one", () => {
      const id = repoWith("widgets");
      expect(service().report(id).settingsUrl).toBe("https://github.com/acme/widgets/settings/security_analysis");
      expect(githubSettingsUrl("a b", "c")).toBe("https://github.com/a%20b/c/settings/security_analysis");

      options = { ...options, settingsUrl: (owner, name) => `https://example.test/${owner}/${name}` };
      expect(service().report(id).settingsUrl).toBe("https://example.test/acme/widgets");
    });

    it("reads the posture and its time, the pull requests and the stored issues with the repository's label rules", () => {
      const id = repoWith("widgets");
      store.savePosture(id, repoPosture({ visibility: "public" }), "2026-09-29T08:00:00.000Z");
      store.upsertPullRequests(id, [
        pr({
          number: 1,
          author: "dependabot[bot]",
          authorIsBot: true,
          state: "OPEN",
          mergedAt: null,
          closedAt: null,
          createdAt: "2026-09-20T10:00:00Z",
        }),
      ]);
      store.upsertIssues(id, [
        issue({ number: 1, state: "open", labels: ["security"] }),
        issue({ number: 2, state: "open", labels: ["vuln"] }),
      ]);

      const report = service().report(id);

      expect(report.posture?.visibility).toBe("public");
      expect(report.postureReadAt).toBe("2026-09-29T08:00:00.000Z");
      expect(report.dependencyUpdates.openNow).toBe(1);
      expect(report.securityIssues?.open).toBe(1);

      // The repository's own rules decide which issues are security issues.
      store.setIssueLabels(id, { kinds: { security: ["vuln"] } });
      expect(service().report(id).securityIssues?.open).toBe(1);
      expect(service().report(id).securityIssues?.open).toBe(1);
    });

    it("carries the failure of the last posture read, and drops it after a good one", () => {
      const id = repoWith("widgets");
      expect(service().report(id).postureError).toBeNull();

      store.savePosture(id, repoPosture({ visibility: "public" }), "2026-09-29T08:00:00.000Z");
      store.failPosture(id, "GitHub answered 500", "2026-09-29T09:00:00.000Z");
      const failed = service().report(id);
      expect(failed.postureError).toBe("GitHub answered 500");
      expect(failed.postureReadAt).toBe("2026-09-29T08:00:00.000Z");
      expect(failed.posture?.visibility).toBe("public");

      store.savePosture(id, repoPosture(), "2026-09-29T09:30:00.000Z");
      expect(service().report(id).postureError).toBeNull();
    });

    it("tells the person about a failed first posture read even though there is no posture", () => {
      const id = repoWith("widgets");
      store.failPosture(id, "down", "2026-09-29T09:00:00.000Z");

      const report = service().report(id);

      expect(report.postureError).toBe("down");
      expect(report.posture).toBeNull();
    });

    describe("a source this credential cannot see", () => {
      const crawl = (source: FakeSecurityAlertSource) =>
        new SecurityCrawlService(store, source, null, null, () => clock, noopLogger, []);

      it("keeps the alerts an administrator's crawl stored, but does not count them while access is lacking", async () => {
        const id = store.addRepo("acme", "widgets", [], "main").id;
        raw(store).prepare("UPDATE repos SET last_crawled_at = '2026-09-29T09:00:00.000Z' WHERE id = ?").run(id);
        const admin = new FakeSecurityAlertSource();
        admin.seed("dependabot", [dependabotAlert({ key: "1", severity: "critical", createdAt: "2026-09-20T10:00:00Z" })]);
        await crawl(admin).read("tok", store.getRepo(id)!, false);
        expect(service().summaries([id])[0]!.open.critical).toBe(1);

        clock = new Date(NOW.getTime() + HOUR);
        const guest = new FakeSecurityAlertSource();
        guest.set("dependabot", { status: "no_access", reason: "forbidden" });
        await crawl(guest).read("tok", store.getRepo(id)!, false);

        // Still stored for the next administrator's crawl to refresh ...
        expect(store.securityAlerts(id).map((a) => a.key)).toEqual(["1"]);
        // ... but core grades only a source that was read, so nothing is counted and the report says why.
        const report = service().report(id);
        expect(report.sources.dependabot).toMatchObject({ status: "no_access", reason: "forbidden" });
        expect(service().summaries([id])[0]!.open.critical).toBe(0);
        expect(report.openAlertTotal).toBe(0);
      });
    });

    describe("the Scorecard", () => {
      const status = (id: number) => {
        const { scorecardStatus, scorecard } = service().report(id);
        return { scorecardStatus, score: scorecard?.score ?? null };
      };

      it("is off unless a source is wired, even when a score is stored", () => {
        const id = repoWith("widgets");
        store.savePosture(id, repoPosture({ visibility: "public" }), "t");
        store.saveScorecard(id, "t", scorecardResult());
        expect(status(id)).toEqual({ scorecardStatus: "off", score: null });
      });

      it("shows a stored score for a public repository", () => {
        options = { ...options, scorecardLookup: true };
        const id = repoWith("widgets");
        store.savePosture(id, repoPosture({ visibility: "public" }), "t");
        store.saveScorecard(id, "t", scorecardResult({ score: 8.4 }));
        expect(status(id)).toEqual({ scorecardStatus: "ok", score: 8.4 });
      });

      it("is not public for a private or internal repository, and never shows a stored score", () => {
        options = { ...options, scorecardLookup: true };
        const id = repoWith("widgets");
        store.saveScorecard(id, "t", scorecardResult());
        for (const visibility of ["private", "internal"] as const) {
          store.savePosture(id, repoPosture({ visibility }), "t");
          expect(status(id)).toEqual({ scorecardStatus: "not_public", score: null });
        }
      });

      it("is not public, and shows no stored score, while the visibility is unread", () => {
        options = { ...options, scorecardLookup: true };
        const id = repoWith("widgets");
        store.saveScorecard(id, "t", scorecardResult({ score: 9 }));

        // No posture was ever read.
        expect(status(id)).toEqual({ scorecardStatus: "not_public", score: null });

        // A posture that was read but could not say (a null visibility) is treated the same way.
        store.savePosture(id, repoPosture({ visibility: null }), "t");
        expect(status(id)).toEqual({ scorecardStatus: "not_public", score: null });

        store.savePosture(id, repoPosture({ visibility: "public" }), "t2");
        expect(status(id)).toEqual({ scorecardStatus: "ok", score: 9 });
      });

      it("is not scanned when asked about and not found, or not yet read", () => {
        options = { ...options, scorecardLookup: true };
        const id = repoWith("widgets");
        store.savePosture(id, repoPosture({ visibility: "public" }), "t");
        expect(status(id)).toEqual({ scorecardStatus: "not_scanned", score: null });
        store.saveScorecard(id, "t", null);
        expect(status(id)).toEqual({ scorecardStatus: "not_scanned", score: null });
      });

      it("shows an error until the next good read, with the last good score beside it", () => {
        options = { ...options, scorecardLookup: true };
        const id = repoWith("widgets");
        store.savePosture(id, repoPosture({ visibility: "public" }), "t");
        store.saveScorecard(id, "t", scorecardResult({ score: 6 }));
        store.failScorecard(id, "down");
        expect(status(id)).toEqual({ scorecardStatus: "error", score: 6 });

        store.saveScorecard(id, "t2", scorecardResult({ score: 7 }));
        expect(status(id)).toEqual({ scorecardStatus: "ok", score: 7 });
      });
    });
  });

  describe("summaries", () => {
    it("sorts worst band first, then past fix-by, open critical and open high, then owner and name, with ungraded last", () => {
      const ungraded = store.addRepo("acme", "aardvark", [], "main").id;
      const clean = repoWith("clean");
      const highA = repoWith("high-a", [dependabotAlert({ key: "1", severity: "high", createdAt: "2026-09-20T10:00:00Z" })]);
      const highB = repoWith("high-b", [
        dependabotAlert({ key: "1", severity: "high", createdAt: "2026-09-20T10:00:00Z" }),
        dependabotAlert({ key: "2", severity: "high", createdAt: "2026-09-21T10:00:00Z" }),
      ]);
      // A critical alert 28 days old is past its 7 day limit, so the band is low.
      const worst = repoWith("worst", [dependabotAlert({ key: "1", severity: "critical", createdAt: "2026-09-01T10:00:00Z" })]);
      store.saveSupplyChain(clean, supplyChainRecord(), []);

      const rows = service().summaries();

      expect(rows.map((r) => r.repo.id)).toEqual([worst, highB, highA, clean, ungraded]);
      expect(rows.map((r) => r.band)).toEqual(["low", "high", "high", "elite", null]);
      expect(rows[0]).toMatchObject({ pastFix: 1, open: { critical: 1 } });
      expect(rows[4]!.gradeMissing).toBe("not_crawled");
    });

    it("breaks a tie on past fix-by, then open critical, then open high, then the name", () => {
      const old = "2026-07-01T10:00:00Z";
      // All are low band by a critical alert past its limit; the tie breaks on counts.
      const one = repoWith("b-one", [dependabotAlert({ key: "1", severity: "critical", createdAt: old })]);
      const two = repoWith("a-two", [
        dependabotAlert({ key: "1", severity: "critical", createdAt: old }),
        dependabotAlert({ key: "2", severity: "critical", createdAt: old }),
      ]);
      const same = repoWith("a-one", [dependabotAlert({ key: "1", severity: "critical", createdAt: old })]);

      expect(
        service()
          .summaries()
          .map((r) => r.repo.id),
      ).toEqual([two, same, one]);
    });

    it("limits the list to the ids asked for and answers 404 for an unknown one", () => {
      const first = repoWith("one");
      repoWith("two");

      expect(
        service()
          .summaries([first, first])
          .map((r) => r.repo.id),
      ).toEqual([first]);
      expect(() => service().summaries([first, 999])).toThrow(NotFoundError);
    });

    it("projects the same band, open counts and actions as the report", () => {
      const id = repoWith("widgets", [dependabotAlert({ key: "1", severity: "high", createdAt: "2026-09-20T10:00:00Z" })]);
      const svc = service();

      const [summary] = svc.summaries();
      const report = svc.report(id);

      expect(summary).toMatchObject({ band: report.grade?.overall.band, open: report.open.bySeverity });
      expect(summary!.actions).toBe(report.actions.filter((a) => a.band !== null).length);
    });

    describe("memoising", () => {
      let svc: SecurityReportService;
      let id: number;
      let alertReads: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        id = repoWith("widgets", [dependabotAlert({ key: "1", severity: "high", createdAt: "2026-09-20T10:00:00Z" })]);
        svc = service();
        alertReads = vi.spyOn(store, "securityAlerts");
      });

      it("does not rebuild a second time when nothing has changed", () => {
        svc.summaries();
        svc.summaries();
        expect(alertReads).toHaveBeenCalledTimes(1);
      });

      it("rebuilds after a crawl", () => {
        svc.summaries();
        raw(store).prepare("UPDATE repos SET last_crawled_at = '2026-09-29T09:30:00.000Z' WHERE id = ?").run(id);
        svc.summaries();
        expect(alertReads).toHaveBeenCalledTimes(2);
      });

      it("rebuilds when a source is read again, and when a posture or a scorecard is stored", () => {
        svc.summaries();
        store.setSourceState(id, "dependabot", { ...okState(), attemptedAt: "2026-09-29T09:30:00.000Z" });
        svc.summaries();
        store.savePosture(id, repoPosture(), "2026-09-29T09:31:00.000Z");
        svc.summaries();
        store.failScorecard(id, "down");
        svc.summaries();
        expect(alertReads).toHaveBeenCalledTimes(4);
      });

      it("rebuilds in a new UTC hour, so alerts age into being past their fix-by date", () => {
        svc.summaries();
        clock = new Date(NOW.getTime() + 30 * 60_000);
        svc.summaries();
        expect(alertReads).toHaveBeenCalledTimes(1);
        clock = new Date(NOW.getTime() + HOUR);
        svc.summaries();
        expect(alertReads).toHaveBeenCalledTimes(2);
      });

      it("lays the live crawl status over a memoised summary without rebuilding", () => {
        expect(svc.summaries()[0]!.repo.crawlStatus).toBe("idle");
        store.setCrawlState(id, "crawling", "Reading security alerts");

        expect(svc.summaries()[0]!.repo.crawlStatus).toBe("crawling");
        expect(alertReads).toHaveBeenCalledTimes(1);
      });

      it("forgets a deleted repository", () => {
        const other = repoWith("other");
        svc.summaries();
        store.deleteRepo(other);

        expect(svc.summaries().map((r) => r.repo.id)).toEqual([id]);
      });
    });
  });
});

describe("describeSecurity", () => {
  const summary = (overrides: object) =>
    ({
      band: "high",
      gradeMissing: null,
      failed: false,
      pastFix: 2,
      open: { critical: 1, high: 3, medium: 0, low: 0, unknown: 0 },
      ...overrides,
    }) as Parameters<typeof describeSecurity>[0];

  it("gives the band, the open counts and the number past their fix-by date", () => {
    expect(describeSecurity(summary({}))).toBe(
      "security: high band, 1 critical and 3 high alerts open, 2 past their fix-by date",
    );
  });

  it("says when a source could not be read", () => {
    expect(describeSecurity(summary({ failed: true }))).toContain("at least one source that could not be read");
  });

  it("says why a repository is not graded", () => {
    expect(describeSecurity(summary({ band: null, gradeMissing: "not_crawled" }))).toContain("has not been crawled");
    expect(describeSecurity(summary({ band: null, gradeMissing: "nothing_measured" }))).toContain("nothing could be measured");
  });
});
