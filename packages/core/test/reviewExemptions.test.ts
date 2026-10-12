import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_EXEMPTIONS,
  ExemptionMatcher,
  REVIEW_EXEMPTION_DEFAULTS,
  REVIEW_EXEMPTION_LIMITS,
  exemptionMatcher,
  hasAnyReview,
  isReviewExempt,
  unreviewedFigures,
  wordsOf,
} from "../src/reviewExemptions.js";
import { buildReport } from "../src/report.js";
import type { PullRequest, Repo, Review } from "../src/types.js";

const MERGED = "2026-09-01T14:00:00Z";

function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `Change ${overrides.number}`,
    url: `https://github.com/acme/widgets/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: MERGED,
    closedAt: MERGED,
    updatedAt: MERGED,
    mergedBy: "alice",
    additions: 10,
    deletions: 5,
    firstCommitAt: "2026-09-01T08:00:00Z",
    baseRef: "main",
    reviews: [],
    ...overrides,
  };
}

const review = (
  author: string | null,
  state: Review["state"],
  submittedAt: string | null,
  extra: Partial<Review> = {},
): Review => ({
  author,
  state,
  submittedAt,
  ...extra,
});

const repo: Repo = {
  id: 1,
  owner: "acme",
  name: "widgets",
  deployWorkflows: ["deploy.yml"],
  deployBranch: "main",
  addedAt: "2026-09-01T00:00:00Z",
  lastCrawledAt: null,
  crawlStatus: "idle",
  crawlError: null,
  crawlProgress: null,
};

describe("the defaults", () => {
  it("name the sync spellings and one label, and the limits travel with them for the web", () => {
    expect(DEFAULT_REVIEW_EXEMPTIONS.titleWords).toEqual([
      "sync",
      "synced",
      "syncing",
      "synchronise",
      "synchronised",
      "synchronize",
      "synchronized",
      "syncronise",
      "syncronize",
    ]);
    expect(DEFAULT_REVIEW_EXEMPTIONS.labels).toEqual(["reviewed-elsewhere"]);
    expect(REVIEW_EXEMPTION_DEFAULTS).toEqual({ ...DEFAULT_REVIEW_EXEMPTIONS, limits: REVIEW_EXEMPTION_LIMITS });
    expect(REVIEW_EXEMPTION_LIMITS).toEqual({ titleWords: 30, labels: 30, length: 100 });
  });

  it("are frozen, so no caller can change them for every other one", () => {
    for (const shared of [
      DEFAULT_REVIEW_EXEMPTIONS,
      DEFAULT_REVIEW_EXEMPTIONS.titleWords,
      DEFAULT_REVIEW_EXEMPTIONS.labels,
      REVIEW_EXEMPTION_DEFAULTS,
      REVIEW_EXEMPTION_DEFAULTS.limits,
      REVIEW_EXEMPTION_LIMITS,
    ]) {
      expect(Object.isFrozen(shared)).toBe(true);
    }
    expect(() => (DEFAULT_REVIEW_EXEMPTIONS.labels as string[]).push("anything")).toThrow(TypeError);
    expect(isReviewExempt({ title: "Add widget", labels: ["anything"] }, exemptionMatcher())).toBe(false);
  });
});

describe("exemptionMatcher", () => {
  it("is built only from rules, which it lowers itself, so labels saved in any case match", () => {
    const matcher = exemptionMatcher({ titleWords: ["Vendor Sync"], labels: ["Reviewed-Elsewhere"] });
    expect(matcher).toBeInstanceOf(ExemptionMatcher);
    expect(isReviewExempt({ title: "Add widget", labels: ["REVIEWED-ELSEWHERE"] }, matcher)).toBe(true);
    expect(isReviewExempt({ title: "vendor SYNC for May", labels: null }, matcher)).toBe(true);
  });

  it("shows none of its parts, so a hand-made object of words and labels cannot stand in for one", () => {
    expect(Object.keys(exemptionMatcher())).toEqual([]);
    const handMade = { phrases: [], labels: new Set(["Reviewed-Elsewhere"]) };
    // @ts-expect-error a plain object of parts is not a matcher
    expect(() => isReviewExempt({ title: "Add widget", labels: ["Reviewed-Elsewhere"] }, handMade)).toThrow(TypeError);
  });
});

describe("wordsOf", () => {
  it.each([
    ["Sync shared library, 23 September", ["sync", "shared", "library", "23", "september"]],
    ["(SYNC)", ["sync"]],
    ["re-sync/vendor_code", ["re", "sync", "vendor", "code"]],
    ["", []],
    ["!!!", []],
  ])("splits %j into %j", (text, words) => {
    expect(wordsOf(text)).toEqual(words);
  });
});

describe("isReviewExempt by title", () => {
  const exempt = (title: string, rules = null as Parameters<typeof exemptionMatcher>[0]) =>
    isReviewExempt({ title, labels: null }, exemptionMatcher(rules));

  it.each([
    "sync shared library 23 September",
    "Synchronise the vendored copy",
    "syncronise tooling",
    "Vendor SYNC",
    "Weekly sync: refresh",
    "[sync] update",
    "Sync.",
  ])("exempts %j, which holds a default word whole", (title) => {
    expect(exempt(title)).toBe(true);
  });

  it.each(["Async queue", "Resync nothing", "Syncpoint", "Add widget", "Desync fix"])(
    "does not exempt %j, because the word is only part of a longer one",
    (title) => {
      expect(exempt(title)).toBe(false);
    },
  );

  it("uses only the saved words once an override exists", () => {
    const rules = { titleWords: ["mirror"], labels: [] };
    expect(exempt("Mirror upstream", rules)).toBe(true);
    expect(exempt("Sync upstream", rules)).toBe(false);
  });

  it("matches a phrase as consecutive whole words", () => {
    const rules = { titleWords: ["vendor update"], labels: [] };
    expect(exempt("Run vendor, update done", rules)).toBe(true);
    expect(exempt("Update the vendor", rules)).toBe(false);
  });

  it("treats a word that is only punctuation as no word, so it exempts nothing", () => {
    expect(exempt("Anything at all", { titleWords: ["--", ""], labels: [] })).toBe(false);
  });

  it("never runs a word as a pattern", () => {
    const rules = { titleWords: [".*", "(a+)+$"], labels: [] };
    expect(exempt("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", rules)).toBe(false);
  });

  it("falls back to the defaults for null rules", () => {
    expect(exempt("sync it", null)).toBe(true);
  });
});

describe("isReviewExempt by label", () => {
  const exempt = (labels: string[] | null | undefined, rules?: Parameters<typeof exemptionMatcher>[0]) =>
    isReviewExempt({ title: "Add widget", labels }, exemptionMatcher(rules));

  it("exempts the default label without regard to case or surrounding spaces", () => {
    expect(exempt(["Reviewed-Elsewhere"])).toBe(true);
    expect(exempt(["  reviewed-elsewhere "])).toBe(true);
  });

  it("does not exempt other labels, or a pull request crawled before labels were recorded", () => {
    expect(exempt(["reviewed"])).toBe(false);
    expect(exempt([])).toBe(false);
    expect(exempt(null)).toBe(false);
    expect(exempt(undefined)).toBe(false);
  });

  it("uses only the saved labels once an override exists, and ignores a blank one", () => {
    const rules = { titleWords: [], labels: ["Vendored", "  "] };
    expect(exempt(["vendored"], rules)).toBe(true);
    expect(exempt(["reviewed-elsewhere"], rules)).toBe(false);
    expect(exempt([""], rules)).toBe(false);
  });

  it("compares a label whole, never as a pattern", () => {
    expect(exempt(["reviewed-elsewhere-not"])).toBe(false);
    expect(exempt(["x"], { titleWords: [], labels: [".*"] })).toBe(false);
  });
});

describe("hasAnyReview", () => {
  const reviewed = (reviews: Review[], mergedAt: string | null = MERGED) => hasAnyReview({ reviews, mergedAt });

  it("counts a review by the author, because a tool posts its review under the author's account", () => {
    expect(reviewed([review("alice", "COMMENTED", "2026-09-01T13:00:00Z")])).toBe(true);
  });

  it("counts any state that was submitted", () => {
    for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const) {
      expect(reviewed([review("bob", state, "2026-09-01T12:00:00Z")])).toBe(true);
    }
  });

  it("does not count a pending review, one without a time, or one after the merge", () => {
    expect(reviewed([review("bob", "PENDING", "2026-09-01T12:00:00Z")])).toBe(false);
    expect(reviewed([review("bob", "COMMENTED", null)])).toBe(false);
    expect(reviewed([review("bob", "APPROVED", "2026-09-01T14:00:01Z")])).toBe(false);
  });

  it("counts a review at the very moment of the merge", () => {
    expect(reviewed([review("bob", "APPROVED", MERGED)])).toBe(true);
  });

  it("does not count a bot, whether the host said so or the login shows it", () => {
    expect(reviewed([review("helper", "COMMENTED", "2026-09-01T12:00:00Z", { authorIsBot: true })])).toBe(false);
    expect(reviewed([review("copilot[bot]", "COMMENTED", "2026-09-01T12:00:00Z")])).toBe(false);
    expect(reviewed([review("renovate-helper", "COMMENTED", "2026-09-01T12:00:00Z", { authorIsBot: false })])).toBe(true);
  });

  it("counts a reviewer whose account is gone, since nothing says it was a bot", () => {
    expect(reviewed([review(null, "APPROVED", "2026-09-01T12:00:00Z")])).toBe(true);
  });

  it("is false with no reviews, and for a pull request that was never merged", () => {
    expect(reviewed([])).toBe(false);
    expect(reviewed([review("bob", "APPROVED", "2026-09-01T12:00:00Z")], null)).toBe(false);
  });
});

describe("unreviewedFigures", () => {
  it("is null for the share when nothing is left to count, and counts nothing", () => {
    expect(unreviewedFigures([])).toEqual({ unreviewedCount: 0, unreviewedShare: null, exemptCount: 0 });
    expect(unreviewedFigures([pr({ number: 1, title: "sync" })])).toEqual({
      unreviewedCount: 0,
      unreviewedShare: null,
      exemptCount: 1,
    });
  });

  it("divides by the pull requests that are not exempt", () => {
    // Four merged: one reviewed, one not, and two exempt (one by title that was reviewed anyway, one by label).
    const merged = [
      pr({ number: 1, reviews: [review("bob", "APPROVED", "2026-09-01T12:00:00Z")] }),
      pr({ number: 2 }),
      pr({ number: 3, title: "Sync shared library", reviews: [review("bob", "APPROVED", "2026-09-01T12:00:00Z")] }),
      pr({ number: 4, labels: ["reviewed-elsewhere"] }),
    ];
    expect(unreviewedFigures(merged)).toEqual({ unreviewedCount: 1, unreviewedShare: 1 / 2, exemptCount: 2 });
  });

  it("follows the rules it is given", () => {
    const merged = [pr({ number: 1, title: "Sync a" }), pr({ number: 2 })];
    expect(unreviewedFigures(merged, { titleWords: [], labels: [] })).toEqual({
      unreviewedCount: 2,
      unreviewedShare: 1,
      exemptCount: 0,
    });
    expect(unreviewedFigures(merged, null)).toEqual({ unreviewedCount: 1, unreviewedShare: 1, exemptCount: 1 });
  });
});

describe("the report's no review figure", () => {
  const prs = [
    pr({ number: 1, title: "Add widget" }), // nobody reviewed it
    pr({ number: 2, reviews: [review("alice", "COMMENTED", "2026-09-01T13:00:00Z")] }), // the author's own account
    pr({ number: 3, title: "Sync shared library 23 September" }), // exempt by title
    pr({ number: 4, labels: ["Reviewed-Elsewhere"] }), // exempt by label
    pr({ number: 5, reviews: [review("helper", "APPROVED", "2026-09-01T12:00:00Z", { authorIsBot: true })] }), // a bot only
    pr({ number: 6, reviews: [review("bob", "APPROVED", "2026-09-01T15:00:00Z")] }), // after the merge
    pr({ number: 7, reviews: [review("bob", "PENDING", "2026-09-01T12:00:00Z")] }), // never submitted
    pr({ number: 8, title: "Syncing vendor", reviews: [review("bob", "APPROVED", "2026-09-01T12:00:00Z")] }), // exempt and reviewed
    pr({ number: 9, reviews: [review("bob", "CHANGES_REQUESTED", "2026-09-01T12:00:00Z")] }), // reviewed
    pr({ number: 10, author: "dependabot[bot]", authorIsBot: true }), // not in scope
    pr({ number: 11, state: "OPEN", mergedAt: null, closedAt: null }), // not merged
  ];
  const totals = (options: Parameters<typeof buildReport>[3] = {}) =>
    buildReport(repo, prs, [], { to: "2026-09-13", ...options }).totals;

  it("counts merges no account reviewed, leaving out the exempt, with the default rules", () => {
    // Merged in scope: 1 to 9. Exempt: 3, 4, 8. Counted: 1, 2, 5, 6, 7, 9. No review: 1, 5, 6, 7.
    expect(totals()).toMatchObject({ merged: 9, unreviewedCount: 4, unreviewedShare: 4 / 6, exemptCount: 3 });
  });

  it("leaves the reviewed and self merged shares as they were", () => {
    // Reviewed by someone else, bots included and times ignored: 5, 6, 8, 9. Merged by their own author: all nine.
    expect(totals()).toMatchObject({ reviewedShare: 4 / 9, selfMergedShare: 1 });
  });

  it("follows a repository's rules at once", () => {
    // Only "widget" exempts: pull request 1 leaves, and 3, 4 and 8 count. Counted: 2 to 9. No review: 3, 4, 5, 6, 7.
    expect(totals({ reviewExemptions: { titleWords: ["widget"], labels: [] } })).toMatchObject({
      unreviewedCount: 5,
      unreviewedShare: 5 / 8,
      exemptCount: 1,
    });
  });

  it("leaves out the authors the report leaves out", () => {
    const report = buildReport(repo, prs, [], { to: "2026-09-13", excludeAuthors: ["alice"] });
    expect(report.totals).toMatchObject({ merged: 0, unreviewedCount: 0, unreviewedShare: null, exemptCount: 0 });
  });
});
