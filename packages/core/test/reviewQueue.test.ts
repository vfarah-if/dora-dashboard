import { describe, expect, it } from "vitest";
import { buildReviewQueue, reviewLane, waitBand, waitingSince } from "../src/reviewQueue.js";
import { weekdayHoursBetween } from "../src/stats.js";
import type { Review } from "../src/types.js";
import { open } from "./openPr.js";

const review = (author: string, state: Review["state"], submittedAt: string): Review => ({ author, state, submittedAt });
const asked = (name: string) => ({ name, isTeam: false });

// 2026-09-25 is a Friday, 2026-09-28 a Monday, 2026-09-30 a Wednesday.
describe("weekdayHoursBetween", () => {
  it("counts Friday 16:00 to Monday 10:00 as 18 hours", () => {
    // 8h of Friday, nothing on the weekend, 10h of Monday
    expect(weekdayHoursBetween("2026-09-25T16:00:00Z", "2026-09-28T10:00:00Z")).toBe(18);
  });

  it("counts a span inside the weekend as nothing", () => {
    expect(weekdayHoursBetween("2026-09-26T08:00:00Z", "2026-09-27T20:00:00Z")).toBe(0);
  });

  it("counts a span inside one weekday as the wall clock", () => {
    expect(weekdayHoursBetween("2026-09-29T09:30:00Z", "2026-09-29T11:00:00Z")).toBe(1.5);
  });

  it("counts two whole working weeks as 240 hours", () => {
    // Mon 14 Sep 09:00 to Mon 28 Sep 09:00: 111h + 120h + 9h
    expect(weekdayHoursBetween("2026-09-14T09:00:00Z", "2026-09-28T09:00:00Z")).toBe(240);
  });

  it("starts counting at Monday midnight when the span begins on a Sunday", () => {
    expect(weekdayHoursBetween("2026-09-27T12:00:00Z", "2026-09-28T03:00:00Z")).toBe(3);
  });

  it.each([
    ["the same instant", "2026-09-29T09:00:00Z", "2026-09-29T09:00:00Z"],
    ["an end before the start", "2026-09-29T09:00:00Z", "2026-09-28T09:00:00Z"],
    ["an unreadable date", "nonsense", "2026-09-28T09:00:00Z"],
  ])("is zero for %s", (_name, from, to) => {
    expect(weekdayHoursBetween(from, to)).toBe(0);
  });
});

describe("waitBand", () => {
  it.each([
    [0, "fresh"],
    [3.99, "fresh"],
    [4, "ageing"],
    [24, "ageing"],
    [24.01, "overdue"],
    [119.99, "overdue"],
    [120, "stale"],
    [300, "stale"],
  ] as const)("puts %s weekday hours in %s", (hours, band) => {
    expect(waitBand(hours)).toBe(band);
  });
});

describe("reviewLane", () => {
  it("holds a draft even when it is approved and red", () => {
    const pr = open({
      number: 1,
      isDraft: true,
      checks: "failing",
      reviews: [review("bob", "APPROVED", "2026-09-28T09:00:00Z")],
    });
    expect(reviewLane(pr)).toBe("held");
  });

  it("holds a pull request labelled on hold, however it is spelt", () => {
    expect(reviewLane(open({ number: 1, labels: ["On Hold"] }))).toBe("held");
    expect(reviewLane(open({ number: 2, labels: ["on-hold"] }))).toBe("held");
    expect(reviewLane(open({ number: 3, labels: ["holdings"] }))).toBe("no_reviewer");
  });

  it("leaves a pull request with failing checks with its author even when approved", () => {
    const pr = open({ number: 1, checks: "failing", reviews: [review("bob", "APPROVED", "2026-09-28T09:00:00Z")] });
    expect(reviewLane(pr)).toBe("with_author");
  });

  it("leaves a pull request with outstanding changes requested with its author", () => {
    const pr = open({ number: 1, reviews: [review("bob", "CHANGES_REQUESTED", "2026-09-28T09:00:00Z")] });
    expect(reviewLane(pr)).toBe("with_author");
  });

  it("returns the ball to the reviewer who is asked to look again", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "CHANGES_REQUESTED", "2026-09-28T09:00:00Z")],
      requestedReviewers: [asked("bob")],
    });
    expect(reviewLane(pr)).toBe("awaiting_review");
  });

  it("forgets a request for changes that was dismissed", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "CHANGES_REQUESTED", "2026-09-28T09:00:00Z"), review("bob", "DISMISSED", "2026-09-28T10:00:00Z")],
      requestedReviewers: [asked("carol")],
    });
    expect(reviewLane(pr)).toBe("awaiting_review");
  });

  it("lets a later approval replace an earlier request for changes by the same reviewer", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "CHANGES_REQUESTED", "2026-09-28T09:00:00Z"), review("bob", "APPROVED", "2026-09-28T11:00:00Z")],
    });
    expect(reviewLane(pr)).toBe("approved");
  });

  it("leaves a pull request that was commented on, with nobody asked again, with its author", () => {
    const pr = open({ number: 1, reviews: [review("bob", "COMMENTED", "2026-09-28T09:00:00Z")] });
    expect(reviewLane(pr)).toBe("with_author");
  });

  it("keeps a commented pull request awaiting review while someone is still asked", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "COMMENTED", "2026-09-28T09:00:00Z")],
      requestedReviewers: [asked("carol")],
    });
    expect(reviewLane(pr)).toBe("awaiting_review");
  });

  it("calls an approval with a comment and no open request approved", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "APPROVED", "2026-09-28T09:00:00Z"), review("carol", "COMMENTED", "2026-09-28T10:00:00Z")],
    });
    expect(reviewLane(pr)).toBe("approved");
  });

  it("ignores the author's comments on their own pull request", () => {
    const pr = open({ number: 1, reviews: [review("alice", "COMMENTED", "2026-09-28T09:00:00Z")] });
    expect(reviewLane(pr)).toBe("no_reviewer");
  });

  it("puts a pull request with reviewers asked in awaiting review, and one with nobody asked in no reviewer", () => {
    expect(reviewLane(open({ number: 1, requestedReviewers: [{ name: "platform", isTeam: true }] }))).toBe("awaiting_review");
    expect(reviewLane(open({ number: 2 }))).toBe("no_reviewer");
  });
});

describe("bot reviewers", () => {
  const bot = (author: string, state: Review["state"], submittedAt: string, authorIsBot?: boolean): Review => ({
    ...review(author, state, submittedAt),
    ...(authorIsBot === undefined ? {} : { authorIsBot }),
  });

  it("does not let a bot approval move a pull request out of no reviewer", () => {
    expect(reviewLane(open({ number: 1, reviews: [bot("ci-helper", "APPROVED", "2026-09-28T09:00:00Z", true)] }))).toBe(
      "no_reviewer",
    );
  });

  it("recognises a bot by its login when the host did not flag it", () => {
    expect(
      reviewLane(open({ number: 1, reviews: [bot("copilot-pull-request-reviewer[bot]", "COMMENTED", "2026-09-28T09:00:00Z")] })),
    ).toBe("no_reviewer");
  });

  it("does not leave a pull request with its author because a bot commented", () => {
    const pr = open({
      number: 1,
      requestedReviewers: [asked("bob")],
      reviews: [bot("ci-helper", "COMMENTED", "2026-09-28T09:00:00Z", true)],
    });
    expect(reviewLane(pr)).toBe("awaiting_review");
  });

  it("does not restart the wait at a bot review, but does at a human one", () => {
    const botOnly = open({ number: 1, reviews: [bot("ci-helper", "COMMENTED", "2026-09-28T09:00:00Z", true)] });
    expect(waitingSince(botOnly)).toBe("2026-09-28T08:00:00Z");
    const both = open({
      number: 2,
      reviews: [bot("ci-helper", "COMMENTED", "2026-09-28T09:00:00Z", true), review("bob", "COMMENTED", "2026-09-28T10:00:00Z")],
    });
    expect(waitingSince(both)).toBe("2026-09-28T10:00:00Z");
  });

  it("still counts a human review that says it is not a bot", () => {
    expect(reviewLane(open({ number: 1, reviews: [bot("bob", "APPROVED", "2026-09-28T09:00:00Z", false)] }))).toBe("approved");
  });
});

describe("waitingSince", () => {
  it("is the publication time before any review", () => {
    const pr = open({ number: 1, createdAt: "2026-09-25T08:00:00Z", publishedAt: "2026-09-25T12:00:00Z" });
    expect(waitingSince(pr)).toBe("2026-09-25T12:00:00Z");
  });

  it("falls back to the creation time when the publication time is unknown", () => {
    expect(waitingSince(open({ number: 1, publishedAt: null }))).toBe("2026-09-28T08:00:00Z");
  });

  it("is the last review by someone else, not the author's own reply", () => {
    const pr = open({
      number: 1,
      reviews: [review("bob", "COMMENTED", "2026-09-28T10:00:00Z"), review("alice", "COMMENTED", "2026-09-28T12:00:00Z")],
    });
    expect(waitingSince(pr)).toBe("2026-09-28T10:00:00Z");
  });
});

describe("buildReviewQueue", () => {
  const widgets = { id: 1, owner: "acme", name: "widgets" };
  const gadgets = { id: 2, owner: "acme", name: "gadgets" };
  // Wednesday 30 Sep 2026, 12:00 UTC
  const now = "2026-09-30T12:00:00Z";

  const prs = {
    // published Fri 25 Sep 16:00: 8h + 24h (Mon) + 24h (Tue) + 12h (Wed) = 68h, overdue, nobody asked
    friday: open({
      number: 1,
      createdAt: "2026-09-25T16:00:00Z",
      publishedAt: "2026-09-25T16:00:00Z",
      updatedAt: "2026-09-25T16:00:00Z",
    }),
    // published Mon 21 Sep 12:00: 12 + 4*24 + 24 + 24 + 12 = 168h... Mon 12h, Tue-Fri 96h, Mon 24h, Tue 24h, Wed 12h = 168h
    old: open({
      number: 2,
      createdAt: "2026-09-21T12:00:00Z",
      publishedAt: "2026-09-21T12:00:00Z",
      updatedAt: "2026-09-21T12:00:00Z",
      requestedReviewers: [asked("bob")],
      additions: 500,
    }),
    // published Wed 30 Sep 10:00: 2h, fresh, awaiting review, small
    fresh: open({
      number: 3,
      createdAt: "2026-09-30T10:00:00Z",
      publishedAt: "2026-09-30T10:00:00Z",
      updatedAt: "2026-09-30T10:00:00Z",
      requestedReviewers: [asked("bob")],
    }),
    // a draft published long ago: held, so not counted as waiting
    draft: open({ number: 4, isDraft: true, publishedAt: "2026-09-01T08:00:00Z", updatedAt: "2026-09-01T08:00:00Z" }),
    red: open({ number: 5, checks: "failing", updatedAt: "2026-09-29T08:00:00Z" }),
  };

  const queue = buildReviewQueue(
    [
      { repo: widgets, pullRequests: [prs.friday, prs.old, prs.fresh, prs.draft, prs.red] },
      {
        repo: gadgets,
        pullRequests: [
          open({
            number: 1,
            requestedReviewers: [asked("carol")],
            updatedAt: "2026-09-30T08:00:00Z",
            publishedAt: "2026-09-30T08:00:00Z",
          }),
        ],
      },
    ],
    { now },
  );
  const entry = (key: string) => queue.entries.find((e) => e.key === key)!;

  it("measures the Friday pull request in weekday hours, not wall clock hours", () => {
    expect(entry("1#1")).toMatchObject({ waitHours: 68, band: "overdue", lane: "no_reviewer", repo: "acme/widgets" });
  });

  it("marks a pull request stale from five weekdays", () => {
    expect(entry("1#2")).toMatchObject({ waitHours: 168, band: "stale", lane: "awaiting_review" });
  });

  it("sorts entries longest wait first, a long-held draft included", () => {
    expect(queue.entries.map((e) => e.key).slice(0, 2)).toEqual(["1#4", "1#2"]);
  });

  it("measures idle days by the wall clock from the last update", () => {
    // updated Mon 21 Sep 12:00 to Wed 30 Sep 12:00 is 9 days
    expect(entry("1#2").idleDays).toBe(9);
    expect(entry("1#4").idleDays).toBe(29);
  });

  it("orders needs attention stale-unowned, stale, then overdue-unowned", () => {
    // 1#4 is a draft so never needs attention; 1#5 has red checks so is with its author
    expect(queue.needsAttention).toEqual(["1#2", "1#1"]);
  });

  it("ranks a stale pull request with no reviewer above a longer stale one awaiting review", () => {
    const ranked = buildReviewQueue(
      [
        {
          repo: widgets,
          pullRequests: [
            prs.old,
            open({ number: 9, publishedAt: "2026-09-22T12:00:00Z", createdAt: "2026-09-22T12:00:00Z" }),
            open({
              number: 8,
              publishedAt: "2026-09-22T12:00:00Z",
              createdAt: "2026-09-22T12:00:00Z",
              requestedReviewers: [asked("bob")],
            }),
          ],
        },
      ],
      { now },
    );
    // 1#9: Tue 22 Sep 12:00 is 144h, stale and unowned; 1#2 is 168h, 1#8 is 144h
    expect(ranked.needsAttention).toEqual(["1#9", "1#2", "1#8"]);
  });

  it("works out the tiles by hand", () => {
    expect(queue.tiles).toEqual({
      // waiting: 1#1, 1#2, 1#3 and 2#1; one red pull request is with its author
      waiting: { count: 4, repos: 2, heldForRedChecks: 1 },
      // 1#1 (68h) and 1#2 (168h)
      pastDay: { count: 2, longestHours: 168 },
      noReviewer: { count: 1, oldestHours: 68 },
      stale: { count: 1, longestHours: 168 },
      // 1#2 is 502 lines, the rest are 12 lines in 2 files
      fastLane: { count: 3 },
      // 1#4 (29 days) and 1#2 (9 days) only the first reaches 14
      idle: { count: 1 },
    });
  });

  it("summarises each repository", () => {
    expect(queue.repos[0]).toEqual({
      repoId: 1,
      repo: "acme/widgets",
      open: 5,
      bands: { fresh: 1, ageing: 0, overdue: 1, stale: 1 },
      lanes: { held: 1, with_author: 1, approved: 0, awaiting_review: 2, no_reviewer: 1 },
    });
    expect(queue.repos[1]).toMatchObject({ repo: "acme/gadgets", open: 1, bands: { fresh: 0, ageing: 1, overdue: 0, stale: 0 } });
  });

  it("counts requested reviewers on every entry", () => {
    expect(entry("1#2").requestedReviewerCount).toBe(1);
    expect(entry("1#1").requestedReviewerCount).toBe(0);
  });

  it("reports the oldest fetch time and starts with no errors or warnings", () => {
    const q = buildReviewQueue(
      [
        { repo: widgets, pullRequests: [], fetchedAt: "2026-09-30T11:59:30Z" },
        { repo: gadgets, pullRequests: [], fetchedAt: "2026-09-30T11:59:00Z" },
      ],
      { now },
    );
    expect(q).toMatchObject({
      fetchedAt: "2026-09-30T11:59:00Z",
      now,
      errors: [],
      warnings: [],
      entries: [],
      needsAttention: [],
    });
    expect(q.tiles.pastDay).toEqual({ count: 0, longestHours: null });
  });

  it("is empty and fetched now with no repositories", () => {
    expect(buildReviewQueue([], { now })).toMatchObject({ fetchedAt: now, repos: [], features: [] });
  });

  it("leaves a pull request with a clock ahead of now with no wait", () => {
    const q = buildReviewQueue(
      [
        {
          repo: widgets,
          pullRequests: [open({ number: 1, publishedAt: "2026-10-05T08:00:00Z", updatedAt: "2026-10-05T08:00:00Z" })],
        },
      ],
      { now },
    );
    expect(q.entries[0]).toMatchObject({ waitHours: 0, band: "fresh", idleDays: 0 });
  });
});
