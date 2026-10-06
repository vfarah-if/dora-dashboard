import { describe, expect, it } from "vitest";
import type { TrackerStatus } from "@dora-dashboard/core";
import { ApiError } from "../api/client";
import {
  columnsWithStatuses,
  filterSpaces,
  groupStatusesByCategory,
  isCrawlConflict,
  isAcceptedReturnTo,
  isJiraUnauthorised,
  jiraConnectUrl,
  linkedKeysForSite,
  parseJiraOutcome,
  returnPath,
  toggleKey,
} from "./jira";

const statuses: TrackerStatus[] = [
  { id: "3", name: "Done", category: "done" },
  { id: "1", name: "Backlog", category: "todo" },
  { id: "2", name: "In review", category: "in_progress" },
  { id: "4", name: "Doing", category: "in_progress" },
];

describe("filterSpaces", () => {
  const spaces = [
    { key: "WID", name: "Widgets" },
    { key: "GAD", name: "Gadget platform" },
    { key: "OPS", name: "Operations" },
  ];

  it("returns every space for a blank search", () => {
    expect(filterSpaces(spaces, "   ")).toEqual(spaces);
  });

  it("matches the name or the key, ignoring case", () => {
    expect(filterSpaces(spaces, "gad").map((s) => s.key)).toEqual(["GAD"]);
    expect(filterSpaces(spaces, " wid ").map((s) => s.key)).toEqual(["WID"]);
    expect(filterSpaces(spaces, "ops").map((s) => s.key)).toEqual(["OPS"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSpaces(spaces, "zzz")).toEqual([]);
  });
});

describe("groupStatusesByCategory", () => {
  it("orders groups to do, in progress, done and keeps status order within each", () => {
    const groups = groupStatusesByCategory(statuses);
    expect(groups.map((g) => g.category)).toEqual(["todo", "in_progress", "done"]);
    expect(groups[1]?.statuses.map((s) => s.name)).toEqual(["In review", "Doing"]);
  });

  it("leaves out categories with no statuses", () => {
    expect(groupStatusesByCategory([statuses[1]!]).map((g) => g.category)).toEqual(["todo"]);
    expect(groupStatusesByCategory([])).toEqual([]);
  });
});

describe("columnsWithStatuses", () => {
  it("maps ids to statuses left to right and drops ids the space no longer has", () => {
    const columns = [
      { name: "Ready", statusIds: ["1", "99"] },
      { name: "Review", statusIds: ["2", "4"] },
      { name: "Empty", statusIds: [] },
    ];
    expect(columnsWithStatuses(columns, statuses)).toEqual([
      { name: "Ready", statuses: [statuses[1]] },
      { name: "Review", statuses: [statuses[2], statuses[3]] },
      { name: "Empty", statuses: [] },
    ]);
  });
});

describe("linkedKeysForSite", () => {
  it("keeps only the keys on the given site", () => {
    const linked = [
      { siteId: "cloud-1", key: "WID" },
      { siteId: "cloud-2", key: "OTH" },
    ];
    expect(linkedKeysForSite(linked, "cloud-1")).toEqual(["WID"]);
    expect(linkedKeysForSite(linked, "none")).toEqual([]);
  });
});

describe("toggleKey", () => {
  it("adds a key once and removes it again", () => {
    expect(toggleKey(["A"], "B", true)).toEqual(["A", "B"]);
    expect(toggleKey(["A", "B"], "A", true)).toEqual(["B", "A"]);
    expect(toggleKey(["A", "B"], "A", false)).toEqual(["B"]);
  });
});

describe("jiraConnectUrl", () => {
  it("encodes the relative return path", () => {
    expect(jiraConnectUrl("/repos?x=1")).toBe("/api/auth/jira/start?returnTo=%2Frepos%3Fx%3D1");
  });

  it.each(["https://evil.example.test/", "//evil.example.test", "repos", "/\\evil", "/a b", "/a\u0001b", "/a\u007fb"])(
    "replaces %j with the root",
    (path) => {
      expect(jiraConnectUrl(path)).toBe("/api/auth/jira/start?returnTo=%2F");
    },
  );

  it("sends the path alone when the path and query together are too long", () => {
    const path = "/spaces/7";
    expect(jiraConnectUrl(`${path}?x=${"a".repeat(200)}`)).toBe("/api/auth/jira/start?returnTo=%2Fspaces%2F7");
  });

  it("sends the path alone when the query holds a space", () => {
    expect(jiraConnectUrl("/spaces/7?q=a b")).toBe("/api/auth/jira/start?returnTo=%2Fspaces%2F7");
  });

  it("falls back to the root when the path alone is too long", () => {
    expect(jiraConnectUrl(`/${"a".repeat(250)}?x=1`)).toBe("/api/auth/jira/start?returnTo=%2F");
  });
});

describe("isAcceptedReturnTo", () => {
  it("accepts a path of exactly 200 characters and refuses 201", () => {
    expect(isAcceptedReturnTo(`/${"a".repeat(199)}`)).toBe(true);
    expect(isAcceptedReturnTo(`/${"a".repeat(200)}`)).toBe(false);
  });
});

describe("returnPath", () => {
  it("drops the jira outcome and keeps the other parameters", () => {
    expect(returnPath("/repos/3", "?jira=error&range=30")).toBe("/repos/3?range=30");
  });

  it("returns the path alone when nothing else is left", () => {
    expect(returnPath("/repos/3", "?jira=denied")).toBe("/repos/3");
    expect(returnPath("/repos/3", "")).toBe("/repos/3");
  });
});

describe("isJiraUnauthorised", () => {
  it("recognises only a 401 carrying the Jira code", () => {
    expect(isJiraUnauthorised(new ApiError(401, "Connect Jira again", "jira_unauthorised"))).toBe(true);
    expect(isJiraUnauthorised(new ApiError(401, "Sign in"))).toBe(false);
    // The code is read, never the message.
    expect(isJiraUnauthorised(new ApiError(401, "jira_unauthorised"))).toBe(false);
    expect(isJiraUnauthorised(new ApiError(403, "Connect Jira again", "jira_unauthorised"))).toBe(false);
    expect(isJiraUnauthorised(null)).toBe(false);
    expect(isJiraUnauthorised("jira_unauthorised")).toBe(false);
  });
});

describe("isCrawlConflict", () => {
  it("recognises only a 409", () => {
    expect(isCrawlConflict(new ApiError(409, "A crawl of this space is already running"))).toBe(true);
    expect(isCrawlConflict(new ApiError(500, "x"))).toBe(false);
    expect(isCrawlConflict(undefined)).toBe(false);
  });
});

describe("parseJiraOutcome", () => {
  it.each(["denied", "error", "expired", "misconfigured", "rate_limited"])("accepts %s", (value) => {
    expect(parseJiraOutcome(value)).toBe(value);
  });

  it.each([null, "", "Denied", "success"])("gives null for %j", (value) => {
    expect(parseJiraOutcome(value)).toBeNull();
  });
});
