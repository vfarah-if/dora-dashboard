import { describe, expect, it } from "vitest";
import type { ColumnTime, SpaceWeekRow } from "@dora-dashboard/core";
import { copy } from "../copy";
import {
  browseUrl,
  columnLabel,
  columnRow,
  columnSegments,
  groupByAssignee,
  limitGroups,
  shareOf,
  throughputChart,
} from "./space";

const week = (iso: string, doneByType: Record<string, number>, partial = false): SpaceWeekRow => ({
  week: iso,
  doneByType,
  done: Object.values(doneByType).reduce((a, b) => a + b, 0),
  inProgress: 1,
  partial,
});

describe("browseUrl", () => {
  it("joins the site and the key", () => {
    expect(browseUrl("https://acme.example.test", "WID-12")).toBe("https://acme.example.test/browse/WID-12");
  });

  it("tolerates a trailing slash", () => {
    expect(browseUrl("https://acme.example.test/", "WID-12")).toBe("https://acme.example.test/browse/WID-12");
  });
});

describe("shareOf", () => {
  it("divides count by the total", () => {
    expect(shareOf(1, 4)).toBe(0.25);
  });

  it.each([null, 0])("is null when the total is %s", (of) => {
    expect(shareOf(2, of)).toBeNull();
  });
});

describe("throughputChart", () => {
  it("leaves out a part-finished week", () => {
    const { rows } = throughputChart([week("2026-01-05", { Story: 2 }), week("2026-01-12", { Story: 1 }, true)]);
    expect(rows.map((r) => r.week)).toEqual(["2026-01-05"]);
  });

  it("lists only the types present, in a fixed order that does not depend on counts", () => {
    const { series } = throughputChart([week("2026-01-05", { Task: 9, Bug: 1 }), week("2026-01-12", { Story: 1 })]);
    expect(series.map((s) => [s.label, s.colour])).toEqual([
      ["Story", "var(--series-1)"],
      ["Bug", "var(--series-2)"],
      ["Task", "var(--series-3)"],
    ]);
  });

  it("folds unknown types into one neutral Other series and zero-fills gaps", () => {
    const { series, rows } = throughputChart([
      week("2026-01-05", { Story: 2, Improvement: 1, Spike: 2 }),
      week("2026-01-12", { Story: 1 }),
    ]);
    expect(series.map((s) => s.label)).toEqual(["Story", copy.space.flow.throughput.otherType]);
    expect(series[1]!.colour).toBe("var(--type-other)");
    expect(rows[0]).toEqual({ week: "2026-01-05", [series[0]!.key]: 2, [series[1]!.key]: 3 });
    expect(rows[1]).toEqual({ week: "2026-01-12", [series[0]!.key]: 1, [series[1]!.key]: 0 });
  });

  it("is empty when nothing was done", () => {
    expect(throughputChart([week("2026-01-05", {})])).toEqual({ series: [], rows: [{ week: "2026-01-05" }] });
  });
});

describe("columnSegments", () => {
  const columns: ColumnTime[] = [
    { column: "To do", meanHours: 0, medianHours: null, items: 0 },
    { column: "In progress", meanHours: 10, medianHours: 8, items: 3 },
    { column: "Review", meanHours: 5, medianHours: 4, items: 3 },
    { column: "Not on the board", meanHours: 1, medianHours: 1, items: 1 },
  ];

  it("drops empty columns but keeps colours by board position", () => {
    const segments = columnSegments(columns);
    expect(segments.map((s) => [s.label, s.colour])).toEqual([
      ["In progress", "var(--column-2)"],
      ["Review", "var(--column-3)"],
      [copy.space.columns.notOnBoard, "var(--column-none)"],
    ]);
  });

  it("labels time outside the board with the page's own words, not the name the API compares by", () => {
    expect(columnLabel("Not on the board")).toBe(copy.space.columns.notOnBoard);
    expect(columnLabel("Review")).toBe("Review");
  });

  it("builds the single row for the stacked bar", () => {
    const row = columnRow(columnSegments(columns));
    expect(Object.values(row).filter((v) => typeof v === "number")).toEqual([10, 5, 1]);
  });

  it("wraps colours after eight columns", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ column: `C${i}`, meanHours: 1, medianHours: 1, items: 1 }));
    expect(columnSegments(many)[8]!.colour).toBe("var(--column-1)");
  });
});

describe("groupByAssignee", () => {
  const item = (key: string, assignee?: string | null) => ({ key, assignee });

  it("sorts names A to Z with unassigned last and keeps order inside a group", () => {
    const groups = groupByAssignee([
      item("W-1", "Zed Example"),
      item("W-2", null),
      item("W-3", "Ann Example"),
      item("W-4", "Zed Example"),
    ]);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.key)])).toEqual([
      ["Ann Example", ["W-3"]],
      ["Zed Example", ["W-1", "W-4"]],
      [null, ["W-2"]],
    ]);
  });

  it("treats a missing or blank name as unassigned", () => {
    expect(groupByAssignee([item("W-1"), item("W-2", "  ")])).toEqual([{ name: null, items: [item("W-1"), item("W-2", "  ")] }]);
  });

  it("puts unassigned last even when it is met first", () => {
    expect(groupByAssignee([item("W-1", null), item("W-2", "Ann Example")]).map((g) => g.name)).toEqual(["Ann Example", null]);
  });
});

describe("limitGroups", () => {
  const groups = [
    { name: "Ann", items: [1, 2, 3] },
    { name: "Bea", items: [4, 5] },
    { name: null, items: [6] },
  ];

  it("keeps the first items across groups and drops the empty ones", () => {
    expect(limitGroups(groups, 4)).toEqual([
      { name: "Ann", items: [1, 2, 3] },
      { name: "Bea", items: [4] },
    ]);
  });

  it("returns everything when the limit is large", () => {
    expect(limitGroups(groups, 10)).toEqual(groups);
  });
});
