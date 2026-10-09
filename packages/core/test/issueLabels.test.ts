import { describe, expect, it } from "vitest";
import { classifyIssue, DEFAULT_ISSUE_LABELS, ISSUE_LABEL_LIMITS } from "../src/issueLabels.js";
import { issue } from "./issue.js";

const classify = (
  overrides: Parameters<typeof issue>[0] extends infer T ? Partial<T> : never,
  rules?: Parameters<typeof classifyIssue>[1],
) => classifyIssue(issue({ number: 1, ...overrides }), rules);

describe("classifyIssue by label", () => {
  it.each([
    ["bug", "bug"],
    ["defect", "bug"],
    ["regression", "bug"],
    ["enhancement", "feature"],
    ["feature request", "feature"],
    ["story", "feature"],
    ["chore", "maintenance"],
    ["tech debt", "maintenance"],
    ["dev-infra", "maintenance"],
    ["ci", "maintenance"],
    ["outage", "incident"],
    ["hotfix", "incident"],
    ["vulnerability", "security"],
    ["epic", "epic"],
  ])("reads the label %s as %s", (label, kind) => {
    expect(classify({ labels: [label] }).kind).toBe(kind);
  });

  it.each([
    ["Bug", "bug"],
    ["  ENHANCEMENT  ", "feature"],
    ["type: bug", "bug"],
    ["type:bug", "bug"],
    ["Type/Feature", "feature"],
    ["kind:  chore", "maintenance"],
    ["kind/incident", "incident"],
  ])("compares %s without case and without its prefix", (label, kind) => {
    expect(classify({ labels: [label] }).kind).toBe(kind);
  });

  it.each([
    ["p0", "P0"],
    ["Critical", "P0"],
    ["urgent", "P0"],
    ["blocker", "P0"],
    ["P1", "P1"],
    ["high", "P1"],
    ["p2", "P2"],
    ["medium", "P2"],
    ["P3", "P3"],
    ["low", "P3"],
    ["p4", "P4"],
    ["lowest", "P4"],
    ["trivial", "P4"],
    ["priority: high", "P1"],
    ["priority/P2", "P2"],
    ["prio: critical", "P0"],
  ])("reads the label %s as priority %s", (label, priority) => {
    expect(classify({ labels: [label] }).priority).toBe(priority);
  });

  it.each([["ux"], ["dev-infra-ish"], ["bugfix"], ["priority"], ["good first issue"], ["high-risk"]])(
    "gives no kind or priority for the label %s, because names are compared whole",
    (label) => {
      expect(classify({ labels: [label] })).toEqual({ kind: "other", priority: null });
    },
  );

  it("gives other and no priority to an issue with nothing to read", () => {
    expect(classify({})).toEqual({ kind: "other", priority: null });
  });

  it("takes the most urgent priority when several are named", () => {
    expect(classify({ labels: ["low", "p1", "medium"] }).priority).toBe("P1");
  });
});

describe("classifyIssue precedence", () => {
  it.each([
    [["feature", "bug"], "bug"],
    [["bug", "incident"], "incident"],
    [["incident", "security"], "security"],
    [["security", "epic"], "epic"],
    [["chore", "feature"], "feature"],
    [["chore", "epic", "bug"], "epic"],
  ])("decides %j as %s", (labels, kind) => {
    expect(classify({ labels }).kind).toBe(kind);
  });
});

describe("classifyIssue by native type and title", () => {
  it.each([
    ["Bug", "bug"],
    ["Feature", "feature"],
    ["bug", "bug"],
  ])("reads the native type %s as %s", (issueType, kind) => {
    expect(classify({ issueType }).kind).toBe(kind);
  });

  it("lets the native type win over a label", () => {
    expect(classify({ issueType: "Bug", labels: ["feature"] }).kind).toBe("bug");
  });

  it("reads the labels when the native type names nothing, as a generic Task does", () => {
    expect(classify({ issueType: "Task", labels: ["enhancement"] }).kind).toBe("feature");
  });

  it("lets a label win over the title prefix", () => {
    expect(classify({ labels: ["enhancement"], title: "Bug: crash on save" }).kind).toBe("feature");
  });

  it.each([
    ["P2: Upgrade the build", "other", "P2"],
    ["[P1] Login fails", "other", "P1"],
    ["Security: Marketing site exposes a key", "security", null],
    ["Bug: Crash on save", "bug", null],
    ["[Bug] Crash on save", "bug", null],
    ["[P1] Security: Marketing site exposes a key", "security", "P1"],
    ["[P0][Incident] Checkout is down", "incident", "P0"],
    ["Feature: Dark mode", "feature", null],
    ["  bug : spaced", "bug", null],
    ["Crash on save: bug", "other", null],
    ["Bug fixes for the importer", "other", null],
    ["Upgrade: the build", "other", null],
  ])("reads the title %j as %s with priority %s", (title, kind, priority) => {
    expect(classify({ title })).toEqual({ kind, priority });
  });

  it("takes the kind from a label and the priority from the title", () => {
    expect(classify({ labels: ["bug"], title: "P2: Crash on save" })).toEqual({ kind: "bug", priority: "P2" });
  });

  it("lets a label priority win over a title priority", () => {
    expect(classify({ labels: ["p3"], title: "P0: Crash on save" }).priority).toBe("P3");
  });
});

describe("classifyIssue with an override", () => {
  it("replaces the default list for the key it names", () => {
    const rules = { kinds: { bug: ["defect-report"] } };
    expect(classify({ labels: ["defect-report"] }, rules).kind).toBe("bug");
    expect(classify({ labels: ["bug"] }, rules).kind).toBe("other");
  });

  it("leaves the other keys at their defaults", () => {
    const rules = { kinds: { bug: ["defect-report"] }, priorities: { P0: ["sev1"] } };
    expect(classify({ labels: ["enhancement"] }, rules).kind).toBe("feature");
    expect(classify({ labels: ["sev1"] }, rules).priority).toBe("P0");
    expect(classify({ labels: ["critical"] }, rules).priority).toBeNull();
    expect(classify({ labels: ["high"] }, rules).priority).toBe("P1");
  });

  it("compares override names without case and without a prefix", () => {
    expect(classify({ labels: ["type: Glitch"] }, { kinds: { bug: [" GLITCH "] } }).kind).toBe("bug");
  });

  it.each([[null], [undefined], [{}]])("uses the defaults for %j", (rules) => {
    expect(classify({ labels: ["bug"] }, rules).kind).toBe("bug");
  });

  it("applies an override to the title prefix as well", () => {
    expect(classify({ title: "Defect: crash" }, { kinds: { bug: ["defect"] } }).kind).toBe("bug");
  });

  it.each([[[]], [[" "]], [["", "type:"]]])("keeps the defaults for a key whose list %j names nothing", (names) => {
    // ADR 0028: an override replaces a key's names but can never switch the key off.
    expect(classify({ labels: ["bug"] }, { kinds: { bug: names } }).kind).toBe("bug");
    expect(classify({ labels: ["critical"] }, { priorities: { P0: names } }).priority).toBe("P0");
  });
});

describe("ISSUE_LABEL_LIMITS", () => {
  it("allows thirty names of up to a hundred characters for each key", () => {
    expect(ISSUE_LABEL_LIMITS).toEqual({ names: 30, length: 100 });
  });
});

describe("DEFAULT_ISSUE_LABELS", () => {
  it("names a list for every kind but other and every priority", () => {
    expect(Object.keys(DEFAULT_ISSUE_LABELS.kinds).sort()).toEqual([
      "bug",
      "epic",
      "feature",
      "incident",
      "maintenance",
      "security",
    ]);
    expect(Object.keys(DEFAULT_ISSUE_LABELS.priorities)).toEqual(["P0", "P1", "P2", "P3", "P4"]);
  });
});
