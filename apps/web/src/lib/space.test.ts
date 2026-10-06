import { describe, expect, it } from "vitest";
import type { ColumnTime, SpaceWeekRow } from "@dora-dashboard/core";
import { copy } from "../copy";
import {
  assigneeLabel,
  browseUrl,
  columnLabel,
  columnRow,
  columnSegments,
  groupByAssignee,
  HYGIENE_ORDER,
  limitGroups,
  shareOf,
  throughputChart,
  type AssigneeGroup,
} from "./space";

const week = (iso: string, doneByType: Record<string, number>, partial = false): SpaceWeekRow => ({
  week: iso,
  doneByType,
  done: Object.values(doneByType).reduce((a, b) => a + b, 0),
  inProgress: 1,
  partial,
});

describe("HYGIENE_ORDER", () => {
  it("lists every check once, in the order the cards are shown", () => {
    expect(HYGIENE_ORDER).toEqual([
      "pr_without_key",
      "done_without_pr",
      "skipped_in_progress",
      "bulk_move",
      "reopened",
      "stale_in_progress",
      "in_progress_unassigned",
    ]);
  });
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
    { column: "To do", meanHours: 0, medianHours: 0, items: 0 },
    { column: "In progress", meanHours: 10, medianHours: 8, items: 3 },
    { column: "Review", meanHours: 5, medianHours: 4, items: 3 },
    { column: null, meanHours: 1, medianHours: 1, items: 1 },
  ];

  it("drops empty columns but keeps colours by board position", () => {
    const segments = columnSegments(columns);
    expect(segments.map((s) => [s.label, s.colour])).toEqual([
      ["In progress", "var(--column-2)"],
      ["Review", "var(--column-3)"],
      [copy.space.columns.notOnBoard, "var(--column-none)"],
    ]);
  });

  it("labels time outside the board, which the report gives as null, with the page's own words", () => {
    expect(columnLabel(null)).toBe(copy.space.columns.notOnBoard);
    expect(columnLabel("Review")).toBe("Review");
  });

  it("treats a board column that happens to share those words as a column of the board", () => {
    const named: ColumnTime[] = [
      { column: "Not on the board", meanHours: 2, medianHours: 2, items: 1 },
      { column: null, meanHours: 1, medianHours: 1, items: 1 },
    ];
    expect(columnSegments(named).map((s) => [s.label, s.colour])).toEqual([
      ["Not on the board", "var(--column-1)"],
      [copy.space.columns.notOnBoard, "var(--column-none)"],
    ]);
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
  const item = (key: string, assigned: boolean, assignee?: string | null) => ({ key, assigned, assignee });
  const summary = (groups: AssigneeGroup<{ key: string }>[]) =>
    groups.map((g) => [g.name, g.assigned, g.items.map((i) => i.key)]);

  it("sorts names A to Z with unassigned last and keeps order inside a group", () => {
    const groups = groupByAssignee([
      item("W-1", true, "Zed Example"),
      item("W-2", false, null),
      item("W-3", true, "Ann Example"),
      item("W-4", true, "Zed Example"),
    ]);
    expect(summary(groups)).toEqual([
      ["Ann Example", true, ["W-3"]],
      ["Zed Example", true, ["W-1", "W-4"]],
      [null, false, ["W-2"]],
    ]);
  });

  it("keeps assigned work whose name was not recorded apart from unassigned work, between the names and it", () => {
    const groups = groupByAssignee([
      item("W-1", false, null),
      item("W-2", true, null), // a space crawled before names were recorded
      item("W-3", true, "Ann Example"),
      item("W-4", true, "  "), // a blank name is no name
      item("W-5", true), // no name given at all
    ]);
    expect(summary(groups)).toEqual([
      ["Ann Example", true, ["W-3"]],
      [null, true, ["W-2", "W-4", "W-5"]],
      [null, false, ["W-1"]],
    ]);
    expect(new Set(groups.map((g) => g.id)).size).toBe(3);
  });

  it("does not mistake a person's name for one of the nameless groups", () => {
    const groups = groupByAssignee([item("W-1", true, "unassigned"), item("W-2", false, null)]);
    expect(summary(groups)).toEqual([
      ["unassigned", true, ["W-1"]],
      [null, false, ["W-2"]],
    ]);
  });

  it("puts unassigned last even when it is met first", () => {
    const groups = groupByAssignee([item("W-1", false, null), item("W-2", true, null), item("W-3", true, "Ann Example")]);
    expect(groups.map((g) => [g.name, g.assigned])).toEqual([
      ["Ann Example", true],
      [null, true],
      [null, false],
    ]);
  });
});

describe("assigneeLabel", () => {
  it.each([
    [{ name: "Ann Example", assigned: true }, "Ann Example"],
    [{ name: null, assigned: true }, copy.space.hygiene.nameNotRecorded],
    [{ name: null, assigned: false }, copy.space.hygiene.unassigned],
  ])("labels %j as %s", (group, label) => {
    expect(assigneeLabel(group)).toBe(label);
  });
});

describe("limitGroups", () => {
  const groups = [
    { id: "name:Ann", name: "Ann", assigned: true, items: [1, 2, 3] },
    { id: "name:Bea", name: "Bea", assigned: true, items: [4, 5] },
    { id: "unassigned", name: null, assigned: false, items: [6] },
  ];

  it("keeps the first items across groups and drops the empty ones", () => {
    expect(limitGroups(groups, 4)).toEqual([
      { id: "name:Ann", name: "Ann", assigned: true, items: [1, 2, 3] },
      { id: "name:Bea", name: "Bea", assigned: true, items: [4] },
    ]);
  });

  it("returns everything when the limit is large", () => {
    expect(limitGroups(groups, 10)).toEqual(groups);
  });
});
