import { describe, expect, it } from "vitest";
import { REVIEW_LIST_LIMIT, reviewControls } from "../src/reviewControls.js";
import type { PullRequest, Review } from "../src/types.js";
import { pr } from "./issue.js";

const NOW = "2026-10-07T12:00:00Z";
const window = { from: "2026-07-09T12:00:00Z", to: NOW, deployBranch: "main", now: NOW };
const MERGED = "2026-09-01T14:00:00Z";

const approval = (overrides: Partial<Review> = {}): Review => ({
  author: "bob",
  state: "APPROVED",
  submittedAt: "2026-09-01T13:00:00Z",
  ...overrides,
});
const reviewed = (n: number, overrides: Partial<PullRequest> = {}) =>
  pr({ number: n, reviews: [approval()], mergedAt: MERGED, ...overrides });
const run = (prs: PullRequest[], overrides: Partial<typeof window> = {}) => reviewControls(prs, { ...window, ...overrides });

describe("which merges count", () => {
  it.each([
    ["merged in the window", {}, 1],
    ["merged on the first instant of the window", { mergedAt: "2026-07-09T12:00:00Z" }, 1],
    ["merged on the last instant of the window", { mergedAt: NOW }, 1],
    ["merged before the window", { mergedAt: "2026-07-09T11:59:59Z" }, 0],
    ["merged after the window", { mergedAt: "2026-10-07T12:00:01Z" }, 0],
    ["not merged", { mergedAt: null, state: "CLOSED" as const }, 0],
    ["merged into another branch", { baseRef: "develop" }, 0],
    ["opened by a bot flag", { authorIsBot: true }, 0],
    ["opened by a bot login", { author: "dependabot[bot]" }, 0],
    ["opened by renovate", { author: "renovate" }, 0],
  ] as [string, Partial<PullRequest>, number][])("%s gives %i", (_name, overrides, merged) => {
    expect(run([pr({ number: 1, mergedAt: MERGED, ...overrides })]).merged).toBe(merged);
  });

  it("never reaches past now, whatever the window says", () => {
    const later = pr({ number: 1, mergedAt: "2026-10-08T00:00:00Z" });
    expect(run([later], { to: "2026-10-09T00:00:00Z" }).merged).toBe(0);
  });
});

describe("what counts as an approval", () => {
  it.each([
    ["an approval from another person before the merge", approval(), false],
    ["an approval at the very instant of the merge", approval({ submittedAt: MERGED }), false],
    ["an approval a second after the merge", approval({ submittedAt: "2026-09-01T14:00:01Z" }), true],
    ["the author approving their own work", approval({ author: "alice" }), true],
    ["the author's login in other letters", approval({ author: "ALICE" }), true],
    ["a bot flagged as one", approval({ author: "helper", authorIsBot: true }), true],
    ["a bot known only by its login", approval({ author: "copilot[bot]" }), true],
    [
      "a person whose login looks like a bot but is flagged as one not",
      approval({ author: "dependabot-fan", authorIsBot: false }),
      false,
    ],
    ["a dismissed approval", approval({ state: "DISMISSED" }), true],
    ["a comment", approval({ state: "COMMENTED" }), true],
    ["a change request", approval({ state: "CHANGES_REQUESTED" }), true],
    ["an approval without a date", approval({ submittedAt: null }), true],
    ["an approval without an author", approval({ author: null }), true],
  ] as [string, Review, boolean][])("%s leaves unapproved=%s", (_name, review, unapproved) => {
    const result = run([pr({ number: 1, mergedAt: MERGED, reviews: [review] })]);
    expect(result.unapproved).toBe(unapproved ? 1 : 0);
  });

  it("accepts a second reviewer when the first does not count", () => {
    const result = run([
      pr({ number: 1, mergedAt: MERGED, reviews: [approval({ author: "alice" }), approval({ author: "carol" })] }),
    ]);
    expect(result.unapproved).toBe(0);
  });

  it("treats a pull request with no reviews as unapproved", () => {
    expect(run([pr({ number: 1, mergedAt: MERGED })]).unapproved).toBe(1);
  });
});

describe("the figures", () => {
  it("gives a null share when nothing merged", () => {
    expect(run([])).toMatchObject({
      merged: 0,
      authors: 0,
      unapproved: 0,
      share: null,
      graded: false,
      notGradedBecause: "too_few",
    });
  });

  it("counts authors without regard to case and ignores bots and merges outside the scope", () => {
    const result = run([
      reviewed(1, { author: "alice" }),
      reviewed(2, { author: "ALICE" }),
      reviewed(3, { author: "bob", reviews: [approval({ author: "alice" })] }),
      reviewed(4, { author: "dependabot[bot]" }),
    ]);
    expect(result.authors).toBe(2);
    expect(result.merged).toBe(3);
  });

  it("computes the share as unapproved over merged and counts self merges among the unapproved", () => {
    const result = run([
      pr({ number: 1, mergedAt: MERGED, mergedBy: "alice" }), // unapproved, self merged
      pr({ number: 2, mergedAt: MERGED, mergedBy: "bob" }), // unapproved, merged by someone else
      reviewed(3, { mergedBy: "alice" }), // approved, self merged: not counted
      reviewed(4),
    ]);
    expect(result).toMatchObject({ merged: 4, unapproved: 2, selfMergedUnapproved: 1, share: 0.5 });
    expect(result.pullRequests.map((p) => [p.number, p.selfMerged])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it("lists unapproved merges newest first, and never a login", () => {
    const result = run([
      pr({ number: 1, mergedAt: "2026-09-01T14:00:00Z" }),
      pr({ number: 2, mergedAt: "2026-09-03T14:00:00Z" }),
      pr({ number: 3, mergedAt: "2026-09-03T14:00:00Z" }),
    ]);
    expect(result.pullRequests.map((p) => p.number)).toEqual([3, 2, 1]);
    expect(result.pullRequests[0]).toEqual({
      number: 3,
      title: "PR 3",
      url: "https://github.com/acme/widgets/pull/3",
      mergedAt: "2026-09-03T14:00:00Z",
      selfMerged: true,
    });
    expect(JSON.stringify(result)).not.toContain("alice");
  });

  it("lists at most 50 and still counts them all", () => {
    const many = Array.from({ length: 60 }, (_, i) => pr({ number: i + 1, mergedAt: MERGED }));
    const result = run(many);
    expect(result.unapproved).toBe(60);
    expect(result.pullRequests).toHaveLength(REVIEW_LIST_LIMIT);
  });

  it("echoes the window it was asked for", () => {
    expect(run([])).toMatchObject({ from: window.from, to: window.to });
  });
});

describe("when the share is graded", () => {
  const merges = (count: number, authorOf: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => reviewed(i + 1, { author: authorOf(i) }));

  it.each([
    [9, 2, false, "too_few"],
    [10, 2, true, null],
    [25, 2, true, null],
    [10, 1, false, "single_author"],
    [9, 1, false, "too_few"],
  ] as const)("%i merges by %i author(s) graded=%s", (count, authors, graded, because) => {
    const result = run(merges(count, (i) => `author${i % authors}`));
    expect(result.graded).toBe(graded);
    expect(result.notGradedBecause).toBe(because);
  });
});
