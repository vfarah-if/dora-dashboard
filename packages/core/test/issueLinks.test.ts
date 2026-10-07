import { describe, expect, it } from "vitest";
import { linkIssues } from "../src/issueLinks.js";
import { issue, pr } from "./issue.js";

const repo = { owner: "acme", name: "widgets" };
/** Issues 10, 11 and 12 exist from the start of September; the pull requests below are numbered after them. */
const issues = [10, 11, 12].map((number) => issue({ number }));
const linkedTo = (found: ReturnType<typeof linkIssues>, number: number) => found.byIssue.get(number)!.map((p) => p.number);

describe("linkIssues", () => {
  it("gives every issue an entry, empty when nothing is linked", () => {
    const found = linkIssues(repo, issues, [pr({ number: 20 })]);
    expect([...found.byIssue]).toEqual([
      [10, []],
      [11, []],
      [12, []],
    ]);
    expect(found.linkedPrNumbers.size).toBe(0);
  });

  describe("by closing reference", () => {
    it("links a stored pull request the issue names", () => {
      const found = linkIssues(
        repo,
        [issue({ number: 10, closedBy: [{ repo: "acme/widgets", number: 20 }] })],
        [pr({ number: 20 })],
      );
      expect(linkedTo(found, 10)).toEqual([20]);
      expect([...found.linkedPrNumbers]).toEqual([20]);
    });

    it("compares the repository without case", () => {
      const found = linkIssues(
        repo,
        [issue({ number: 10, closedBy: [{ repo: "Acme/Widgets", number: 20 }] })],
        [pr({ number: 20 })],
      );
      expect(linkedTo(found, 10)).toEqual([20]);
    });

    it("ignores a pull request of another repository with the same number", () => {
      const found = linkIssues(
        repo,
        [issue({ number: 10, closedBy: [{ repo: "acme/gadgets", number: 20 }] })],
        [pr({ number: 20 })],
      );
      expect(linkedTo(found, 10)).toEqual([]);
    });

    it("ignores a reference to a pull request that is not stored", () => {
      const found = linkIssues(repo, [issue({ number: 10, closedBy: [{ repo: "acme/widgets", number: 99 }] })], []);
      expect(linkedTo(found, 10)).toEqual([]);
    });

    it("needs no date check, so a pull request opened before the issue still links", () => {
      const found = linkIssues(
        repo,
        [issue({ number: 10, createdAt: "2026-09-10T09:00:00Z", closedBy: [{ repo: "acme/widgets", number: 20 }] })],
        [pr({ number: 20, createdAt: "2026-09-02T09:00:00Z" })],
      );
      expect(linkedTo(found, 10)).toEqual([20]);
    });
  });

  describe("by title", () => {
    it.each([
      ["Fix crash (#10)", [10]],
      ["#10 fix crash", [10]],
      ["Fixes #10 and #11", [10, 11]],
      ["Fix crash #10.", [10]],
      ["Fix crash#10", []],
      ["Fix crash #100", []],
      ["Fix crash #1", []],
      ["Fix crash #99", []],
      ["Fix crash 10", []],
    ])("reads %j as issues %j", (title, expected) => {
      const found = linkIssues(repo, issues, [pr({ number: 20, title })]);
      expect(issues.map((i) => i.number).filter((n) => linkedTo(found, n).includes(20))).toEqual(expected);
    });

    it("ignores a number that is a pull request rather than an issue", () => {
      const found = linkIssues(repo, issues, [pr({ number: 21 }), pr({ number: 22, title: "Follow up to #21" })]);
      expect(found.linkedPrNumbers.size).toBe(0);
    });

    it("ignores an issue opened after the pull request", () => {
      const late = issue({ number: 13, createdAt: "2026-09-01T10:00:01Z" });
      const found = linkIssues(repo, [late], [pr({ number: 20, title: "Fix #13", createdAt: "2026-09-01T10:00:00Z" })]);
      expect(linkedTo(found, 13)).toEqual([]);
    });

    it("links an issue opened at the same instant as the pull request", () => {
      const same = issue({ number: 13, createdAt: "2026-09-01T10:00:00Z" });
      const found = linkIssues(repo, [same], [pr({ number: 20, title: "Fix #13", createdAt: "2026-09-01T10:00:00Z" })]);
      expect(linkedTo(found, 13)).toEqual([20]);
    });
  });

  describe("by branch", () => {
    it.each([
      ["feat/10-tts-gating", true],
      ["fix/issue-10-crash", true],
      ["10-quick-fix", true],
      ["feat/10", true],
      ["feat/10_underscore", true],
      ["feat/Issue-10-Crash", true],
      ["feat/crash-10", true],
      ["feat/v10-crash", false],
      ["feat/100-crash", false],
      ["feat/a10b", false],
      ["feat/1.10.0", false],
      ["release/2026-09-01", false],
      ["release/v2.10.1", false],
      ["feat/crash-fix", false],
    ])("reads the branch %s as a link to issue 10: %s", (headRef, linked) => {
      const found = linkIssues(repo, [issue({ number: 10 })], [pr({ number: 20, headRef })]);
      expect(linkedTo(found, 10)).toEqual(linked ? [20] : []);
    });

    it("ignores a branch number that is a pull request", () => {
      const found = linkIssues(repo, issues, [pr({ number: 21 }), pr({ number: 22, headRef: "fix/21-follow-up" })]);
      expect(found.linkedPrNumbers.size).toBe(0);
    });

    it("ignores an issue opened after the pull request", () => {
      const late = issue({ number: 13, createdAt: "2026-09-02T00:00:00Z" });
      const found = linkIssues(repo, [late], [pr({ number: 20, headRef: "feat/13-late" })]);
      expect(linkedTo(found, 13)).toEqual([]);
    });

    it("copes with a pull request that has no recorded branch", () => {
      const found = linkIssues(repo, issues, [pr({ number: 20 }), pr({ number: 21, headRef: undefined })]);
      expect(found.linkedPrNumbers.size).toBe(0);
    });
  });

  describe("date shapes and issues closed before the pull request", () => {
    const years = [issue({ number: 2025 }), issue({ number: 2026 })];

    it.each(["release/2026-10-07", "backup/2025-03-01", "backup/2025_03_01"])(
      "does not read the date in %s as an issue number",
      (headRef) => {
        const found = linkIssues(repo, years, [pr({ number: 3000, headRef })]);
        expect(found.linkedPrNumbers.size).toBe(0);
      },
    );

    it("still links a number followed by a word, an underscore word or a slash", () => {
      const found = linkIssues(repo, years, [
        pr({ number: 3000, headRef: "feat/2026-tts" }),
        pr({ number: 3001, headRef: "feat/2025_tts" }),
        pr({ number: 3002, headRef: "feat/2025/part" }),
      ]);
      expect(linkedTo(found, 2026)).toEqual([3000]);
      expect(linkedTo(found, 2025)).toEqual([3001, 3002]);
    });

    const closedBefore = issue({
      number: 22,
      state: "closed",
      closeReason: "completed",
      createdAt: "2026-09-01T09:00:00Z",
      closedAt: "2026-09-02T09:00:00Z",
    });
    const opened = "2026-09-03T09:00:00Z";

    it("skips an issue already closed when the pull request was created, by branch and by title", () => {
      const found = linkIssues(
        repo,
        [closedBefore],
        [
          pr({ number: 30, headRef: "deps/node-22", createdAt: opened }),
          pr({ number: 31, title: "Bump node, see #22", createdAt: opened }),
        ],
      );
      expect(linkedTo(found, 22)).toEqual([]);
    });

    it("links an issue closed after the pull request was created", () => {
      const found = linkIssues(
        repo,
        [closedBefore],
        [pr({ number: 30, headRef: "deps/node-22", createdAt: "2026-09-01T12:00:00Z" })],
      );
      expect(linkedTo(found, 22)).toEqual([30]);
    });

    it("links an issue that was reopened and closed again after the pull request was created", () => {
      const again = { ...closedBefore, closedAt: "2026-09-05T09:00:00Z" };
      const found = linkIssues(repo, [again], [pr({ number: 30, headRef: "deps/node-22", createdAt: opened })]);
      expect(linkedTo(found, 22)).toEqual([30]);
    });

    it("still links by closing reference, whatever the dates", () => {
      const found = linkIssues(
        repo,
        [{ ...closedBefore, closedBy: [{ repo: "acme/widgets", number: 30 }] }],
        [pr({ number: 30, createdAt: opened })],
      );
      expect(linkedTo(found, 22)).toEqual([30]);
    });
  });

  it("counts a pull request once when title, branch and closing reference all name the issue", () => {
    const found = linkIssues(
      repo,
      [issue({ number: 10, closedBy: [{ repo: "acme/widgets", number: 20 }] })],
      [pr({ number: 20, title: "Fix #10", headRef: "fix/10-crash" })],
    );
    expect(linkedTo(found, 10)).toEqual([20]);
  });

  it("lists an issue's pull requests in number order and records every linked number", () => {
    const found = linkIssues(repo, issues, [
      pr({ number: 30, title: "Again #10" }),
      pr({ number: 20, title: "First #10" }),
      pr({ number: 25, headRef: "feat/11-other" }),
    ]);
    expect(linkedTo(found, 10)).toEqual([20, 30]);
    expect(linkedTo(found, 11)).toEqual([25]);
    expect([...found.linkedPrNumbers].sort()).toEqual([20, 25, 30]);
  });

  it("links one pull request to two issues when it names both", () => {
    const found = linkIssues(repo, issues, [pr({ number: 20, title: "Fix #10", headRef: "feat/11-both" })]);
    expect(linkedTo(found, 10)).toEqual([20]);
    expect(linkedTo(found, 11)).toEqual([20]);
  });

  describe("bots", () => {
    it.each([
      ["a flagged bot", { authorIsBot: true }],
      ["a [bot] login", { author: "release[bot]" }],
      ["dependabot", { author: "dependabot-preview" }],
    ])("ignores %s by title, branch and closing reference", (_name, bot) => {
      const found = linkIssues(
        repo,
        [issue({ number: 10, closedBy: [{ repo: "acme/widgets", number: 20 }] }), issue({ number: 11 })],
        [pr({ number: 20, ...bot }), pr({ number: 21, title: "Bump, see #11", headRef: "deps/11-bump", ...bot })],
      );
      expect(found.linkedPrNumbers.size).toBe(0);
    });
  });
});
