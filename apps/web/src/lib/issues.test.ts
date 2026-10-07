import { describe, expect, it } from "vitest";
import { copy } from "../copy";
import { issueReport, repo } from "../test/fixtures";
import {
  closedKindSeries,
  defaultInputs,
  flowRows,
  formatLabelList,
  hasFlow,
  hasIssues,
  inputsFromRules,
  issuePartWeekNote,
  kindColour,
  labelProblem,
  oldestOpen,
  openByKindBars,
  openByPriorityBars,
  orderedFindings,
  parseLabelList,
  reposWithIssues,
  rulesFromInputs,
} from "./issues";

describe("hasIssues", () => {
  it("is false for no repositories and for repositories with no issues", () => {
    expect(hasIssues([])).toBe(false);
    expect(hasIssues([repo({ id: 1 }), repo({ id: 2, issues: 0, issuesEnabled: false })])).toBe(false);
  });

  it("is true as soon as one repository has issues", () => {
    expect(hasIssues([repo({ id: 1 }), repo({ id: 2, issues: 3 })])).toBe(true);
  });

  it("lists only the repositories that have issues, in the given order", () => {
    const listed = reposWithIssues([repo({ id: 1, issues: 2 }), repo({ id: 2 }), repo({ id: 3, issues: 9 })]);
    expect(listed.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("kind colours", () => {
  it("fixes each kind to one token", () => {
    expect((["bug", "feature", "maintenance", "incident", "security", "other"] as const).map(kindColour)).toEqual([
      "var(--series-1)",
      "var(--series-2)",
      "var(--series-3)",
      "var(--series-4)",
      "var(--series-5)",
      "var(--type-other)",
    ]);
  });

  it("keeps a kind's colour when an earlier kind closed nothing", () => {
    const report = issueReport();
    // Maintenance and incident closed something in this fixture, but bug does not once its closes are removed.
    const withoutBugs = report.weekly.map((w) => ({ ...w, closedByKind: { ...w.closedByKind, bug: 0 } }));
    const all = closedKindSeries(report.weekly);
    const fewer = closedKindSeries(withoutBugs);
    expect(all.map((s) => s.key)).toEqual(["bug", "feature", "maintenance", "incident", "other"]);
    expect(fewer.map((s) => s.key)).toEqual(["feature", "maintenance", "incident", "other"]);
    for (const series of fewer) expect(series.colour).toBe(all.find((s) => s.key === series.key)!.colour);
  });

  it("gives every kind a bar in the fixed order, with zero for one that is absent", () => {
    const bars = openByKindBars(issueReport().openByKind);
    expect(bars.map((b) => [b.key, b.count])).toEqual([
      ["bug", 2],
      ["feature", 2],
      ["maintenance", 1],
      ["incident", 0],
      ["security", 1],
      ["other", 0],
    ]);
    expect(bars[4]!.colour).toBe("var(--series-5)");
  });

  it("draws every priority bar in one colour, P0 first and no priority last", () => {
    const bars = openByPriorityBars(issueReport().openByPriority, "var(--stage-2)");
    expect(bars.map((b) => [b.label, b.count])).toEqual([
      ["P0", 1],
      ["P1", 1],
      ["P2", 2],
      ["P3", 0],
      ["P4", 0],
      [copy.issue.priorities.none, 2],
    ]);
    expect(new Set(bars.map((b) => b.colour))).toEqual(new Set(["var(--stage-2)"]));
  });
});

describe("chart rows", () => {
  it("keeps the part week and marks it partial", () => {
    const rows = flowRows(issueReport().weekly);
    expect(rows.map((r) => [r.week, r.partial])).toEqual([
      ["2026-01-05", false],
      ["2026-01-12", false],
      ["2026-01-19", true],
    ]);
  });

  it("carries opened, closed, open and each kind's closes as fields of the row", () => {
    const [first, , last] = flowRows(issueReport().weekly);
    expect(first).toMatchObject({ opened: 6, closed: 4, openAtEnd: 5, bug: 2, feature: 1, maintenance: 1, other: 0 });
    expect(last).toMatchObject({ opened: 4, closed: 3, openAtEnd: 6, feature: 2, other: 1 });
  });

  it("has a flow when anything was opened or closed, and none otherwise", () => {
    expect(hasFlow(issueReport().weekly)).toBe(true);
    expect(hasFlow(issueReport().weekly.map((w) => ({ ...w, opened: 0, closed: 0 })))).toBe(false);
  });

  it("names the longest open issue, or none when nothing is open", () => {
    expect(oldestOpen(issueReport().ageing)?.number).toBe(7);
    expect(oldestOpen([])).toBeNull();
  });

  it("explains a part week that is still under way and one the range cut short", () => {
    const week = "19 Jan";
    expect(issuePartWeekNote({ week: "2026-01-19", through: "2026-01-21", current: true })).toBe(
      copy.issue.flow.partWeek.current(week),
    );
    expect(issuePartWeekNote({ week: "2026-01-19", through: "2026-01-21", current: false })).toBe(
      copy.issue.flow.partWeek.cut(week, "21 Jan"),
    );
  });
});

describe("hygiene order", () => {
  it("lists findings in the report's check order whatever order they arrive in, and skips a check that is missing", () => {
    const findings = issueReport().hygiene.filter((f) => f.check !== "reopened");
    expect(orderedFindings(findings).map((f) => f.check)).toEqual([
      "closed_without_pr",
      "urgent_unassigned",
      "stale_urgent",
      "unclassified",
      "pr_without_issue",
    ]);
  });
});

describe("label text", () => {
  it("splits on commas, trims, drops blanks and keeps a name once however it is capitalised", () => {
    expect(parseLabelList(" Bug , defect,, BUG ,  ,regression ")).toEqual(["Bug", "defect", "regression"]);
    expect(parseLabelList("   ")).toEqual([]);
  });

  it("formats names with a comma and a space, and nothing for none", () => {
    expect(formatLabelList(["bug", "tech debt"])).toBe("bug, tech debt");
    expect(formatLabelList(undefined)).toBe("");
  });

  it("round trips an override through the input text", () => {
    const rules = { kinds: { bug: ["defect", "Broken"] }, priorities: { P0: ["sev1"], P3: ["minor", "nice to have"] } };
    const inputs = inputsFromRules(rules);
    expect(inputs.kinds.bug).toBe("defect, Broken");
    expect(inputs.kinds.feature).toBe("");
    expect(inputs.priorities.P3).toBe("minor, nice to have");
    expect(rulesFromInputs(inputs)).toEqual(rules);
  });

  it("sends only the keys that were filled in, and null when none were", () => {
    const empty = inputsFromRules(null);
    expect(rulesFromInputs(empty)).toBeNull();
    expect(rulesFromInputs({ ...empty, kinds: { ...empty.kinds, epic: "initiative" } })).toEqual({
      kinds: { epic: ["initiative"] },
    });
    expect(rulesFromInputs({ ...empty, priorities: { ...empty.priorities, P1: " , " } })).toBeNull();
  });

  it("offers the defaults core classifies with as placeholders", () => {
    const defaults = defaultInputs();
    expect(defaults.kinds.bug).toBe("bug, defect, regression");
    expect(defaults.priorities.P0).toBe("p0, critical, urgent, blocker");
  });

  it("flags more than 30 names or a name over 100 characters, as the API would refuse them", () => {
    expect(labelProblem("a, b")).toBeNull();
    expect(labelProblem(Array.from({ length: 31 }, (_, i) => `l${i}`).join(","))).toBe("tooMany");
    expect(labelProblem(Array.from({ length: 30 }, (_, i) => `l${i}`).join(","))).toBeNull();
    expect(labelProblem("x".repeat(101))).toBe("tooLong");
    expect(labelProblem("x".repeat(100))).toBeNull();
  });
});
