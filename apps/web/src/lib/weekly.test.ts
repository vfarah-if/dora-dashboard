import { describe, expect, it } from "vitest";
import { fromFirstActive, initialWindow, partWeek, partWeekNote, weekNames } from "./weekly";

describe("fromFirstActive", () => {
  const weeks = [{ n: 0 }, { n: 0 }, { n: 3 }, { n: 0 }, { n: 1 }];

  it("drops the empty weeks before the first active one and keeps later gaps", () => {
    expect(fromFirstActive(weeks, (w) => w.n > 0)).toEqual([{ n: 3 }, { n: 0 }, { n: 1 }]);
  });

  it("returns every week when none is active", () => {
    expect(fromFirstActive(weeks, () => false)).toEqual(weeks);
  });

  it("returns every week when the first is already active", () => {
    expect(fromFirstActive(weeks, () => true)).toHaveLength(5);
  });
});

describe("initialWindow", () => {
  it("needs no window when every week fits", () => {
    expect(initialWindow(26)).toBeNull();
    expect(initialWindow(0)).toBeNull();
  });

  it("opens on the latest weeks when there are more than fit", () => {
    expect(initialWindow(110)).toEqual({ startIndex: 84, endIndex: 109 });
  });

  it("honours a smaller visible count", () => {
    expect(initialWindow(10, 4)).toEqual({ startIndex: 6, endIndex: 9 });
  });
});

describe("partWeek", () => {
  const weekly = [
    { week: "2026-03-02", partial: false },
    { week: "2026-03-09", partial: true },
  ];

  it("is still under way when the range runs to today", () => {
    const report = { weekly, range: { to: "2026-03-11T14:05:00Z" } };
    expect(partWeek(report, "2026-03-11")).toEqual({ week: "2026-03-09", through: "2026-03-11", current: true });
  });

  it("is cut short when the range ended on an earlier day", () => {
    const report = { weekly, range: { to: "2026-03-11T23:59:59Z" } };
    expect(partWeek(report, "2026-04-01")).toEqual({ week: "2026-03-09", through: "2026-03-11", current: false });
  });

  it("is null when the range ends with a week, or has none", () => {
    expect(
      partWeek({ weekly: [{ week: "2026-03-02", partial: false }], range: { to: "2026-03-08T23:59:59Z" } }, "2026-04-01"),
    ).toBeNull();
    expect(partWeek({ weekly: [], range: { to: "2026-03-08T23:59:59Z" } }, "2026-04-01")).toBeNull();
  });
});

describe("weekNames", () => {
  it("marks only a week still under way as so far, in a heading and in a table cell", () => {
    const names = weekNames({ week: "2026-03-09", through: "2026-03-11", current: true });
    expect(names.heading("2026-03-02")).toBe("Week starting 2 Mar");
    expect(names.heading("2026-03-09")).toBe("Week starting 9 Mar, so far");
    expect(names.cell("2026-03-02")).toBe("2 Mar");
    expect(names.cell("2026-03-09")).toBe("9 Mar, so far");
  });

  it("gives the day a week cut short by an earlier range stops at", () => {
    const names = weekNames({ week: "2026-03-09", through: "2026-03-11", current: false });
    expect(names.heading("2026-03-09")).toBe("Week starting 9 Mar, to 11 Mar");
    expect(names.cell("2026-03-09")).toBe("9 Mar, to 11 Mar");
  });

  it("marks nothing when the range ends with a week", () => {
    const names = weekNames(null);
    expect(names.heading("2026-03-09")).toBe("Week starting 9 Mar");
    expect(names.cell("2026-03-09")).toBe("9 Mar");
  });
});

describe("partWeekNote", () => {
  it("says a week still under way is marked so far", () => {
    expect(partWeekNote({ week: "2026-03-09", through: "2026-03-11", current: true })).toMatch(
      /^The week starting 9 Mar is not over yet, so its figures are marked so far\./,
    );
  });

  it("says where the range stops in a week it cuts short", () => {
    expect(partWeekNote({ week: "2026-03-09", through: "2026-03-11", current: false })).toMatch(
      /^The range ends on 11 Mar, part way through the week starting 9 Mar, so that week's figures stop there\./,
    );
  });
});
