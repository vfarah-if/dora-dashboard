import { describe, expect, it } from "vitest";
import { buildSpaceReport, type LinkedRepoData, type SpaceReport } from "../src/spaceReport.js";
import type { DeployRun, PullRequest, StatusCategory, TrackerSpace, WorkItem } from "../src/types.js";

const NOW = "2026-10-06T12:00:00Z"; // a Tuesday; the week starts on Monday 2026-10-05

const space: TrackerSpace = {
  id: 7,
  siteId: "site-1",
  siteUrl: "https://acme.example.net",
  key: "WID",
  name: "Widgets",
  statuses: [
    { id: "1", name: "To Do", category: "todo" },
    { id: "2", name: "In Progress", category: "in_progress" },
    { id: "3", name: "In Review", category: "in_progress" },
    { id: "4", name: "Blocked", category: "in_progress" },
    { id: "5", name: "Done", category: "done" },
    { id: "6", name: "Ready for QA", category: "in_progress" },
  ],
  columns: [
    { name: "To Do", statusIds: ["1"] },
    { name: "In Progress", statusIds: ["2", "4"] },
    { name: "Review", statusIds: ["3"] },
    { name: "Done", statusIds: ["5"] },
  ],
  lastCrawledAt: "2026-10-06T08:00:00Z",
  crawlStatus: "idle",
  crawlError: null,
  crawlProgress: null,
  people: { "acc-1": "Ada Lovelace" },
};

const CATEGORY: Record<string, StatusCategory> = {
  "To Do": "todo",
  "In Progress": "in_progress",
  "In Review": "in_progress",
  Blocked: "in_progress",
  "Ready for QA": "in_progress",
  Done: "done",
};

/** One step of an item's history: when, which status, and its category when the status name alone does not say. */
type Step = [at: string, status: string, category?: StatusCategory | null];

const categoryOf = ([, status, category]: Step): StatusCategory | null =>
  category !== undefined ? category : (CATEGORY[status] ?? null);

/** A work item whose transitions, current status, creation and last update all follow from its steps. */
function workItem(key: string, steps: Step[], overrides: Partial<WorkItem> = {}): WorkItem {
  const transitions = steps.map((step, i) => {
    const previous = steps[i - 1];
    return {
      at: step[0],
      from: previous ? previous[1] : null,
      to: step[1],
      fromCategory: previous ? categoryOf(previous) : null,
      toCategory: categoryOf(step),
    };
  });
  const last = transitions.at(-1);
  const createdAt = steps[0]?.[0] ?? "2026-09-01T09:00:00Z";
  return {
    key,
    spaceKey: "WID",
    type: "Story",
    summary: `Summary of ${key}`,
    status: last?.to ?? "To Do",
    statusCategory: last ? last.toCategory : "todo",
    createdAt,
    updatedAt: last?.at ?? createdAt,
    resolvedAt: null,
    assigneeId: "acc-1",
    parentKey: null,
    labels: [],
    transitions,
    ...overrides,
  };
}

/** Created, started and done, each on the given instants. */
const done = (key: string, createdAt: string, startedAt: string, doneAt: string, overrides: Partial<WorkItem> = {}) =>
  workItem(
    key,
    [
      [createdAt, "To Do"],
      [startedAt, "In Progress"],
      [doneAt, "Done"],
    ],
    overrides,
  );

function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/acme/widgets/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: "2026-09-01T14:00:00Z",
    closedAt: "2026-09-01T14:00:00Z",
    updatedAt: "2026-09-01T14:00:00Z",
    mergedBy: "alice",
    additions: 10,
    deletions: 5,
    firstCommitAt: null,
    baseRef: "main",
    headRef: null,
    reviews: [],
    ...overrides,
  };
}

/** A deploy run that completes ten minutes after it starts. */
function run(runId: number, createdAt: string, branch = "main"): DeployRun {
  return {
    runId,
    workflow: "deploy.yml",
    branch,
    status: "completed",
    conclusion: "success",
    createdAt,
    completedAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
  };
}

const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30", now: NOW };
const EMPTY_SUMMARY = { count: 0, median: null, p75: null, mean: null };

const finding = (report: SpaceReport, check: SpaceReport["hygiene"][number]["check"]) =>
  report.hygiene.find((f) => f.check === check)!;
const keys = (refs: { key: string }[]) => refs.map((r) => r.key);

describe("buildSpaceReport", () => {
  it("gives zero counts, null summaries and every hygiene check when there is nothing to report", () => {
    const report = buildSpaceReport(space, [], [], { now: NOW });

    expect(report.space).toEqual({
      id: 7,
      key: "WID",
      name: "Widgets",
      siteUrl: "https://acme.example.net",
      lastCrawledAt: "2026-10-06T08:00:00Z",
      crawlStatus: "idle",
      crawlError: null,
    });
    expect(report.range).toEqual({ from: "2026-10-06", to: "2026-10-06" });
    expect(report.repos).toEqual([]);
    expect(report.totals).toEqual({ done: 0, inProgress: 0, created: 0, epicsOpen: 0 });
    expect(report.issueCycleTime).toEqual(EMPTY_SUMMARY);
    expect(report.issueLeadTime).toEqual(EMPTY_SUMMARY);
    expect(report.weekly).toEqual([{ week: "2026-10-05", doneByType: {}, done: 0, inProgress: 0, partial: true }]);
    expect(report.ageing).toEqual([]);
    expect(report.columns).toEqual([]);
    expect(report.flowEfficiency).toBeNull();
    expect(report.ideaToProduction).toEqual({ toFirstPr: EMPTY_SUMMARY, toProduction: EMPTY_SUMMARY, linked: 0, of: 0 });
    expect(report.hygiene.map((f) => [f.check, f.count, f.of])).toEqual([
      ["pr_without_key", 0, 0],
      ["done_without_pr", 0, 0],
      ["skipped_in_progress", 0, 0],
      ["bulk_move", 0, null],
      ["reopened", 0, null],
      ["stale_in_progress", 0, 0],
      ["in_progress_unassigned", 0, 0],
    ]);
    expect(finding(report, "bulk_move").batches).toEqual([]);
    for (const f of report.hygiene) expect([f.items, f.pullRequests]).toEqual([[], []]);
  });

  describe("range", () => {
    it("runs from the earliest item's creation date to the date of now when no range is given", () => {
      const items = [
        workItem("WID-1", [["2026-09-03T09:00:00.000Z", "To Do"]]),
        workItem("WID-2", [["2026-08-30T22:30:00.000Z", "To Do"]], { type: "Sub-task" }), // any item sets the start
      ];
      expect(buildSpaceReport(space, items, [], { now: NOW }).range).toEqual({ from: "2026-08-30", to: "2026-10-06" });
    });

    it("ends the range at now when the end date is later, so the clock decides what has happened", () => {
      const items = [
        done("WID-1", "2026-10-01T09:00:00Z", "2026-10-02T09:00:00Z", "2026-10-06T11:00:00Z"),
        // A clock ahead of ours recorded this an hour after now; it has not happened yet as far as the report knows.
        done("WID-2", "2026-10-01T09:00:00Z", "2026-10-02T09:00:00Z", "2026-10-06T13:00:00Z"),
      ];
      const report = buildSpaceReport(space, items, [], { from: "2026-09-01", to: "2026-10-31", now: NOW });

      expect(report.range).toEqual({ from: "2026-09-01", to: "2026-10-06" });
      expect(report.totals.done).toBe(1);
      expect(report.totals.inProgress).toBe(1); // WID-2 is still in progress at now
      expect(report.weekly.map((w) => w.week)).toEqual([
        "2026-08-31",
        "2026-09-07",
        "2026-09-14",
        "2026-09-21",
        "2026-09-28",
        "2026-10-05",
      ]);
      expect(report.weekly.at(-1)).toMatchObject({ done: 1, inProgress: 1, partial: true });
    });

    it("counts a move in the last second of the end date, down to its last millisecond", () => {
      const items = [
        done("WID-1", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-09-30T23:59:59.500Z"),
        done("WID-2", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-10-01T00:00:00.000Z"), // the next day: out
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      expect(report.range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
      expect(report.totals.done).toBe(1);
      expect(keys(finding(report, "done_without_pr").items)).toEqual(["WID-1"]);
    });

    it.each([
      ["2026-09-16", true], // a Wednesday: the week of 14 September runs past it
      ["2026-09-20", false], // a Sunday: the range ends at 23:59:59.999, the last millisecond of the week
    ])("marks the last week partial only when it runs past the range end (to %s)", (to, partial) => {
      const report = buildSpaceReport(space, [], [], { from: "2026-09-07", to, now: NOW });
      expect(report.weekly.map((w) => [w.week, w.partial])).toEqual([
        ["2026-09-07", false],
        ["2026-09-14", partial],
      ]);
    });
  });

  it("counts standard items only, by level first and by type name when the level is absent", () => {
    const at = "2026-09-02T09:00:00Z";
    const items = [
      done("WID-1", at, "2026-09-03T09:00:00Z", "2026-09-04T09:00:00Z"), // Story, no level: standard
      done("WID-2", at, "2026-09-03T09:00:00Z", "2026-09-04T09:00:00Z", { type: "Sub-task" }), // sub-task by name
      workItem("WID-3", [[at, "To Do"]], { type: "Subtask" }), // sub-task by name, no hyphen
      workItem("WID-4", [[at, "To Do"]], { type: "epic" }), // epic by name, any case: open
      workItem("WID-5", [[at, "Done"]], { type: "Epic", level: "epic" }), // epic, closed
      workItem("WID-6", [[at, "To Do"]], { type: "Initiative", level: "epic" }), // the level wins over the name: open
      workItem("WID-7", [[at, "To Do"]], { type: "Bug", level: "standard" }),
      workItem("WID-8", [[at, "To Do"]], { type: "Sub-task", level: "standard" }), // the level wins again
    ];
    const report = buildSpaceReport(space, items, [], SEPTEMBER);

    expect(report.totals).toEqual({ done: 1, inProgress: 0, created: 3, epicsOpen: 2 }); // created: WID-1, WID-7, WID-8
  });

  describe("cycle time and lead time", () => {
    it("summarises started to done over started items, and created to done over every done item", () => {
      const items = [
        // cycle 2 Sep 09:00 to 4 Sep 09:00 = 48h; lead 1 Sep 09:00 to 4 Sep 09:00 = 72h
        workItem("WID-1", [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "In Progress"],
          ["2026-09-03T09:00:00Z", "In Review"],
          ["2026-09-04T09:00:00Z", "Done"],
        ]),
        // cycle 12:00 to 18:00 = 6h; lead 09:00 to 18:00 = 9h
        done("WID-2", "2026-09-01T09:00:00Z", "2026-09-01T12:00:00Z", "2026-09-01T18:00:00Z"),
        // never in progress: no cycle time; lead 24h
        workItem("WID-3", [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "Done"],
        ]),
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      // [6, 48]: median 27, p75 = 6 + 42 * 0.75 = 37.5, mean 27
      expect(report.issueCycleTime).toEqual({ count: 2, median: 27, p75: 37.5, mean: 27 });
      // [9, 24, 72]: median 24, p75 = 24 + 48 * 0.5 = 48, mean 105 / 3 = 35
      expect(report.issueLeadTime).toEqual({ count: 3, median: 24, p75: 48, mean: 35 });
    });

    it("takes the last move into done, and only for items that are done now", () => {
      const items = [
        workItem("WID-4", [
          ["2026-08-31T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "In Progress"],
          ["2026-09-03T09:00:00Z", "Done"],
          ["2026-09-04T09:00:00Z", "In Progress"],
          ["2026-09-05T09:00:00Z", "Done"],
        ]),
        workItem("WID-5", [
          ["2026-08-31T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "In Progress"],
          ["2026-09-03T09:00:00Z", "Done"],
          ["2026-09-04T09:00:00Z", "In Progress"],
        ]),
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      expect(report.totals).toMatchObject({ done: 1, inProgress: 1 });
      expect(report.issueCycleTime.median).toBe(72); // 2 Sep 09:00 to 5 Sep 09:00
      expect(report.issueLeadTime.median).toBe(120); // 31 Aug 09:00 to 5 Sep 09:00
    });

    it("counts an item done now from its last move when its history holds no move into done, or from creation without one", () => {
      const items = [
        // Done now only because its status was recategorised after the move; the history holds no move into done.
        workItem(
          "WID-6",
          [
            ["2026-09-01T09:00:00Z", "To Do"],
            ["2026-09-02T09:00:00Z", "In Progress"],
          ],
          { statusCategory: "done" },
        ),
        // No history at all, so it has been in its current category since it was created.
        workItem("WID-7", [], { status: "Done", statusCategory: "done", createdAt: "2026-09-05T09:00:00Z" }),
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      expect(report.totals.done).toBe(2);
      // WID-6 started and finished at its last move, 2 Sep 09:00: cycle 0h. WID-7 never started.
      expect(report.issueCycleTime).toEqual({ count: 1, median: 0, p75: 0, mean: 0 });
      // WID-6 1 Sep 09:00 to 2 Sep 09:00 = 24h; WID-7 0h. [0, 24]: median 12, p75 = 0 + 24 * 0.75 = 18, mean 12
      expect(report.issueLeadTime).toEqual({ count: 2, median: 12, p75: 18, mean: 12 });
      expect(report.weekly[0]).toMatchObject({ week: "2026-08-31", done: 2 });
      expect(keys(finding(report, "skipped_in_progress").items)).toEqual(["WID-7"]);
    });

    it("counts an item done now from its last move when the space no longer lists the status it moved to", () => {
      const items = [
        // The move to Shipped is the move into done: the space does not list Shipped, but the item is done now.
        workItem(
          "WID-91",
          [
            ["2026-09-01T09:00:00Z", "To Do"],
            ["2026-09-02T09:00:00Z", "In Progress"],
            ["2026-09-04T09:00:00Z", "Shipped", null],
          ],
          { statusCategory: "done" },
        ),
        // Done on 3 Sep, then moved to Shipped: a move between two done statuses, so neither a finish nor a reopen.
        workItem(
          "WID-92",
          [
            ["2026-09-01T09:00:00Z", "To Do"],
            ["2026-09-02T09:00:00Z", "In Progress"],
            ["2026-09-03T09:00:00Z", "Done"],
            ["2026-09-10T09:00:00Z", "Shipped", null],
          ],
          { statusCategory: "done" },
        ),
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      expect(report.totals.done).toBe(2);
      // WID-91 2 Sep 09:00 to 4 Sep 09:00 = 48h; WID-92 2 Sep 09:00 to 3 Sep 09:00 = 24h.
      // [24, 48]: median 36, p75 = 24 + 24 * 0.75 = 42, mean 36
      expect(report.issueCycleTime).toEqual({ count: 2, median: 36, p75: 42, mean: 36 });
      // WID-91 1 Sep 09:00 to 4 Sep 09:00 = 72h; WID-92 1 Sep 09:00 to 3 Sep 09:00 = 48h.
      // [48, 72]: median 60, p75 = 48 + 24 * 0.75 = 66, mean 60
      expect(report.issueLeadTime).toEqual({ count: 2, median: 60, p75: 66, mean: 60 });
      expect(finding(report, "reopened").count).toBe(0);
    });

    it("compares Jira and GitHub times as instants, not as text", () => {
      const items = [
        // Done on the first second of the range. As text "...00:00:00.000Z" sorts before "...00:00:00Z".
        workItem("WID-1", [
          ["2026-08-31T12:00:00.000Z", "To Do"],
          ["2026-09-01T00:00:00.000Z", "Done"],
        ]),
        // Done half a second after now. As text "...12:00:00.500Z" sorts before "...12:00:00Z".
        workItem("WID-2", [
          ["2026-10-01T12:00:00.000Z", "To Do"],
          ["2026-10-06T12:00:00.500Z", "Done"],
        ]),
      ];
      const linked: LinkedRepoData[] = [
        {
          repo: { id: 1, owner: "acme", name: "widgets", deployBranch: "main" },
          prs: [pr({ number: 1, title: "WID-1 tidy", createdAt: "2026-08-31T12:00:00Z", state: "OPEN", mergedAt: null })],
          runs: [],
        },
      ];
      const report = buildSpaceReport(space, items, linked, { from: "2026-09-01", now: NOW });

      expect(report.totals.done).toBe(1);
      expect(report.issueLeadTime.mean).toBe(12); // 31 Aug 12:00 to 1 Sep 00:00
      expect(report.ideaToProduction.toFirstPr.median).toBe(0); // the same second, written two ways
    });

    it("counts an issue raised after it was done as zero lead time, not a negative one", () => {
      // A migrated issue: created on 5 Sep, carrying a history that says it was done on 3 Sep.
      const items = [
        done("WID-1", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-09-03T09:00:00Z", {
          createdAt: "2026-09-05T09:00:00Z",
        }),
        done("WID-2", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-09-03T09:00:00Z"), // 48h
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      // [0, 48]: median 24, p75 = 0 + 48 * 0.75 = 36, mean 24
      expect(report.issueLeadTime).toEqual({ count: 2, median: 24, p75: 36, mean: 24 });
    });

    it("counts a pull request opened before its issue was raised as zero, not a negative wait", () => {
      const items = [
        workItem("WID-1", [
          ["2026-09-02T12:00:00.000Z", "To Do"],
          ["2026-09-03T12:00:00.000Z", "Done"],
        ]),
      ];
      const linked: LinkedRepoData[] = [
        {
          repo: { id: 1, owner: "acme", name: "widgets", deployBranch: "main" },
          // Opened a day before the issue existed, as when a ticket is raised after the work.
          prs: [pr({ number: 1, title: "WID-1 tidy", createdAt: "2026-09-01T12:00:00Z", state: "OPEN", mergedAt: null })],
          runs: [],
        },
      ];
      const report = buildSpaceReport(space, items, linked, { from: "2026-09-01", now: NOW });

      expect(report.ideaToProduction.toFirstPr).toEqual({ count: 1, median: 0, p75: 0, mean: 0 });
    });
  });

  it("counts an item in progress now from its last move when the space no longer lists the status it moved to", () => {
    const item = workItem(
      "WID-95",
      [
        ["2026-08-25T09:00:00Z", "To Do"],
        ["2026-08-26T09:00:00Z", "In Progress"],
        ["2026-08-27T09:00:00Z", "Doing", null], // a status the space does not list, in progress by the item's own category
      ],
      { statusCategory: "in_progress" },
    );
    const report = buildSpaceReport(space, [item], [], SEPTEMBER);

    // In progress at the end of every week and of the range, as the ageing list says it is now.
    expect(report.totals.inProgress).toBe(1);
    expect(report.weekly.map((w) => w.inProgress)).toEqual([1, 1, 1, 1, 1]);
    expect(keys(report.ageing)).toEqual(["WID-95"]);
  });

  describe("moves between done statuses", () => {
    // Five stories, each created in progress an hour after the one before and done 48 hours later on 3 Sep, then all
    // moved from Done to Released within four minutes on Sunday 20 Sep.
    const items = [1, 2, 3, 4, 5].map((n) =>
      workItem(`WID-8${n}`, [
        [`2026-09-01T0${n}:00:00Z`, "In Progress"],
        [`2026-09-03T0${n}:00:00Z`, "Done"],
        [`2026-09-20T10:0${n - 1}:00Z`, "Released", "done"],
      ]),
    );

    it("measures done from the move into done, not a later move between done statuses", () => {
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      // Each item: 1 Sep 0n:00 to 3 Sep 0n:00 = 48h, from start and from creation alike. The move to Released counts for nothing.
      expect(report.issueCycleTime).toEqual({ count: 5, median: 48, p75: 48, mean: 48 });
      expect(report.issueLeadTime).toEqual({ count: 5, median: 48, p75: 48, mean: 48 });
      expect(report.totals.done).toBe(5);
      expect(report.weekly.find((w) => w.week === "2026-08-31")).toMatchObject({ done: 5, doneByType: { Story: 5 } });
      expect(report.weekly.find((w) => w.week === "2026-09-14")).toMatchObject({ done: 0, doneByType: {} });
      // All 48h of each item were in In Progress and none in Done, so every hour is active.
      expect(report.columns).toEqual([{ column: "In Progress", meanHours: 48, medianHours: 48, items: 5 }]);
      expect(report.flowEfficiency).toBe(1);
      expect(finding(report, "reopened").count).toBe(0);
    });

    it("does not call a batch of moves between done statuses a bulk move", () => {
      // The moves into done are an hour apart; only the moves to Released fall within ten minutes of each other.
      expect(finding(buildSpaceReport(space, items, [], SEPTEMBER), "bulk_move")).toMatchObject({ count: 0, batches: [] });
    });
  });

  it("counts done items by week and type, and rebuilds work in progress at the end of each week", () => {
    const items = [
      workItem("WID-1", [
        ["2026-09-01T09:00:00Z", "To Do"],
        ["2026-09-08T10:00:00Z", "In Progress"],
        ["2026-09-15T10:00:00Z", "Done"],
      ]),
      workItem(
        "WID-2",
        [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-09T10:00:00Z", "In Progress"],
        ],
        { type: "Bug" },
      ),
      done("WID-3", "2026-09-01T09:00:00Z", "2026-09-09T09:00:00Z", "2026-09-10T09:00:00Z", { type: "Bug" }),
      // In progress over the first weekend only, then back to To Do.
      workItem("WID-5", [
        ["2026-09-01T09:00:00Z", "To Do"],
        ["2026-09-13T23:00:00Z", "In Progress"],
        ["2026-09-14T01:00:00Z", "To Do"],
      ]),
      // Sub-tasks are not counted.
      workItem(
        "WID-6",
        [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-08T10:00:00Z", "In Progress"],
        ],
        { type: "Sub-task" },
      ),
    ];
    const report = buildSpaceReport(space, items, [], { from: "2026-09-07", to: "2026-09-20", now: NOW });

    expect(report.weekly).toEqual([
      // At Sunday 13 Sep 23:59:59: WID-1, WID-2 and WID-5 are in progress.
      { week: "2026-09-07", doneByType: { Bug: 1 }, done: 1, inProgress: 3, partial: false },
      // At the range end, Sunday 20 Sep 23:59:59: only WID-2.
      { week: "2026-09-14", doneByType: { Story: 1 }, done: 1, inProgress: 1, partial: false },
    ]);
    expect(report.totals).toMatchObject({ done: 2, inProgress: 1 });
  });

  describe("time per column and flow efficiency", () => {
    const items = [
      // Started 09:00, done 20:00: 11h. In Progress 4h + Blocked 2h + In Progress 2h = 8h in the In Progress column,
      // In Review 2h, then Ready for QA 0.5h (on no column) and Legacy Check 0.5h (no longer a status).
      workItem("WID-1", [
        ["2026-09-01T08:00:00Z", "To Do"],
        ["2026-09-01T09:00:00Z", "In Progress"],
        ["2026-09-01T13:00:00Z", "Blocked"],
        ["2026-09-01T15:00:00Z", "In Progress"],
        ["2026-09-01T17:00:00Z", "In Review"],
        ["2026-09-01T19:00:00Z", "Ready for QA"],
        ["2026-09-01T19:30:00Z", "Legacy Check", null],
        ["2026-09-01T20:00:00Z", "Done"],
      ]),
      // Started 09:00, done 15:00: 6h. In Progress 4h, a Blocked status for no time at all, "in review" 2h.
      workItem("WID-2", [
        ["2026-09-02T08:00:00Z", "To Do"],
        ["2026-09-02T09:00:00Z", "In Progress"],
        ["2026-09-02T13:00:00Z", "Blocked"],
        ["2026-09-02T13:00:00Z", "in review", "in_progress"],
        ["2026-09-02T15:00:00Z", "Done"],
      ]),
      // Never started, so it has no cycle and is not walked.
      workItem("WID-3", [
        ["2026-09-03T08:00:00Z", "To Do"],
        ["2026-09-03T10:00:00Z", "Done"],
      ]),
    ];

    it("gives mean hours per done item for each board column, so the columns add up to the mean cycle time", () => {
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      // Mean cycle (11 + 6) / 2 = 8.5 = 6 + 2 + 0.5.
      expect(report.columns).toEqual([
        { column: "In Progress", meanHours: 6, medianHours: 6, items: 2 }, // (8 + 4) / 2; median of [8, 4]
        { column: "Review", meanHours: 2, medianHours: 2, items: 2 }, // "in review" matches "In Review" ignoring case
        { column: null, meanHours: 0.5, medianHours: 1, items: 1 }, // on no column: 1h over 2 items
      ]);
      expect(report.issueCycleTime.mean).toBe(8.5);
    });

    it("keeps a board column that happens to be named Not on the board apart from time on no column", () => {
      const board: TrackerSpace = { ...space, columns: [...space.columns, { name: "Not on the board", statusIds: ["6"] }] };

      // Ready for QA (0.5h) is now on the board; Legacy Check (0.5h) is still on no column. Each is 0.5h over 2 items.
      expect(buildSpaceReport(board, items, [], SEPTEMBER).columns).toEqual([
        { column: "In Progress", meanHours: 6, medianHours: 6, items: 2 },
        { column: "Review", meanHours: 2, medianHours: 2, items: 2 },
        { column: "Not on the board", meanHours: 0.25, medianHours: 0.5, items: 1 },
        { column: null, meanHours: 0.25, medianHours: 0.5, items: 1 },
      ]);
    });

    it("uses status names as the columns when the space has no board, in the order of the space's statuses", () => {
      const report = buildSpaceReport({ ...space, columns: [] }, items, [], SEPTEMBER);

      expect(report.columns).toEqual([
        { column: "In Progress", meanHours: 5, medianHours: 5, items: 2 }, // WID-1 6h, WID-2 4h
        { column: "In Review", meanHours: 2, medianHours: 2, items: 2 },
        { column: "Blocked", meanHours: 1, medianHours: 2, items: 1 }, // WID-2's moment in Blocked is no visit
        { column: "Ready for QA", meanHours: 0.25, medianHours: 0.5, items: 1 },
        { column: "Legacy Check", meanHours: 0.25, medianHours: 0.5, items: 1 }, // unknown statuses come last
      ]);
    });

    it("matches a status name exactly before matching it ignoring case", () => {
      const caseSpace: TrackerSpace = {
        ...space,
        statuses: [
          ...space.statuses,
          { id: "20", name: "QA", category: "in_progress" },
          { id: "21", name: "qa", category: "in_progress" },
        ],
        columns: [
          { name: "Upper", statusIds: ["20"] },
          { name: "Lower", statusIds: ["21"] },
        ],
      };
      const item = workItem("WID-1", [
        ["2026-09-01T08:00:00Z", "To Do"],
        ["2026-09-01T09:00:00Z", "qa", "in_progress"],
        ["2026-09-01T11:00:00Z", "Done"],
      ]);

      expect(buildSpaceReport(caseSpace, [item], [], SEPTEMBER).columns).toEqual([
        { column: "Lower", meanHours: 2, medianHours: 2, items: 1 },
      ]);
    });

    it("orders statuses the space does not know by name when it has no board", () => {
      const item = workItem("WID-1", [
        ["2026-09-01T08:00:00Z", "To Do"],
        ["2026-09-01T09:00:00Z", "In Progress"],
        ["2026-09-01T10:00:00Z", "Zeta", "in_progress"],
        ["2026-09-01T11:00:00Z", "Alpha", "in_progress"],
        ["2026-09-01T12:00:00Z", "Done"],
      ]);

      expect(buildSpaceReport({ ...space, columns: [] }, [item], [], SEPTEMBER).columns.map((c) => c.column)).toEqual([
        "In Progress",
        "Alpha",
        "Zeta",
      ]);
    });

    it("counts in-progress time as active unless the status name says the item is waiting", () => {
      // WID-1 active: In Progress 4 + In Progress 2 + In Review 2 = 8 of 11 (Blocked, Ready for QA, Legacy Check wait).
      // WID-2 active: In Progress 4 + in review 2 = 6 of 6. (8 + 6) / (11 + 6) = 14 / 17.
      expect(buildSpaceReport(space, items, [], SEPTEMBER).flowEfficiency).toBeCloseTo(14 / 17, 10);
    });

    it.each([
      ["Already in progress", "active"],
      ["Blockchain spike", "active"],
      ["Unblocked", "active"],
      ["Threshold tuning", "active"],
      ["Blocked", "waiting"],
      ["On hold", "waiting"],
      ["ON_HOLD", "waiting"],
      ["Waiting for vendor", "waiting"],
      ["Awaiting deploy", "waiting"],
      ["Ready for QA", "waiting"],
      ["Queued", "waiting"],
    ])("reads time in %j as %s, taking a waiting word only where it stands alone", (status, reading) => {
      // Two hours in the one status between start and done: 2 / 2 = 1 when active, 0 / 2 = 0 when waiting.
      const item = workItem("WID-1", [
        ["2026-09-01T08:00:00Z", "To Do"],
        ["2026-09-01T09:00:00Z", status, "in_progress"],
        ["2026-09-01T11:00:00Z", "Done"],
      ]);
      expect(buildSpaceReport(space, [item], [], SEPTEMBER).flowEfficiency).toBe(reading === "active" ? 1 : 0);
    });

    it("has no flow efficiency when the done items took no time", () => {
      const instant = done("WID-1", "2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", "2026-09-01T09:00:00Z");
      const report = buildSpaceReport(space, [instant], [], SEPTEMBER);

      expect(report.flowEfficiency).toBeNull();
      expect(report.columns).toEqual([]);
      expect(report.issueCycleTime.median).toBe(0);
    });
  });

  describe("linking pull requests to items", () => {
    const widgets: LinkedRepoData = {
      repo: { id: 1, owner: "acme", name: "widgets", deployBranch: "main" },
      runs: [run(1, "2026-09-01T00:00:00Z"), run(2, "2026-09-05T10:00:00Z"), run(3, "2026-09-10T10:00:00Z")],
      prs: [
        // A sub-task's key links to its parent. Shipped by run 2, done 5 Sep 10:10.
        pr({ number: 1, title: "WID-11 add the endpoint", createdAt: "2026-09-03T09:00:00Z", mergedAt: "2026-09-04T09:00:00Z" }),
        // Key in the branch only. Shipped by run 3, done 10 Sep 10:10.
        pr({
          number: 2,
          title: "Build the screen",
          headRef: "feature/WID-10-screen",
          createdAt: "2026-09-02T15:00:00Z",
          mergedAt: "2026-09-06T12:00:00Z",
        }),
        pr({ number: 3, title: "WID-12 fix rounding", createdAt: "2026-09-03T12:00:00Z", mergedAt: "2026-09-04T12:00:00Z" }),
        // Merged after the last deploy: not shipped.
        pr({ number: 4, title: "WID-12 follow up", createdAt: "2026-09-11T09:00:00Z", mergedAt: "2026-09-11T12:00:00Z" }),
        // Closed unmerged: counts as the first pull request, never needs shipping.
        pr({
          number: 5,
          title: "WID-12 first attempt",
          state: "CLOSED",
          createdAt: "2026-09-03T10:00:00Z",
          mergedAt: null,
        }),
        pr({ number: 6, title: "Tidy the readme", createdAt: "2026-09-07T09:00:00Z", mergedAt: "2026-09-07T12:00:00Z" }),
        pr({ number: 9, title: "Bump deps", author: "dependabot[bot]", mergedAt: "2026-09-07T12:00:00Z" }),
        pr({
          number: 20,
          title: "Update lockfile",
          author: "acme-automation",
          authorIsBot: true,
          mergedAt: "2026-09-07T12:00:00Z",
        }),
        pr({ number: 21, title: "Old work", createdAt: "2026-08-19T09:00:00Z", mergedAt: "2026-08-20T09:00:00Z" }),
      ],
    };
    const gadgets: LinkedRepoData = {
      repo: { id: 2, owner: "acme", name: "gadgets", deployBranch: "release" },
      // Deploys were first observed on 5 Sep (ADR 0007).
      runs: [run(10, "2026-09-05T00:00:00Z", "release"), run(11, "2026-09-06T00:00:00Z", "release")],
      prs: [
        // Merged before the first observed deploy, so it cannot be paired: not shipped.
        pr({
          number: 7,
          title: "WID-15 gadget",
          baseRef: "release",
          createdAt: "2026-09-01T10:00:00Z",
          mergedAt: "2026-09-04T00:00:00Z",
        }),
        // Shipped by run 11 on this repository's own deploy branch, done 6 Sep 00:10.
        pr({
          number: 8,
          title: "WID-16 gadget",
          baseRef: "release",
          createdAt: "2026-09-04T06:00:00Z",
          mergedAt: "2026-09-05T06:00:00Z",
        }),
      ],
    };
    const items = [
      done("WID-10", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", "2026-09-08T09:00:00Z"),
      done("WID-11", "2026-09-02T09:30:00Z", "2026-09-03T08:00:00Z", "2026-09-04T10:00:00Z", {
        type: "Sub-task",
        parentKey: "WID-10",
      }),
      done("WID-12", "2026-09-03T09:00:00Z", "2026-09-03T10:00:00Z", "2026-09-09T09:00:00Z", { type: "Bug" }),
      done("WID-14", "2026-09-03T09:00:00Z", "2026-09-04T09:00:00Z", "2026-09-05T09:00:00Z"),
      done("WID-15", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z", "2026-09-06T09:00:00Z"),
      done("WID-16", "2026-09-04T00:00:00Z", "2026-09-04T01:00:00Z", "2026-09-07T09:00:00Z"),
    ];
    const report = buildSpaceReport(space, items, [widgets, gadgets], SEPTEMBER);

    it("names the linked repositories as owner/name", () => {
      expect(report.repos).toEqual([
        { id: 1, name: "acme/widgets" },
        { id: 2, name: "acme/gadgets" },
      ]);
    });

    it("measures created to the first linked pull request, counting a sub-task's pull requests for its parent", () => {
      // WID-10 6h (to #2), WID-12 1h (to #5), WID-15 1h (to #7), WID-16 6h (to #8); WID-14 has none.
      // [1, 1, 6, 6]: median 3.5, p75 = 6 + 0 * 0.25 = 6, mean 3.5
      expect(report.ideaToProduction.toFirstPr).toEqual({ count: 4, median: 3.5, p75: 6, mean: 3.5 });
      expect(report.ideaToProduction).toMatchObject({ linked: 4, of: 5 });
    });

    it("measures created to production only for items whose every merged pull request shipped", () => {
      // WID-10: 2 Sep 09:00 to 10 Sep 10:10 = 193h 10m. WID-16: 4 Sep 00:00 to 6 Sep 00:10 = 48h 10m.
      // WID-12 has #4 unshipped and WID-15 has #7 outside the deploy window, so neither counts.
      const { toProduction } = report.ideaToProduction;
      expect(toProduction.count).toBe(2);
      expect(toProduction.median).toBeCloseTo((193 + 1 / 6 + 48 + 1 / 6) / 2, 10);
      expect(toProduction.mean).toBeCloseTo((193 + 1 / 6 + 48 + 1 / 6) / 2, 10);
      expect(toProduction.p75).toBeCloseTo(48 + 1 / 6 + 145 * 0.75, 10);
    });

    it("lists merged human pull requests in the range with no issue key", () => {
      // Merged in range by people: #1, #2, #3, #4, #6, #7, #8. The bots (#9, #20) and #21 (August) are left out.
      expect(finding(report, "pr_without_key")).toEqual({
        check: "pr_without_key",
        count: 1,
        of: 7,
        items: [],
        pullRequests: [
          { repo: "acme/widgets", number: 6, title: "Tidy the readme", url: "https://github.com/acme/widgets/pull/6" },
        ],
      });
    });

    it("lists done items with no linked pull request", () => {
      expect(finding(report, "done_without_pr")).toMatchObject({ count: 1, of: 5, items: [{ key: "WID-14" }] });
    });
  });

  describe("hygiene", () => {
    it("lists items in natural key order, and done items that skipped in progress", () => {
      const skipped = (key: string) =>
        workItem(key, [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "Done"],
        ]);
      const items = [
        skipped("WID-10"),
        skipped("WID-9"),
        done("WID-2", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z", "2026-09-02T09:00:00Z"),
      ];
      const report = buildSpaceReport(space, items, [], SEPTEMBER);

      expect(keys(finding(report, "done_without_pr").items)).toEqual(["WID-2", "WID-9", "WID-10"]);
      expect(finding(report, "skipped_in_progress")).toEqual({
        check: "skipped_in_progress",
        count: 2,
        of: 3,
        items: [
          { key: "WID-9", type: "Story", summary: "Summary of WID-9", assigned: true },
          { key: "WID-10", type: "Story", summary: "Summary of WID-10", assigned: true },
        ],
        pullRequests: [],
      });
    });

    it("finds five or more items moved to done within ten minutes of the first, and not four", () => {
      const at = (time: string) => `2026-09-10T${time}Z`;
      const moved = (key: string, time: string) => done(key, "2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", at(time));
      const items = [
        moved("WID-21", "10:00:00"),
        moved("WID-22", "10:02:00"),
        moved("WID-23", "10:04:00"),
        moved("WID-24", "10:06:00"),
        moved("WID-25", "10:10:00"), // exactly ten minutes after the batch start: in
        moved("WID-26", "10:10:01"), // one second later: starts a new batch of four, which is not a bulk move
        moved("WID-27", "10:11:00"),
        moved("WID-28", "10:12:00"),
        moved("WID-29", "10:13:00"),
      ];
      const bulk = finding(buildSpaceReport(space, items, [], SEPTEMBER), "bulk_move");

      const batch = ["WID-21", "WID-22", "WID-23", "WID-24", "WID-25"];
      expect(bulk).toMatchObject({ count: 5, of: null, batches: [{ at: at("10:00:00"), keys: batch }] });
      expect(keys(bulk.items)).toEqual(batch);
    });

    it("finds a batch that starts at a later move when the window of an earlier one holds too few", () => {
      const at = (minute: number) => `2026-09-10T10:${String(minute).padStart(2, "0")}:00Z`;
      const moved = (key: string, minute: number) => done(key, "2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", at(minute));
      const items = [
        moved("WID-71", 0), // its window holds minutes 0 and 9 only
        moved("WID-72", 9), // its window runs to minute 19 and holds 9, 11, 12, 13 and 14: five items
        moved("WID-73", 11),
        moved("WID-74", 12),
        moved("WID-75", 13),
        moved("WID-76", 14),
      ];
      const bulk = finding(buildSpaceReport(space, items, [], SEPTEMBER), "bulk_move");

      const batch = ["WID-72", "WID-73", "WID-74", "WID-75", "WID-76"];
      expect(bulk).toMatchObject({ count: 5, batches: [{ at: at(9), keys: batch }] });
      expect(keys(bulk.items)).toEqual(batch);
    });

    it("needs five distinct delivery items for a bulk move", () => {
      const moved = (key: string, time: string, overrides: Partial<WorkItem> = {}) =>
        done(key, "2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", `2026-09-10T${time}Z`, overrides);
      const items = [
        workItem("WID-31", [
          ["2026-09-01T08:00:00Z", "To Do"],
          ["2026-09-10T10:00:00Z", "Done"],
          ["2026-09-10T10:01:00Z", "In Progress"],
          ["2026-09-10T10:02:00Z", "Done"], // the same item twice
        ]),
        moved("WID-32", "10:03:00"),
        moved("WID-33", "10:04:00"),
        moved("WID-34", "10:05:00"),
        moved("WID-35", "10:06:00", { type: "Sub-task" }), // not a delivery item
      ];
      expect(finding(buildSpaceReport(space, items, [], SEPTEMBER), "bulk_move")).toMatchObject({ count: 0, batches: [] });
    });

    it("finds items moved out of done during the range", () => {
      const items = [
        workItem("WID-41", [
          ["2026-08-25T09:00:00Z", "To Do"],
          ["2026-09-02T09:00:00Z", "In Progress"],
          ["2026-09-10T09:00:00Z", "Done"],
          ["2026-09-11T09:00:00Z", "In Progress"],
        ]),
        // Reopened in August, before the range.
        workItem("WID-42", [
          ["2026-08-01T09:00:00Z", "To Do"],
          ["2026-08-10T09:00:00Z", "Done"],
          ["2026-08-20T09:00:00Z", "In Progress"],
          ["2026-09-05T09:00:00Z", "Done"],
        ]),
        // From one done status to another is not a reopen.
        workItem("WID-43", [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-03T09:00:00Z", "Done"],
          ["2026-09-04T09:00:00Z", "Released", "done"],
        ]),
        // To a status whose category is unknown counts, as it is not done.
        workItem("WID-44", [
          ["2026-09-01T09:00:00Z", "To Do"],
          ["2026-09-03T09:00:00Z", "Done"],
          ["2026-09-05T09:00:00Z", "Legacy Check", null],
        ]),
        workItem(
          "WID-45",
          [
            ["2026-09-01T09:00:00Z", "Done"],
            ["2026-09-05T09:00:00Z", "To Do"],
          ],
          { type: "Sub-task" },
        ),
      ];
      const reopened = finding(buildSpaceReport(space, items, [], SEPTEMBER), "reopened");

      expect(reopened).toMatchObject({ count: 2, of: null });
      expect(keys(reopened.items)).toEqual(["WID-41", "WID-44"]);
    });

    describe("work in progress now", () => {
      const inProgress = (key: string, updatedAt: string, overrides: Partial<WorkItem> = {}) =>
        workItem(
          key,
          [
            ["2026-09-01T09:00:00Z", "To Do"],
            ["2026-09-02T09:00:00Z", "In Progress"],
          ],
          { updatedAt, ...overrides },
        );
      const items = [
        inProgress("WID-51", "2026-09-29T11:59:59Z"), // 7 days and 1 second before now: stale
        inProgress("WID-52", "2026-09-29T12:00:00.000Z", { assigneeId: null }), // exactly 7 days: not stale
        inProgress("WID-55", "2026-10-05T12:00:00Z", { assigneeId: "acc-9" }), // someone whose name is not known
        done("WID-53", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-09-03T09:00:00Z", {
          assigneeId: null,
          updatedAt: "2026-09-03T09:00:00Z",
        }),
        inProgress("WID-54", "2026-09-01T09:00:00Z", { type: "Sub-task", assigneeId: null }),
      ];

      it("finds stale and unassigned items in progress, without names unless people are asked for", () => {
        const report = buildSpaceReport(space, items, [], SEPTEMBER);
        const stale = finding(report, "stale_in_progress");
        const unassigned = finding(report, "in_progress_unassigned");

        expect(stale).toMatchObject({ count: 1, of: 3 });
        expect(keys(stale.items)).toEqual(["WID-51"]);
        expect(unassigned).toMatchObject({ count: 1, of: 3 });
        expect(keys(unassigned.items)).toEqual(["WID-52"]);
        expect("assignee" in stale.items[0]!).toBe(false);
      });

      it("names the assignee when people are asked for, and gives null when there is none or the name is unknown", () => {
        const report = buildSpaceReport(space, items, [], { ...SEPTEMBER, people: true });

        expect(finding(report, "stale_in_progress").items[0]!.assignee).toBe("Ada Lovelace");
        expect(finding(report, "in_progress_unassigned").items[0]!.assignee).toBeNull();
        expect(report.ageing.find((a) => a.key === "WID-55")!.assignee).toBeNull();
      });

      it("says whether each item is assigned, with or without people, so a name not recorded is not read as nobody", () => {
        // All three started on 2 Sep 09:00, so they age alike and are listed in key order.
        const plain = buildSpaceReport(space, items, [], SEPTEMBER).ageing;
        expect(plain.map((a) => [a.key, a.assigned, "assignee" in a])).toEqual([
          ["WID-51", true, false],
          ["WID-52", false, false],
          ["WID-55", true, false],
        ]);

        const named = buildSpaceReport(space, items, [], { ...SEPTEMBER, people: true }).ageing;
        expect(named.map((a) => [a.key, a.assigned, a.assignee])).toEqual([
          ["WID-51", true, "Ada Lovelace"],
          ["WID-52", false, null], // nobody assigned
          ["WID-55", true, null], // assigned to acc-9, whose name the space does not hold
        ]);
      });

      it("reads only names the space holds, never one inherited by every object", () => {
        const items = [inProgress("WID-56", "2026-10-05T12:00:00Z", { assigneeId: "constructor" })];
        const report = buildSpaceReport(space, items, [], { ...SEPTEMBER, people: true });

        expect(report.ageing[0]!.assignee).toBeNull();
      });
    });
  });

  it("ages the items in progress now from when they started, oldest first", () => {
    const items = [
      workItem("WID-62", [
        ["2026-09-28T09:00:00Z", "To Do"],
        ["2026-09-30T12:00:00Z", "In Progress"],
      ]),
      workItem("WID-61", [
        ["2026-09-10T12:00:00Z", "To Do"],
        ["2026-09-20T12:00:00Z", "In Progress"],
        ["2026-09-25T12:00:00Z", "In Review"],
      ]),
      // No history at all: its age runs from its creation.
      workItem("WID-63", [], {
        status: "Doing",
        statusCategory: "in_progress",
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      }),
      done("WID-64", "2026-09-01T09:00:00Z", "2026-09-02T09:00:00Z", "2026-09-03T09:00:00Z"),
    ];
    const report = buildSpaceReport(space, items, [], { from: "2026-09-01", now: NOW });

    expect(report.ageing).toEqual([
      // 20 Sep 12:00 to 6 Oct 12:00 = 16 days = 384h
      {
        key: "WID-61",
        type: "Story",
        summary: "Summary of WID-61",
        assigned: true,
        status: "In Review",
        startedAt: "2026-09-20T12:00:00Z",
        ageHours: 384,
      },
      // 30 Sep 12:00 to 6 Oct 12:00 = 6 days = 144h
      {
        key: "WID-62",
        type: "Story",
        summary: "Summary of WID-62",
        assigned: true,
        status: "In Progress",
        startedAt: "2026-09-30T12:00:00Z",
        ageHours: 144,
      },
      // 1 Oct 12:00 to 6 Oct 12:00 = 5 days = 120h
      {
        key: "WID-63",
        type: "Story",
        summary: "Summary of WID-63",
        assigned: true,
        status: "Doing",
        startedAt: "2026-10-01T12:00:00.000Z",
        ageHours: 120,
      },
    ]);
    expect(report.totals.inProgress).toBe(3);
  });
});
