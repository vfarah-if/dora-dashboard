import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router";
import { IssuePage } from "./IssuePage";
import { mockFetch, renderRoute, type MockResponse } from "../test/render";
import { issueReport, repo } from "../test/fixtures";
import { copy } from "../copy";

const HYGIENE_TITLES = [
  "Closed with no pull request",
  "Reopened issues",
  "Urgent issues with no assignee",
  "Stale urgent issues",
  "Open issues with no kind or priority",
  "Pull requests with no issue",
];

const route = (query = "") => ({ path: "/issues/:id", route: `/issues/1${query}` });

function mockReport(listing = repo({ issues: 21 })) {
  return mockFetch({
    "GET /api/repos": { body: [listing] },
    "GET /api/repos/1/issues/report": (url) => ({ body: issueReport({ people: url.searchParams.get("people") === "1" }) }),
  });
}

const reportUrls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map((c) => new URL(String(c[0]), "http://localhost")).filter((u) => u.pathname.endsWith("/report"));

const card = (title: string) => screen.getByRole("region", { name: title });
const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;

describe("IssuePage", () => {
  it("shows the headline tiles with what each means", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    expect(await screen.findByRole("heading", { level: 1, name: "acme/widgets" })).toBeInTheDocument();
    const text = copy.issue.headline;
    expect(within(tile(text.opened)).getByText("15")).toBeInTheDocument();
    expect(within(tile(text.closed)).getByText("12")).toBeInTheDocument();
    expect(within(tile(text.closed)).getByText(text.closedHint(2))).toBeInTheDocument();
    expect(within(tile(text.open)).getByText("6")).toBeInTheDocument();
    expect(within(tile(text.open)).getByText(text.openHint(2))).toBeInTheDocument();
    // 48 hours is 2 days and 120 hours is 5 days.
    expect(within(tile(text.timeToClose)).getByText("2.0 days")).toBeInTheDocument();
    expect(within(tile(text.timeToClose)).getByText(text.timeToCloseHint("5.0 days"))).toBeInTheDocument();
    // 8 of 12 closed issues have a pull request.
    expect(within(tile(text.linked)).getByText("67%")).toBeInTheDocument();
    expect(within(tile(text.linked)).getByText(text.linkedHint(8, 12))).toBeInTheDocument();
    // The oldest open issue is 480 hours, 20 days, old.
    expect(within(tile(text.oldest)).getByText("20.0 days")).toBeInTheDocument();
    expect(within(tile(text.oldest)).getByText(text.oldestHint(7))).toBeInTheDocument();
  });

  it("gives a title and a subtitle to every chart", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    const charts = [
      copy.issue.flow.openedClosed,
      copy.issue.flow.closedByKind,
      copy.issue.flow.openAtEnd,
      copy.issue.open.byKind,
      copy.issue.open.byPriority,
      copy.issue.open.timeToClose,
    ];
    for (const chart of charts) expect(within(card(chart.title)).getByText(chart.subtitle)).toBeInTheDocument();
  });

  it("keeps the part week on the weekly charts, marked in the table, and explains it", async () => {
    const user = userEvent.setup();
    mockReport();
    renderRoute(<IssuePage />, route());
    // The range ends on Wednesday 21 January, part way through the week starting 19 January.
    expect(await screen.findByText(copy.issue.flow.partWeek.cut("19 Jan", "21 Jan"))).toBeInTheDocument();
    const chart = card(copy.issue.flow.openedClosed.title);
    await user.click(within(chart).getByText(copy.common.viewAsTable));
    const rows = within(within(chart).getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[3]!).getByRole("rowheader")).toHaveTextContent(copy.charts.partWeek.to("19 Jan", "21 Jan"));
    expect(
      within(rows[3]!)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["4", "3"]);
    // The legend names the part week so a lighter bar is never unexplained.
    expect(within(chart).getAllByText(copy.charts.partWeek.to("Week starting 19 Jan", "21 Jan")).length).toBeGreaterThan(0);
  });

  it("does not say the part week is left out, and says nothing when the range ends with a week", async () => {
    const base = issueReport();
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": {
        body: { ...base, weekly: base.weekly.map((w) => ({ ...w, partial: false })) },
      },
    });
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    expect(screen.queryByText(/is not over yet|part way through the week/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cut short by the end of the range are left out/)).not.toBeInTheDocument();
  });

  it("tables closed issues by kind with a total, in the fixed kind order", async () => {
    const user = userEvent.setup();
    mockReport();
    renderRoute(<IssuePage />, route());
    const chart = await screen.findByRole("region", { name: copy.issue.flow.closedByKind.title });
    await user.click(within(chart).getByText(copy.common.viewAsTable));
    const table = within(chart).getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      copy.charts.weekStarting,
      "Bug",
      "Feature",
      "Maintenance",
      "Incident",
      "Other",
      copy.issue.flow.closedByKind.total,
    ]);
    // 5 January closed 2 bugs, a feature and a piece of maintenance.
    expect(
      within(within(table).getAllByRole("row")[1]!)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2", "1", "1", "0", "0", "4"]);
  });

  it("shows time to close by priority in a table that is always visible, with the 75th percentile", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    const tables = screen.getAllByRole("table", { name: copy.issue.open.timeToClose.title });
    // One sits in the chart's disclosure and one is the always visible copy, outside any <details>.
    const visible = tables.find((t) => !t.closest("details"))!;
    const p1 = within(visible).getByRole("row", { name: /^P1/ });
    // 30 hours median, 50 hours (2.1 days) at the 75th percentile, 35 hours mean, from 3 issues.
    expect(
      within(p1)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["3", "30.0 h", "2.1 days", "35.0 h"]);
    const none = within(visible).getByRole("row", { name: new RegExp(`^${copy.issue.priorities.none}`) });
    expect(within(none).getAllByRole("cell")[0]).toHaveTextContent("3");
    const p3 = within(visible).getByRole("row", { name: /^P3/ });
    expect(within(p3).getAllByRole("cell")[0]).toHaveTextContent("0");
    expect(within(visible).getAllByRole("row")).toHaveLength(7);
  });

  it("lists open issues oldest first, each number linking to the issue on GitHub", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    const ageing = await screen.findByRole("region", { name: copy.issue.ageing.title });
    const rows = within(ageing).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0]!.textContent)).toEqual(
      [7, 12, 15, 18, 20, 22].map((n) => `#${n} ${copy.common.opensInNewTab}`),
    );
    expect(within(ageing).getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://github.com/acme/widgets/issues/7");
    expect(within(rows[0]!).getByText("Crash on save")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Bug")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("P1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("20.0 days")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(copy.issue.ageing.noPriority)).toBeInTheDocument();
  });

  it("collapses a long ageing list after ten and shows the rest on request", async () => {
    const user = userEvent.setup();
    const base = issueReport();
    const many = Array.from({ length: 12 }, (_, i) => ({ ...base.ageing[0]!, number: 100 + i }));
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": { body: { ...base, ageing: many } },
    });
    renderRoute(<IssuePage />, route());
    const ageing = await screen.findByRole("region", { name: copy.issue.ageing.title });
    expect(within(ageing).getAllByRole("link")).toHaveLength(10);
    await user.click(within(ageing).getByRole("button", { name: copy.space.showAll(12) }));
    expect(within(ageing).getAllByRole("link")).toHaveLength(12);
  });

  it("says how many open issues the ageing list leaves out when the API has cut it", async () => {
    const base = issueReport();
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": { body: { ...base, ageingTotal: 136 } },
    });
    renderRoute(<IssuePage />, route());
    const ageing = await screen.findByRole("region", { name: copy.issue.ageing.title });
    expect(within(ageing).getByText(copy.issue.ageing.cut(base.ageing.length, 136))).toBeInTheDocument();
  });

  it("adds no cut note when the ageing list holds every open issue", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    const ageing = await screen.findByRole("region", { name: copy.issue.ageing.title });
    expect(within(ageing).queryByText(/oldest of/)).not.toBeInTheDocument();
  });

  it("says nothing is open when the ageing list is empty", async () => {
    const base = issueReport();
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": { body: { ...base, ageing: [] } },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.ageing.empty)).toBeInTheDocument();
    expect(within(tile(copy.issue.headline.oldest)).getByText(copy.issue.headline.oldestNone)).toBeInTheDocument();
  });

  it("shows issue to first pull request and to production, with how many issues each covers", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.idea.lede(8, 12, "67%"))).toBeInTheDocument();
    const first = tile(copy.issue.idea.toFirstPr);
    expect(within(first).getByText("20.0 h")).toBeInTheDocument();
    expect(within(first).getByText(copy.issue.idea.toFirstPrHint("40.0 h", 8))).toBeInTheDocument();
    const prod = tile(copy.issue.idea.toProduction);
    expect(within(prod).getByText("2.1 days")).toBeInTheDocument();
    expect(within(prod).getByText(copy.issue.idea.toProductionHint("5.0 days", 7))).toBeInTheDocument();
  });

  it("shows hygiene cards in the fixed order whatever order the API sends them in", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    const hygiene = screen.getByRole("region", { name: copy.issue.hygiene.title });
    expect(
      within(hygiene)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(HYGIENE_TITLES);
  });

  it("asks for no names by default and shows none", async () => {
    const fetchMock = mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    expect(screen.queryByText("Ann Example")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: copy.issue.ageing.assignee })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: copy.issue.showPeople })).toHaveAttribute("aria-checked", "false");
    expect(reportUrls(fetchMock).every((u) => !u.searchParams.has("people"))).toBe(true);
  });

  it("sends people=1 when the toggle is turned on, then shows assignees in the ageing list and groups the hygiene lists", async () => {
    const user = userEvent.setup();
    const fetchMock = mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    await user.click(screen.getByRole("switch", { name: copy.issue.showPeople }));
    await waitFor(() => expect(reportUrls(fetchMock).some((u) => u.searchParams.get("people") === "1")).toBe(true));

    const ageing = await screen.findByRole("region", { name: copy.issue.ageing.title });
    await waitFor(() =>
      expect(within(ageing).getByRole("columnheader", { name: copy.issue.ageing.assignee })).toBeInTheDocument(),
    );
    const rows = within(ageing).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Ann Example")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(copy.issue.ageing.unassigned)).toBeInTheDocument();

    const closedNoPr = screen.getByRole("region", { name: copy.issue.hygiene.checks.closed_without_pr.title });
    const names = within(closedNoPr)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(names).toEqual(["Ann Example", "Zoe Example"]);
  });

  it("keeps names out of every chart and tile when people are shown", async () => {
    mockReport();
    renderRoute(<IssuePage />, route("?people=1"));
    await screen.findAllByText("Ann Example");
    const holders = screen
      .getAllByText("Ann Example")
      .map((el) => el.closest("section")?.getAttribute("aria-label") ?? el.closest("section")?.className);
    for (const holder of holders) expect(["card space-ageing", ...HYGIENE_TITLES]).toContain(holder);
  });

  it("sends the range and leaves out the bots switch", async () => {
    const fetchMock = mockReport();
    renderRoute(<IssuePage />, route("?from=2026-01-01&to=2026-02-01&bots=1"));
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    const url = reportUrls(fetchMock)[0]!;
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-02-01");
    expect(url.searchParams.has("includeBots")).toBe(false);
    expect(screen.queryByRole("switch", { name: copy.range.includeBots })).not.toBeInTheDocument();
  });

  it("links back to the GitHub Issues list and offers a PDF report named after the repository", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    mockReport();
    renderRoute(<IssuePage />, route());
    expect(screen.getByRole("link", { name: copy.common.backToIssues })).toHaveAttribute("href", "/issues");
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).toMatch(/^acme-widgets-github-issues-report-\d{4}-\d{2}-\d{2}$/));
  });

  it("says so when the repository cannot be found", async () => {
    mockFetch({
      "GET /api/repos": { body: [] },
      "GET /api/repos/1/issues/report": { status: 404, body: { error: "not found" } },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.issue.toIssues })).toHaveAttribute("href", "/issues");
  });

  it("says so when the address does not name a repository, without asking the API", () => {
    const fetchMock = mockFetch({});
    for (const address of ["abc", "0", "1.5", "-3"]) {
      const { unmount } = renderRoute(<IssuePage />, { path: "/issues/:id", route: `/issues/${address}` });
      expect(screen.getByText(copy.issue.notFoundTitle)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.common.backToIssues })).toHaveAttribute("href", "/issues");
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an error with a retry for any other failure", async () => {
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": { status: 500, body: { error: "boom" } },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("says issues are switched off on GitHub when the repositories list reports it", async () => {
    mockReport(repo({ issues: 21, issuesEnabled: false }));
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.issuesDisabledTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issue.issuesDisabledBody)).toBeInTheDocument();
  });

  it("says nothing about issues being switched off when they are on", async () => {
    mockReport(repo({ issues: 21, issuesEnabled: true }));
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    expect(screen.queryByText(copy.issue.issuesDisabledTitle)).not.toBeInTheDocument();
  });

  it("shows the failed read of issues and the failed crawl from the repositories list", async () => {
    mockReport(repo({ issues: 21, issueError: "GitHub answered 502", crawlStatus: "failed", crawlError: "rate limited" }));
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.issueErrorReason("GitHub answered 502"))).toBeInTheDocument();
    expect(screen.getByText(copy.issue.crawlFailedReason("rate limited"))).toBeInTheDocument();
    expect(screen.queryByText(copy.issue.reposFailedTitle)).not.toBeInTheDocument();
  });

  it("says the crawl status could not be loaded when the repositories list fails, and still shows the report", async () => {
    mockFetch({
      "GET /api/repos": { status: 500, body: { error: "list failed" } },
      "GET /api/repos/1/issues/report": { body: issueReport() },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.reposFailedTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issue.reposFailedBody)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "acme/widgets" })).toBeInTheDocument();
  });

  it("does not add the crawl status notice when the repository cannot be found", async () => {
    mockFetch({
      "GET /api/repos": { status: 500, body: { error: "list failed" } },
      "GET /api/repos/1/issues/report": { status: 404, body: { error: "not found" } },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.notFoundTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.issue.reposFailedTitle)).not.toBeInTheDocument();
  });

  it("loads the report when Retry is pressed after the first request fails with a 500", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": () =>
        ++calls === 1 ? { status: 500, body: { error: "boom" } } : { body: issueReport() },
    });
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText("boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByRole("heading", { level: 1, name: "acme/widgets" })).toBeInTheDocument();
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });

  it("never shows another repository's report under the next repository's address while that one loads", async () => {
    const user = userEvent.setup();
    let release: (response: MockResponse) => void = () => undefined;
    const gadgets = issueReport();
    gadgets.repo = { ...gadgets.repo, id: 2, name: "gadgets" };
    mockFetch({
      "GET /api/repos": { body: [repo({ id: 1, issues: 21 }), repo({ id: 2, name: "gadgets", issues: 4 })] },
      "GET /api/repos/1/issues/report": { body: issueReport() },
      "GET /api/repos/2/issues/report": () => new Promise<MockResponse>((resolve) => (release = resolve)),
    });
    renderRoute(
      <>
        <IssuePage />
        <Link to="/issues/2">Next repository</Link>
      </>,
      { path: "/issues/:id", route: "/issues/1" },
    );
    expect(await screen.findByRole("heading", { level: 1, name: "acme/widgets" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Next repository" }));

    expect(await screen.findByRole("heading", { level: 1, name: copy.issue.loadingTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "acme/widgets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: copy.issue.headline.title })).not.toBeInTheDocument();
    release({ body: gadgets });
    expect(await screen.findByRole("heading", { level: 1, name: "acme/gadgets" })).toBeInTheDocument();
  });

  it("does not show a report fetched without names as unassigned while the one with names loads", async () => {
    const user = userEvent.setup();
    let release: (response: MockResponse) => void = () => undefined;
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": (url) =>
        url.searchParams.get("people") === "1"
          ? new Promise<MockResponse>((resolve) => (release = resolve))
          : { body: issueReport() },
    });
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });

    await user.click(screen.getByRole("switch", { name: copy.issue.showPeople }));

    // The figures that were fetched without names are gone, so no list can group them under Unassigned.
    await waitFor(() => expect(screen.queryByRole("region", { name: copy.issue.hygiene.title })).not.toBeInTheDocument());
    expect(screen.queryByText(copy.space.hygiene.unassigned)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.issue.ageing.unassigned)).not.toBeInTheDocument();
    release({ body: issueReport({ people: true }) });
    const closedNoPr = await screen.findByRole("region", { name: copy.issue.hygiene.checks.closed_without_pr.title });
    expect(within(closedNoPr).getByRole("heading", { level: 4, name: "Ann Example" })).toBeInTheDocument();
  });

  it("keeps the previous figures on screen, marked as refreshing, while a new range loads", async () => {
    const user = userEvent.setup();
    let release: (value: MockResponse) => void = () => {};
    const held = new Promise<MockResponse>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": () => (++calls === 1 ? { body: issueReport() } : held),
    });
    renderRoute(<IssuePage />, route());
    const heading = await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    await user.click(screen.getByRole("button", { name: copy.range.last30 }));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("heading", { level: 1, name: "acme/widgets" })).toBe(heading);
    expect(document.querySelector(".is-refreshing")).not.toBeNull();
    release({ body: issueReport() });
    await waitFor(() => expect(document.querySelector(".is-refreshing")).toBeNull());
  });

  it("warns, with the reason, when the last read of issues failed", async () => {
    mockReport(repo({ issues: 21, issueError: "GitHub answered 502" }));
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.issueErrorTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issue.issueErrorBody)).toBeInTheDocument();
    expect(screen.getByText(copy.issue.issueErrorReason("GitHub answered 502"))).toBeInTheDocument();
  });

  it("warns that the figures may be out of date when the latest crawl failed", async () => {
    mockReport(repo({ issues: 21, crawlStatus: "failed", crawlError: "rate limited" }));
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.crawlFailedTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issue.crawlFailedReason("rate limited"))).toBeInTheDocument();
  });

  it("warns without a reason when a failed crawl recorded none, and says when a crawl is under way", async () => {
    mockReport(repo({ issues: 21, crawlStatus: "failed", crawlError: null }));
    const { unmount } = renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.issue.crawlFailedTitle)).toBeInTheDocument();
    expect(screen.queryByText(/The reason given/)).not.toBeInTheDocument();
    unmount();

    mockReport(repo({ issues: 21, crawlStatus: "crawling" }));
    renderRoute(<IssuePage />, route());
    expect(await screen.findByText(copy.repo.crawlInProgress)).toBeInTheDocument();
  });

  it("gives no warning when the repository is up to date", async () => {
    mockReport();
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    expect(screen.queryByText(copy.issue.issueErrorTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.issue.crawlFailedTitle)).not.toBeInTheDocument();
  });

  it("says there is nothing to chart when a range holds no issues", async () => {
    const base = issueReport();
    mockFetch({
      "GET /api/repos": { body: [repo({ issues: 21 })] },
      "GET /api/repos/1/issues/report": {
        body: {
          ...base,
          weekly: base.weekly.map((w) => ({
            ...w,
            opened: 0,
            closed: 0,
            closedByKind: { bug: 0, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 },
            partial: false,
          })),
          openByKind: { bug: 0, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 },
          openByPriority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0, none: 0 },
          timeToCloseByPriority: base.timeToCloseByPriority.map((p) => ({
            ...p,
            summary: { count: 0, median: null, p75: null, mean: null },
          })),
          ageing: [],
        },
      },
    });
    renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    for (const chart of [
      copy.issue.flow.openedClosed,
      copy.issue.flow.closedByKind,
      copy.issue.open.byKind,
      copy.issue.open.byPriority,
      copy.issue.open.timeToClose,
    ]) {
      expect(within(card(chart.title)).getByText(copy.charts.noData)).toBeInTheDocument();
    }
  });

  it("refetches the report when the crawl of that repository ends", async () => {
    let listing = repo({ issues: 21, crawlStatus: "crawling" });
    let reads = 0;
    mockFetch({
      "GET /api/repos": () => ({ body: [listing] }),
      "GET /api/repos/1/issues/report": () => {
        reads += 1;
        return { body: issueReport() };
      },
    });
    const { client } = renderRoute(<IssuePage />, route());
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    expect(reads).toBe(1);
    listing = repo({ issues: 21, crawlStatus: "idle" });
    await client.invalidateQueries({ queryKey: ["repos"] });
    await waitFor(() => expect(reads).toBe(2));
  });
});
