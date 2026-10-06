import { describe, expect, it } from "vitest";
import { groupFeatures, issueKeysOf, ticketKeysOf, type FeatureCandidate } from "../src/features.js";
import type { OpenPullRequest, ReviewLane } from "../src/types.js";
import { open } from "./openPr.js";

const widgets = { id: 1, owner: "acme", name: "widgets" };
const gadgets = { id: 2, owner: "acme", name: "gadgets" };

function candidate(
  overrides: Partial<OpenPullRequest> & { number: number },
  repo = widgets,
  lane: ReviewLane = "awaiting_review",
  waitHours = 10,
): FeatureCandidate {
  return { repo, pr: open(overrides), entry: { key: `${repo.id}#${overrides.number}`, lane, waitHours } };
}

describe("ticketKeysOf", () => {
  it("finds keys in the title, branch and linked issues once each", () => {
    const pr = open({ number: 1, title: "WID-12 add widgets", headRef: "feature/WID-12-and-GAD-7", linkedIssues: ["#3"] });
    expect(ticketKeysOf(pr)).toEqual(["WID-12", "GAD-7"]);
  });

  it("ignores lookalikes such as UTF-8 and SHA-256", () => {
    expect(ticketKeysOf(open({ number: 1, title: "Switch to UTF-8 and SHA-256" }))).toEqual([]);
  });
});

describe("issueKeysOf", () => {
  it("finds a key in the title alone", () => {
    expect(issueKeysOf({ title: "WID-12 add widgets", headRef: "main" })).toEqual(["WID-12"]);
  });

  it("finds a key in the branch alone", () => {
    expect(issueKeysOf({ title: "Add widgets", headRef: "feature/GAD-7-add-widgets" })).toEqual(["GAD-7"]);
  });

  it("reads the title only when the pull request was crawled before headRef was recorded", () => {
    expect(issueKeysOf({ title: "WID-3 tidy" })).toEqual(["WID-3"]);
    expect(issueKeysOf({ title: "WID-3 tidy", headRef: null })).toEqual(["WID-3"]);
    expect(issueKeysOf({ title: "No key here" })).toEqual([]);
  });

  it("ignores lookalikes such as UTF-8 and SHA-256 but keeps a real key beside them", () => {
    expect(issueKeysOf({ title: "Switch to UTF-8", headRef: "sha-256-WID-9" })).toEqual(["WID-9"]);
  });

  it("lists a key named in both title and branch once, title first", () => {
    expect(issueKeysOf({ title: "GAD-7 and WID-12", headRef: "WID-12-GAD-7-and-WID-20" })).toEqual(["GAD-7", "WID-12", "WID-20"]);
  });

  it("does not match lower-case or single-letter prefixes", () => {
    expect(issueKeysOf({ title: "wid-12 and A-1", headRef: "x" })).toEqual([]);
  });

  it.each([
    ["WID-12_add_widget", "a key followed by an underscore"],
    ["feature_WID-12", "a key after an underscore"],
    ["feature/WID-12_add_widget", "a key between a slash and an underscore"],
  ])("finds the key in %s, %s", (headRef) => {
    expect(issueKeysOf({ title: "Add widgets", headRef })).toEqual(["WID-12"]);
  });

  it("accepts a project key with underscores after its first letter, as Jira allows", () => {
    expect(issueKeysOf({ title: "MY_PROJ-7 tidy", headRef: "feature/MY_PROJ2-8" })).toEqual(["MY_PROJ-7", "MY_PROJ2-8"]);
  });

  it("does not start a key inside a word or a number, nor end one inside a number", () => {
    expect(issueKeysOf({ title: "xWID-12 and 9GAD-7", headRef: "_1-2" })).toEqual([]);
    expect(issueKeysOf({ title: "WID-123", headRef: null })).toEqual(["WID-123"]);
  });

  it("still ignores lookalikes beside underscores", () => {
    expect(issueKeysOf({ title: "Switch", headRef: "utf_UTF-8_SHA-256" })).toEqual([]);
  });
});

describe("groupFeatures", () => {
  it("returns nothing when no pull requests are related", () => {
    expect(groupFeatures([candidate({ number: 1 }), candidate({ number: 2 })])).toEqual([]);
  });

  it("joins pull requests sharing a ticket key, across repositories", () => {
    const groups = groupFeatures([
      candidate({ number: 1, title: "WID-5 api", headRef: "a" }, widgets, "approved", 30),
      candidate({ number: 1, title: "WID-5 web", headRef: "b" }, gadgets, "no_reviewer", 50),
      candidate({ number: 2, title: "Unrelated" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "1#1",
      title: "WID-5",
      evidence: ["ticket"],
      ticketKeys: ["WID-5"],
      longestWaitHours: 50,
      lanes: { held: 0, with_author: 0, approved: 1, awaiting_review: 0, no_reviewer: 1 },
    });
    expect(groups[0]!.members.map((m) => m.key)).toEqual(["2#1", "1#1"]);
  });

  it("joins a pull request to the one named on a Related line, by number, by repository and by link", () => {
    const groups = groupFeatures([
      candidate({ number: 1, body: "Adds the api.\nRelated: #2, acme/gadgets#1" }),
      candidate({ number: 2 }),
      candidate({ number: 1, headRef: "g1" }, gadgets),
      candidate({ number: 3, body: "related: https://github.com/acme/widgets/pull/2" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.evidence).toEqual(["related"]);
    expect(groups[0]!.members).toHaveLength(4);
  });

  it("ignores a Related line naming a pull request that is not open, and text that is not on a Related line", () => {
    expect(groupFeatures([candidate({ number: 1, body: "Related: #99\nSee #2" }), candidate({ number: 2 })])).toEqual([]);
  });

  it("joins pull requests from the same head branch but not from a shared one such as main", () => {
    const groups = groupFeatures([
      candidate({ number: 1, headRef: "spike" }),
      candidate({ number: 2, headRef: "spike" }),
      candidate({ number: 3, headRef: "main" }),
      candidate({ number: 4, headRef: "main" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ evidence: ["branch"], title: "PR 1" });
    expect(groups[0]!.members.map((m) => m.number).sort()).toEqual([1, 2]);
  });

  it("joins a stack, where one pull request is based on another's branch, within one repository only", () => {
    const groups = groupFeatures([
      candidate({ number: 1, headRef: "step-1", baseRef: "main" }),
      candidate({ number: 2, headRef: "step-2", baseRef: "step-1" }),
      candidate({ number: 3, headRef: "step-3", baseRef: "step-2" }),
      candidate({ number: 9, headRef: "other", baseRef: "step-1" }, gadgets),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ evidence: ["stack"], id: "1#1" });
    expect(groups[0]!.members.map((m) => m.number)).toEqual([1, 2, 3]);
  });

  it("merges chains of different evidence into one group and lists each kind once", () => {
    const groups = groupFeatures([
      candidate({ number: 1, title: "WID-1 a", headRef: "a" }),
      candidate({ number: 2, title: "WID-1 b", headRef: "b", body: "Related: #3" }),
      candidate({ number: 3, headRef: "c" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.evidence).toEqual(["ticket", "related"]);
    expect(groups[0]!.members).toHaveLength(3);
  });

  it("orders groups with the longest wait first", () => {
    const groups = groupFeatures([
      candidate({ number: 1, title: "WID-1", headRef: "a" }, widgets, "awaiting_review", 5),
      candidate({ number: 2, title: "WID-1", headRef: "b" }, widgets, "awaiting_review", 6),
      candidate({ number: 3, title: "GAD-1", headRef: "c" }, widgets, "awaiting_review", 40),
      candidate({ number: 4, title: "GAD-1", headRef: "d" }, widgets, "awaiting_review", 1),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["GAD-1", "WID-1"]);
  });
});
