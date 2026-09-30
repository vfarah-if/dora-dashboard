import { describe, expect, it } from "vitest";
import { queueEntry, reviewQueue } from "../test/fixtures";
import {
  attentionEntries,
  bandSegments,
  filterEntries,
  flagFor,
  formatWait,
  groupByLane,
  lanesLine,
  reviewerNames,
  summaryText,
  tilesFor,
  isIdle,
  visibleFeatures,
  visibleLanes,
  waitingCount,
  type QueueFilters,
} from "./reviewQueue";

const open: QueueFilters = { waitingOn: "", search: "", showDrafts: true, showBots: true, repoIds: [] };

describe("formatWait", () => {
  it("shows hours under a day and whole weekdays from a day", () => {
    expect(formatWait(0.4)).toBe("under 1h");
    expect(formatWait(3.9)).toBe("3h");
    expect(formatWait(23.9)).toBe("23h");
    expect(formatWait(24)).toBe("1 weekday");
    expect(formatWait(59)).toBe("2 weekdays");
    expect(formatWait(288)).toBe("12 weekdays");
  });
});

describe("flagFor", () => {
  it("words a stale unreviewed pull request with its weekdays and reason", () => {
    expect(flagFor({ lane: "no_reviewer", band: "stale", waitHours: 288 })?.label).toBe("Stale, 12 weekdays, no reviewer");
  });

  it("words an overdue one awaiting review", () => {
    expect(flagFor({ lane: "awaiting_review", band: "overdue", waitHours: 30 })).toEqual({
      band: "overdue",
      label: "Over 24h, 1 weekday, awaiting review",
    });
  });

  it("does not flag fresh waits or lanes that are not waiting", () => {
    expect(flagFor({ lane: "awaiting_review", band: "ageing", waitHours: 6 })).toBeNull();
    expect(flagFor({ lane: "held", band: "stale", waitHours: 300 })).toBeNull();
  });
});

describe("filterEntries", () => {
  const entries = reviewQueue().entries;

  it("leaves out drafts and bots unless asked", () => {
    const keys = filterEntries(entries, { ...open, showDrafts: false, showBots: false }).map((e) => e.number);
    expect(keys).toEqual([10, 11, 12, 15]);
  });

  it("filters by the reviewer waited on", () => {
    expect(filterEntries(entries, { ...open, waitingOn: "robin" }).map((e) => e.number)).toEqual([11, 14, 15]);
  });

  it("searches title, repository, number and ticket", () => {
    expect(filterEntries(entries, { ...open, search: "billing" }).map((e) => e.number)).toEqual([10]);
    expect(filterEntries(entries, { ...open, search: "#12" }).map((e) => e.number)).toEqual([12]);
    expect(filterEntries(entries, { ...open, search: "acme-7" }).map((e) => e.number)).toEqual([10, 11]);
    expect(filterEntries(entries, { ...open, search: "acme/widgets" })).toHaveLength(entries.length);
  });

  it("keeps only the chosen repositories", () => {
    const other = queueEntry({ number: 1, repoId: 2, repo: "acme/gadgets" });
    expect(filterEntries([...entries, other], { ...open, repoIds: [2] })).toEqual([other]);
  });
});

describe("grouping helpers", () => {
  it("lists the held lane only when drafts are on", () => {
    expect(visibleLanes(false)).toEqual(["no_reviewer", "awaiting_review", "with_author", "approved"]);
    expect(visibleLanes(true)).toContain("held");
  });

  it("groups by lane and drops lanes that are not asked for", () => {
    const groups = groupByLane(reviewQueue().entries, visibleLanes(false));
    expect(groups.no_reviewer.map((e) => e.number)).toEqual([10]);
    expect(groups.held).toEqual([]);
  });

  it("lists reviewers once, sorted", () => {
    const entries = [
      queueEntry({
        requestedReviewers: [
          { name: "zed", isTeam: false },
          { name: "amy", isTeam: false },
        ],
      }),
      queueEntry({ number: 2, requestedReviewers: [{ name: "amy", isTeam: false }] }),
    ];
    expect(reviewerNames(entries)).toEqual(["amy", "zed"]);
  });

  it("keeps attention order and drops entries that are filtered out", () => {
    const queue = reviewQueue();
    expect(attentionEntries(queue, queue.entries).map((e) => e.number)).toEqual([10, 11]);
    expect(
      attentionEntries(
        queue,
        queue.entries.filter((e) => e.number === 11),
      ).map((e) => e.number),
    ).toEqual([11]);
  });

  it("orders band segments worst first and skips empty bands", () => {
    const summary = { bands: { fresh: 0, ageing: 2, overdue: 0, stale: 1 } };
    expect(bandSegments(summary)).toEqual([
      { band: "stale", count: 1 },
      { band: "ageing", count: 2 },
    ]);
    expect(waitingCount(summary)).toBe(3);
  });

  it("describes lanes in one line", () => {
    expect(lanesLine({ lanes: { held: 0, with_author: 0, approved: 1, awaiting_review: 0, no_reviewer: 2 } })).toBe(
      "2 no reviewer, 1 approved",
    );
  });

  it("drops feature members that are filtered out and features left with fewer than two", () => {
    const queue = reviewQueue();
    expect(visibleFeatures(queue.features, queue.entries)).toHaveLength(1);
    expect(
      visibleFeatures(
        queue.features,
        queue.entries.filter((e) => e.number !== 11),
      ),
    ).toEqual([]);
  });
});

describe("summaryText", () => {
  const queue = reviewQueue();

  it("carries the headline, the urgent pull requests and no names by default", () => {
    const text = summaryText(queue, queue.entries, false);
    expect(text).toContain("Review queue, 3 waiting across 1 repository");
    expect(text).toContain("1 stale, 2 over 24h, 1 with no reviewer");
    expect(text).toContain("acme/widgets#10 Rework billing, Stale, 12 weekdays, no reviewer");
    expect(text).not.toContain("casey");
    expect(text).not.toContain("robin");
  });

  it("adds authors and reviewers when names are shown", () => {
    const text = summaryText(queue, queue.entries, true);
    expect(text).toContain("by casey");
    expect(text).toContain("waiting on robin");
  });

  it("says so when nothing is urgent", () => {
    expect(summaryText(queue, [], false)).toContain("Nothing needs urgent attention.");
  });
});

describe("tilesFor", () => {
  it("works the tiles out from the entries given", () => {
    const all = reviewQueue().entries;
    const tiles = tilesFor(all);
    expect(tiles.waiting).toEqual({ count: 3, repos: 1, heldForRedChecks: 1 });
    expect(tiles.pastDay).toEqual({ count: 2, longestHours: 288 });
    expect(tiles.noReviewer).toEqual({ count: 1, oldestHours: 288 });
    expect(tiles.stale).toEqual({ count: 1, longestHours: 288 });
    expect(tiles.fastLane.count).toBe(3);
  });

  it("follows a filter and reports no longest wait when nothing matches", () => {
    const visible = filterEntries(reviewQueue().entries, { ...open, search: "docs" });
    const tiles = tilesFor(visible);
    expect(tiles.waiting.count).toBe(0);
    expect(tiles.stale).toEqual({ count: 0, longestHours: null });
  });

  it("leaves big changes out of the fast lane and counts idle ones", () => {
    const big = queueEntry({ additions: 390, deletions: 20, idleDays: 20 });
    const wide = queueEntry({ number: 2, changedFiles: 10 });
    const tiles = tilesFor([big, wide]);
    expect(tiles.fastLane.count).toBe(0);
    expect(tiles.idle.count).toBe(1);
    expect(isIdle({ idleDays: 13 })).toBe(false);
    expect(isIdle({ idleDays: 14 })).toBe(true);
  });
});
