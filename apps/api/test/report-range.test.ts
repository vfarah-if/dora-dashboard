import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { dayOf, validateDateRange } from "../src/services/date-range.js";
import { IssueReportService } from "../src/services/issue-report-service.js";
import { ReportService } from "../src/services/report-service.js";
import { SpaceReportService } from "../src/services/space-report-service.js";
import { SITE } from "./fakes.js";

// Today, by the services' own clock, is Tuesday 6 October 2026, late in the evening in UTC.
const clock = { now: new Date("2026-10-06T23:30:00Z") };

describe("a from date after today", () => {
  let store: SqliteRepoStore;
  let repoId: number;
  let spaceId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
    spaceId = store.linkSpaces(repoId, SITE, [{ key: "WID", name: "Widgets" }])[0]!.id;
    clock.now = new Date("2026-10-06T23:30:00Z");
  });

  describe("in the repository report", () => {
    const reports = () => new ReportService(store, () => clock.now);

    it("is refused, rather than answered with an inverted range", () => {
      expect(() => reports().report(repoId, { from: "2026-11-01" })).toThrow(ValidationError);
      expect(() => reports().report(repoId, { from: "2026-11-01" })).toThrow("from must not be after today");
    });

    it("is refused when `to` is also given and also in the future", () => {
      expect(() => reports().report(repoId, { from: "2026-11-01", to: "2026-12-01" })).toThrow("from must not be after today");
    });

    it("is refused in a comparison too", () => {
      expect(() => reports().compare([repoId], { from: "2026-10-07" })).toThrow("from must not be after today");
    });

    it("accepts today itself, and any earlier day", () => {
      expect(reports().report(repoId, { from: "2026-10-06" }).range.from).toBe("2026-10-06");
      expect(reports().report(repoId, { from: "2026-09-01", to: "2026-09-30" }).range.from).toBe("2026-09-01");
    });

    it("takes today from the clock it was given, so a later day makes the same request valid", () => {
      expect(() => reports().report(repoId, { from: "2026-10-07" })).toThrow("from must not be after today");
      clock.now = new Date("2026-10-07T00:00:00Z");
      expect(reports().report(repoId, { from: "2026-10-07" }).range.from).toBe("2026-10-07");
    });

    it("is refused against the real calendar when no clock is given", () => {
      expect(() => new ReportService(store).report(repoId, { from: "2999-01-01" })).toThrow("from must not be after today");
    });

    it("still says from is after to first when both are wrong", () => {
      expect(() => reports().report(repoId, { from: "2026-12-01", to: "2026-11-01" })).toThrow("from must not be after to");
    });
  });

  describe("in the space report", () => {
    const reports = () => new SpaceReportService(store, () => clock.now);

    it("is refused, rather than answered with an inverted range", () => {
      expect(() => reports().report(spaceId, { from: "2026-11-01" })).toThrow(ValidationError);
      expect(() => reports().report(spaceId, { from: "2026-11-01" })).toThrow("from must not be after today");
    });

    it("is refused when `to` is also given and also in the future", () => {
      expect(() => reports().report(spaceId, { from: "2026-11-01", to: "2026-12-01" })).toThrow("from must not be after today");
    });

    it("accepts today itself, alone or as the end of a range", () => {
      expect(reports().report(spaceId, { from: "2026-10-06" }).range.from).toBe("2026-10-06");
      expect(reports().report(spaceId, { from: "2026-10-01", to: "2026-10-06" }).range).toEqual({
        from: "2026-10-01",
        to: "2026-10-06",
      });
    });

    it("is refused against the real calendar when no clock is given", () => {
      expect(() => new SpaceReportService(store).report(spaceId, { from: "2999-01-01" })).toThrow("from must not be after today");
    });

    it("takes today from the clock it was given", () => {
      clock.now = new Date("2026-10-07T00:00:00Z");
      expect(reports().report(spaceId, { from: "2026-10-07" }).range.from).toBe("2026-10-07");
    });
  });
});

describe("validateDateRange", () => {
  it("leaves a from after today alone when no day is given, as the code health report does", () => {
    expect(() => validateDateRange({ from: "2999-01-01" })).not.toThrow();
  });

  it("names the UTC calendar day of an instant", () => {
    expect(dayOf(new Date("2026-10-06T23:59:59Z"))).toBe("2026-10-06");
    expect(dayOf(new Date("2026-10-07T00:00:00Z"))).toBe("2026-10-07");
  });
});

describe("an impossible or ancient date", () => {
  const store = new SqliteRepoStore(":memory:");
  const repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
  const spaceId = store.linkSpaces(repoId, SITE, [{ key: "WID", name: "Widgets" }])[0]!.id;
  const now = () => new Date("2026-10-06T12:00:00Z");
  const asks: [string, (range: { from?: string; to?: string }) => unknown][] = [
    ["repository report", (r) => new ReportService(store, now).report(repoId, r)],
    ["repository comparison", (r) => new ReportService(store, now).compare([repoId], r)],
    ["space report", (r) => new SpaceReportService(store, now).report(spaceId, r)],
    ["issue report", (r) => new IssueReportService(store, now).report(repoId, r)],
  ];

  describe.each(asks)("in the %s", (_name, ask) => {
    it.each([{ to: "2026-13-01" }, { to: "2026-02-30" }, { from: "2026-00-10" }, { from: "2025-02-29" }])(
      "is refused as a ValidationError, not a crash: %j",
      (range) => {
        expect(() => ask(range)).toThrow(ValidationError);
        expect(() => ask(range)).toThrow("must be a real calendar date");
      },
    );

    it("refuses a from before 2000-01-01, so the weekly loop stays bounded", () => {
      expect(() => ask({ from: "0001-01-01" })).toThrow("from must not be before 2000-01-01");
      expect(() => ask({ from: "1999-12-31" })).toThrow(ValidationError);
    });

    it("accepts a leap day and 2000-01-01 itself", () => {
      expect(() => ask({ from: "2000-01-01", to: "2000-03-01" })).not.toThrow();
      expect(() => ask({ from: "2024-02-29", to: "2024-03-01" })).not.toThrow();
    });
  });

  it("answers 400 through the issue report route", async () => {
    const { buildApp } = await import("../src/app.js");
    const { MemorySessionStore } = await import("../src/infrastructure/auth/memory-session-store.js");
    const { config, FakeCli, FakeProvider } = await import("./fakes.js");
    const { app } = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
    });
    const res = await app.inject(`/api/repos/${repoId}/issues/report?to=2026-02-30`);
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});
