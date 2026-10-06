import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router";
import { SpacePage } from "./SpacePage";
import { mockFetch, renderRoute, type MockResponse } from "../test/render";
import { spaceReport } from "../test/fixtures";
import { copy } from "../copy";

const route = (query = "") => ({ path: "/spaces/:id", route: `/spaces/7${query}` });

function mockReport() {
  return mockFetch({
    "GET /api/spaces/7/report": (url) => ({ body: spaceReport({ people: url.searchParams.get("people") === "1" }) }),
  });
}

const reportUrls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map((c) => new URL(String(c[0]), "http://localhost")).filter((u) => u.pathname.endsWith("/report"));

const card = (title: string) => screen.getByRole("region", { name: title });

describe("SpacePage", () => {
  it("shows the headline tiles with what each means", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    expect(await screen.findByRole("heading", { level: 1, name: "Widgets" })).toBeInTheDocument();
    const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;
    expect(within(tile(copy.space.headline.done)).getByText("12")).toBeInTheDocument();
    expect(within(tile(copy.space.headline.done)).getByText(copy.space.headline.doneHint(15))).toBeInTheDocument();
    expect(within(tile(copy.space.headline.inProgress)).getByText("3")).toBeInTheDocument();
    // 30 hours median, 60 hours (2.5 days) at the 75th percentile.
    expect(within(tile(copy.space.headline.cycle)).getByText("30.0 h")).toBeInTheDocument();
    expect(within(tile(copy.space.headline.cycle)).getByText(copy.space.headline.cycleHint("2.5 days"))).toBeInTheDocument();
    expect(within(tile(copy.space.headline.lead)).getByText("3.0 days")).toBeInTheDocument();
    expect(within(tile(copy.space.headline.flowEfficiency)).getByText("40%")).toBeInTheDocument();
    // 8 of 12 done items have a pull request.
    expect(within(tile(copy.space.headline.linked)).getByText("67%")).toBeInTheDocument();
    expect(within(tile(copy.space.headline.linked)).getByText(copy.space.headline.linkedHint(8, 12))).toBeInTheDocument();
  });

  it("charts throughput and work in progress for finished weeks, each with a legend where needed and a table", async () => {
    const user = userEvent.setup();
    mockReport();
    renderRoute(<SpacePage />, route());
    const throughput = await screen.findByRole("region", { name: copy.space.flow.throughput.title });
    expect(within(throughput).getByText(copy.space.flow.throughput.subtitle)).toBeInTheDocument();
    for (const type of ["Story", "Bug", "Task"]) expect(within(throughput).getAllByText(type).length).toBeGreaterThan(0);
    await user.click(within(throughput).getByText(copy.common.viewAsTable));
    const table = within(throughput).getByRole("table");
    // The running week (19 Jan) is left out. 5 Jan: 3 stories and 1 bug.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(
      within(within(table).getAllByRole("row")[1]!)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["3", "1", "0", "4"]);

    const wip = card(copy.space.flow.wip.title);
    await user.click(within(wip).getByText(copy.common.viewAsTable));
    expect(within(within(wip).getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });

  it("lists ageing work oldest first with issue keys linked to Jira", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    const ageing = await screen.findByRole("region", { name: copy.space.flow.ageing.title });
    const rows = within(ageing).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0]!.textContent)).toEqual([
      `WID-9 ${copy.common.opensInNewTab}`,
      `WID-10 ${copy.common.opensInNewTab}`,
    ]);
    expect(within(ageing).getByRole("link", { name: /WID-9/ })).toHaveAttribute("href", "https://acme.example.test/browse/WID-9");
    expect(within(rows[0]!).getByText("10.0 days")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("In review")).toBeInTheDocument();
  });

  it("shows time per column as a stacked bar with mean, median and items in the table", async () => {
    const user = userEvent.setup();
    mockReport();
    renderRoute(<SpacePage />, route());
    const columns = await screen.findByRole("region", { name: copy.space.columns.chartTitle });
    expect(within(columns).getByText(copy.space.columns.subtitle)).toBeInTheDocument();
    for (const name of ["In progress", "In review", copy.space.columns.notOnBoard]) {
      expect(within(columns).getAllByText(name).length).toBeGreaterThan(0);
    }
    await user.click(within(columns).getByText(copy.common.viewAsTable));
    const table = within(within(columns).getByRole("table"));
    expect(table.getByRole("row", { name: new RegExp(copy.space.columns.notOnBoard) })).toBeInTheDocument();
    const row = table.getByRole("row", { name: /In review/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["10.0 h", "6.0 h", "9"]);
  });

  it("explains the linked share beside idea to production", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    expect(await screen.findByText(copy.space.idea.lede(8, 12, "67%"))).toBeInTheDocument();
    const first = screen.getByRole("heading", { level: 3, name: copy.space.idea.toFirstPr }).closest("article")!;
    expect(within(first).getByText("2.1 days")).toBeInTheDocument();
    expect(within(first).getByText(copy.space.idea.toFirstPrHint("3.8 days", 8))).toBeInTheDocument();
    const prod = screen.getByRole("heading", { level: 3, name: copy.space.idea.toProduction }).closest("article")!;
    expect(within(prod).getByText("4.2 days")).toBeInTheDocument();
  });

  it("shows hygiene cards in a fixed order, with counts, shares and links", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    const hygiene = screen.getByRole("region", { name: copy.space.hygiene.title });
    const titles = within(hygiene)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual(Object.values(copy.space.hygiene.checks).map((c) => c.title));

    const prs = card(copy.space.hygiene.checks.pr_without_key.title);
    expect(within(prs).getByText(copy.space.hygiene.foundOf(2, 8, "25%"))).toBeInTheDocument();
    expect(within(prs).getByRole("link", { name: /acme\/widgets#5/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/5",
    );

    const doneNoPr = card(copy.space.hygiene.checks.done_without_pr.title);
    expect(within(doneNoPr).getByText(copy.space.hygiene.checkThese)).toBeInTheDocument();
    expect(within(doneNoPr).getByRole("link", { name: /WID-1/ })).toHaveAttribute(
      "href",
      "https://acme.example.test/browse/WID-1",
    );

    const skipped = card(copy.space.hygiene.checks.skipped_in_progress.title);
    expect(within(skipped).getByText(copy.space.hygiene.none)).toBeInTheDocument();

    const bulk = card(copy.space.hygiene.checks.bulk_move.title);
    expect(within(bulk).getByText(/^5 moved to done at \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(bulk).getAllByRole("link")).toHaveLength(5);
  });

  it("collapses a long list after ten and shows the rest on request", async () => {
    const user = userEvent.setup();
    mockReport();
    renderRoute(<SpacePage />, route());
    const stale = await screen.findByRole("region", { name: copy.space.hygiene.checks.stale_in_progress.title });
    expect(within(stale).getAllByRole("link")).toHaveLength(10);
    // The label says what pressing does, so the button carries no expanded state that would repeat it.
    const button = within(stale).getByRole("button", { name: copy.space.showAll(12) });
    expect(button).not.toHaveAttribute("aria-expanded");
    await user.click(button);
    expect(within(stale).getAllByRole("link")).toHaveLength(12);
    const fewer = within(stale).getByRole("button", { name: copy.space.showFewer });
    expect(fewer).not.toHaveAttribute("aria-expanded");
    await user.click(fewer);
    expect(within(stale).getAllByRole("link")).toHaveLength(10);
  });

  it("prints every entry of a long list without the button, then collapses again", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    const stale = await screen.findByRole("region", { name: copy.space.hygiene.checks.stale_in_progress.title });
    expect(within(stale).getAllByRole("link")).toHaveLength(10);

    act(() => void window.dispatchEvent(new Event("beforeprint")));
    expect(within(stale).getAllByRole("link")).toHaveLength(12);
    expect(within(stale).queryByRole("button")).not.toBeInTheDocument();

    act(() => void window.dispatchEvent(new Event("afterprint")));
    expect(within(stale).getAllByRole("link")).toHaveLength(10);
    expect(within(stale).getByRole("button", { name: copy.space.showAll(12) })).toBeInTheDocument();
  });

  it("leaves names out by default and does not ask for them", async () => {
    const fetchMock = mockReport();
    renderRoute(<SpacePage />, route());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    expect(screen.queryByText("Ann Example")).not.toBeInTheDocument();
    expect(screen.queryByText(copy.space.hygiene.unassigned)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.space.hygiene.nameNotRecorded)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: copy.space.showPeople })).toHaveAttribute("aria-checked", "false");
    expect(reportUrls(fetchMock).every((u) => !u.searchParams.has("people"))).toBe(true);
  });

  it("asks for names and groups the hygiene lists by assignee when Show people is on", async () => {
    const user = userEvent.setup();
    const fetchMock = mockReport();
    renderRoute(<SpacePage />, route());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    await user.click(screen.getByRole("switch", { name: copy.space.showPeople }));
    await waitFor(() => expect(reportUrls(fetchMock).some((u) => u.searchParams.get("people") === "1")).toBe(true));

    const doneNoPr = await screen.findByRole("region", { name: copy.space.hygiene.checks.done_without_pr.title });
    await waitFor(() => expect(within(doneNoPr).getAllByRole("heading", { level: 4 })).toHaveLength(2));
    const names = within(doneNoPr)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(names).toEqual(["Ann Example", "Zoe Example"]);
    const ann = within(doneNoPr).getByRole("heading", { level: 4, name: "Ann Example" }).parentElement!;
    expect(within(ann).getAllByRole("link")).toHaveLength(2);

    const unassigned = screen.getByRole("region", { name: copy.space.hygiene.checks.in_progress_unassigned.title });
    expect(within(unassigned).getByRole("heading", { level: 4, name: copy.space.hygiene.unassigned })).toBeInTheDocument();
  });

  it("lists assigned work whose name was not recorded under its own heading, not as unassigned", async () => {
    mockReport();
    renderRoute(<SpacePage />, route("?people=1"));
    const reopened = await screen.findByRole("region", { name: copy.space.hygiene.checks.reopened.title });
    await waitFor(() => expect(within(reopened).getAllByRole("heading", { level: 4 })).toHaveLength(2));
    const headings = within(reopened)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Ann Example", copy.space.hygiene.nameNotRecorded]);
    const unnamed = within(reopened).getByRole("heading", { level: 4, name: copy.space.hygiene.nameNotRecorded }).parentElement!;
    expect(within(unnamed).getByRole("link", { name: /WID-31/ })).toBeInTheDocument();
  });

  it("keeps names out of every chart and tile when Show people is on", async () => {
    mockReport();
    renderRoute(<SpacePage />, route("?people=1"));
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    await screen.findAllByText("Ann Example");
    const withName = screen.getAllByText("Ann Example").map((el) => el.closest("section")?.getAttribute("aria-label"));
    const hygieneTitles = Object.values(copy.space.hygiene.checks).map((c) => c.title);
    for (const label of withName) expect(hygieneTitles).toContain(label);
    expect(screen.getByRole("switch", { name: copy.space.showPeople })).toHaveAttribute("aria-checked", "true");
  });

  it("sends the range and leaves out the bots switch", async () => {
    const fetchMock = mockReport();
    renderRoute(<SpacePage />, route("?from=2026-01-01&to=2026-02-01&bots=1"));
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    const url = reportUrls(fetchMock)[0]!;
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-02-01");
    expect(url.searchParams.has("includeBots")).toBe(false);
    expect(screen.queryByRole("switch", { name: copy.range.includeBots })).not.toBeInTheDocument();
  });

  it("offers a PDF report named after the space", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    mockReport();
    renderRoute(<SpacePage />, route());
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).toMatch(/^widgets-delivery-report-\d{4}-\d{2}-\d{2}$/));
  });

  it("never shows another space's report under the next space while that one loads", async () => {
    const user = userEvent.setup();
    let release: (response: MockResponse) => void = () => undefined;
    const gadgets = spaceReport();
    gadgets.space = { ...gadgets.space, id: 2, key: "GAD", name: "Gadgets" };
    mockFetch({
      "GET /api/spaces/1/report": { body: spaceReport() },
      "GET /api/spaces/2/report": () => new Promise<MockResponse>((resolve) => (release = resolve)),
    });
    renderRoute(
      <>
        <SpacePage />
        <Link to="/spaces/2">Next space</Link>
      </>,
      { path: "/spaces/:id", route: "/spaces/1" },
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Widgets" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Next space" }));

    expect(await screen.findByRole("heading", { level: 1, name: copy.space.loadingTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Widgets" })).not.toBeInTheDocument();
    release({ body: gadgets });
    expect(await screen.findByRole("heading", { level: 1, name: "Gadgets" })).toBeInTheDocument();
  });

  it("says so when the space cannot be found", async () => {
    mockFetch({ "GET /api/spaces/7/report": { status: 404, body: { error: "not_found" } } });
    renderRoute(<SpacePage />, route());
    expect(await screen.findByText(copy.space.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.space.toSpaces })).toHaveAttribute("href", "/spaces");
  });

  it("says so when the address does not name a space, without asking the API", () => {
    const fetchMock = mockFetch({});
    for (const address of ["abc", "0", "1.5", "-3"]) {
      const { unmount } = renderRoute(<SpacePage />, { path: "/spaces/:id", route: `/spaces/${address}` });
      expect(screen.getByText(copy.space.notFoundTitle)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.space.toSpaces })).toHaveAttribute("href", "/spaces");
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns that the figures may be out of date, with the reason, when the latest crawl failed", async () => {
    const base = spaceReport();
    mockFetch({
      "GET /api/spaces/7/report": {
        body: { ...base, space: { ...base.space, crawlStatus: "failed", crawlError: "Jira refused the token" } },
      },
    });
    renderRoute(<SpacePage />, route());
    expect(await screen.findByText(copy.space.crawlFailedTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.space.crawlFailedBody)).toBeInTheDocument();
    expect(screen.getByText(copy.space.crawlFailedReason("Jira refused the token"))).toBeInTheDocument();
  });

  it("gives no crawl warning when the latest crawl did not fail", async () => {
    mockReport();
    renderRoute(<SpacePage />, route());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    expect(screen.queryByText(copy.space.crawlFailedTitle)).not.toBeInTheDocument();
  });

  it("warns without a reason when a failed crawl recorded none", async () => {
    const base = spaceReport();
    mockFetch({
      "GET /api/spaces/7/report": { body: { ...base, space: { ...base.space, crawlStatus: "failed", crawlError: null } } },
    });
    renderRoute(<SpacePage />, route());
    expect(await screen.findByText(copy.space.crawlFailedTitle)).toBeInTheDocument();
    expect(screen.queryByText(/The reason given/)).not.toBeInTheDocument();
  });

  it("keeps the previous figures on screen, marked as refreshing, while a new range loads", async () => {
    const user = userEvent.setup();
    let release: (value: MockResponse) => void = () => {};
    const held = new Promise<MockResponse>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mockFetch({
      "GET /api/spaces/7/report": () => (++calls === 1 ? { body: spaceReport() } : held),
    });
    renderRoute(<SpacePage />, route());
    const heading = await screen.findByRole("heading", { level: 1, name: "Widgets" });
    await user.click(screen.getByRole("button", { name: copy.range.last30 }));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("heading", { level: 1, name: "Widgets" })).toBe(heading);
    expect(document.querySelector(".is-refreshing")).not.toBeNull();
    release({ body: spaceReport() });
    await waitFor(() => expect(document.querySelector(".is-refreshing")).toBeNull());
  });

  it("shows an error with a retry for any other failure", async () => {
    mockFetch({ "GET /api/spaces/7/report": { status: 500, body: { error: "boom" } } });
    renderRoute(<SpacePage />, route());
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("says there is nothing to chart when a range holds no finished work", async () => {
    const base = spaceReport();
    mockFetch({
      "GET /api/spaces/7/report": {
        body: { ...base, weekly: [], ageing: [], columns: [], flowEfficiency: null, hygiene: [] },
      },
    });
    renderRoute(<SpacePage />, route());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    expect(within(card(copy.space.flow.throughput.title)).getByText(copy.charts.noData)).toBeInTheDocument();
    expect(within(card(copy.space.columns.chartTitle)).getByText(copy.charts.noData)).toBeInTheDocument();
    expect(screen.getByText(copy.space.flow.ageing.empty)).toBeInTheDocument();
  });
});
