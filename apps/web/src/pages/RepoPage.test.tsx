import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoPage } from "./RepoPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo, report, week } from "../test/fixtures";
import { copy } from "../copy";

const noHealth = { body: { status: "none" } };

const manyPrs = Array.from({ length: 25 }, (_, i) => ({
  ...report().prs[0]!,
  number: i + 1,
  title: `Change ${i + 1}`,
  size: i * 10,
}));

/** jsdom has no scrollIntoView, so a test stubs it; this puts the prototype back however that test ends. */
const realScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

describe("RepoPage", () => {
  afterEach(() => {
    if (realScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", realScrollIntoView);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("offers a PDF report named after the repository once the report has loaded", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).not.toBe(""));
    expect(printedAs).toMatch(/^acme-widgets-delivery-report-\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves the pull request table out of the PDF report but keeps the authors table", async () => {
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const prs = await screen.findByRole("heading", { level: 2, name: copy.prTable.title });
    expect(prs.closest("section")).toHaveClass("screen-only");
    const authors = screen.getByRole("heading", { level: 2, name: copy.authors.title });
    expect(authors.closest("section")).not.toHaveClass("screen-only");
  });

  it("shows the DORA tiles, flow tiles and charts for a repository", async () => {
    const fetchMock = mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo({ crawlStatus: "crawling" })] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1?from=2026-01-01&bots=1" });
    expect(await screen.findByRole("heading", { level: 1, name: "acme/widgets" })).toBeInTheDocument();
    expect(screen.getByText(copy.dora.perWeek("1"))).toBeInTheDocument();
    expect(screen.getByText(copy.dora.failureCount(1, 4))).toBeInTheDocument();
    expect(screen.getAllByText("High").length).toBe(3);
    expect(screen.getByText(copy.flow.coding)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.charts.scatter.title })).toBeInTheDocument();
    expect(await screen.findByText(copy.repo.crawlInProgress)).toBeInTheDocument();
    const reportUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/report"));
    expect(reportUrl).toContain("from=2026-01-01");
    expect(reportUrl).toContain("includeBots=1");
  });

  describe("the week the range ends part way through", () => {
    afterEach(() => vi.useRealTimers());

    const showReport = (body: ReturnType<typeof report>) => {
      mockFetch({
        "GET /api/repos/1/report": { body },
        "GET /api/repos/1/code-health": noHealth,
        "GET /api/repos": { body: [repo()] },
      });
      renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    };
    const chart = (title: string) => screen.getByRole("region", { name: title });
    const cellsFor = (table: HTMLElement, week: string) =>
      within(within(table).getByRole("rowheader", { name: week }).closest("tr")!)
        .getAllByRole("cell")
        .map((c) => c.textContent);

    it("stays on every weekly chart, marked so far while it is under way, and the page says why", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-21T15:00:00Z"));
      const weekly = [
        week({ week: "2026-01-12", weekIndex: 0 }),
        week({ week: "2026-01-19", weekIndex: 1, opened: 4, merged: 3, deploys: 12, partial: true }),
      ];
      showReport(report({ weekly, range: { from: "2026-01-12T00:00:00Z", to: "2026-01-21T14:00:00Z" } }));
      expect(
        await screen.findByText(
          "The week starting 19 Jan is not over yet, so its figures are marked so far. Its counts are drawn lighter inside an outline, because a part week holds fewer pull requests and deploys than a whole one.",
        ),
      ).toBeInTheDocument();
      const counts = within(chart(copy.charts.openedVsMerged.title)).getByRole("table");
      expect(cellsFor(counts, "19 Jan, so far")).toEqual(["4", "3"]);
      expect(cellsFor(counts, "12 Jan")).toEqual(["2", "2"]);
      const deploys = within(chart(copy.charts.deploys.title)).getByRole("table");
      expect(cellsFor(deploys, "19 Jan, so far")).toEqual(["12", "0"]);
      for (const title of [copy.charts.weeklyOpenToMerge.title, copy.charts.stages.title]) {
        expect(
          within(within(chart(title)).getByRole("table")).getByRole("rowheader", { name: "19 Jan, so far" }),
        ).toBeInTheDocument();
      }
      for (const title of [copy.charts.openedVsMerged.title, copy.charts.deploys.title]) {
        const swatch = within(chart(title))
          .getByText("Week starting 19 Jan, so far")
          .querySelector<HTMLElement>(".legend-swatch");
        expect(swatch).toHaveClass("legend-swatch-part");
        expect(swatch?.style.borderColor).toBe("var(--text-muted)");
      }
      for (const title of [copy.charts.weeklyOpenToMerge.title, copy.charts.stages.title]) {
        expect(within(chart(title)).queryByText("Week starting 19 Jan, so far")).not.toBeInTheDocument();
      }
    });

    it("gives the day a past range stops at instead of so far", async () => {
      const weekly = [week({ week: "2026-01-12", weekIndex: 0 }), week({ week: "2026-01-19", weekIndex: 1, partial: true })];
      showReport(report({ weekly, range: { from: "2026-01-12T00:00:00Z", to: "2026-01-21T23:59:59Z" } }));
      expect(
        await screen.findByText(
          "The range ends on 21 Jan, part way through the week starting 19 Jan, so that week's figures stop there. Its counts are drawn lighter inside an outline, because a part week holds fewer pull requests and deploys than a whole one.",
        ),
      ).toBeInTheDocument();
      const counts = within(chart(copy.charts.openedVsMerged.title)).getByRole("table");
      expect(cellsFor(counts, "19 Jan, to 21 Jan")).toEqual(["2", "2"]);
      expect(screen.queryByText(/so far/)).not.toBeInTheDocument();
    });

    it("fills the charts of a young repository whose only week is the part week", async () => {
      const weekly = [week({ week: "2026-01-19", weekIndex: 0, opened: 3, merged: 1, deploys: 2, partial: true })];
      showReport(report({ weekly, range: { from: "2026-01-19T09:00:00Z", to: "2026-01-21T23:59:59Z" } }));
      await screen.findByText(/part way through the week starting 19 Jan/);
      for (const title of [copy.charts.openedVsMerged.title, copy.charts.deploys.title]) {
        expect(within(chart(title)).queryByText(copy.charts.noData)).not.toBeInTheDocument();
      }
      expect(cellsFor(within(chart(copy.charts.openedVsMerged.title)).getByRole("table"), "19 Jan, to 21 Jan")).toEqual([
        "3",
        "1",
      ]);
      expect(cellsFor(within(chart(copy.charts.deploys.title)).getByRole("table"), "19 Jan, to 21 Jan")).toEqual(["2", "0"]);
    });

    it("draws the part week's count bars lighter inside an outline, and every other bar in full", async () => {
      const weekly = [week({ week: "2026-01-12", weekIndex: 0 }), week({ week: "2026-01-19", weekIndex: 1, partial: true })];
      // Recharts draws bars at full height straight away for a reader who prefers reduced motion; jsdom never runs its animation.
      const realMatchMedia = window.matchMedia;
      window.matchMedia = (query: string) => ({ ...realMatchMedia(query), matches: query.includes("prefers-reduced-motion") });
      onTestFinished(() => {
        window.matchMedia = realMatchMedia;
      });
      showReport(report({ weekly, range: { from: "2026-01-12T00:00:00Z", to: "2026-01-21T23:59:59Z" } }));
      await screen.findByText(/part way through the week starting 19 Jan/);
      // Opened and merged draw a bar each for both weeks; deploys draw one for each week, as no deploy failed.
      for (const [title, bars] of [
        [copy.charts.openedVsMerged.title, 4],
        [copy.charts.deploys.title, 2],
      ] as const) {
        const card = chart(title);
        await waitFor(() => expect(card.querySelectorAll(".recharts-bar-rectangle path")).toHaveLength(bars));
        const pale = card.querySelectorAll('.recharts-bar-rectangle path[fill-opacity="0.35"]');
        expect(pale).toHaveLength(bars / 2);
        for (const path of pale) expect(path.getAttribute("stroke")).toBe(path.getAttribute("fill"));
      }
    });

    it("is not mentioned when the range ends with a whole week", async () => {
      showReport(report());
      const counts = within(await screen.findByRole("region", { name: copy.charts.openedVsMerged.title })).getByRole("table");
      expect(cellsFor(counts, "19 Jan")).toEqual(["2", "2"]);
      expect(screen.queryByText(/not over yet|part way through the week/)).not.toBeInTheDocument();
      expect(screen.queryByText(/so far|, to /)).not.toBeInTheDocument();
    });
  });

  it("explains why DORA measures are missing when no deploy workflow is configured", async () => {
    const base = report();
    mockFetch({
      "GET /api/repos/1/report": {
        body: {
          ...base,
          repo: { ...base.repo, deployWorkflows: [] },
          dora: { ...base.dora, deploymentFrequency: null, leadTime: null, changeFailure: null, timeToRestore: null },
        },
      },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    expect(await screen.findAllByText(copy.dora.notMeasured)).toHaveLength(5);
    expect(screen.getAllByText(copy.dora.reasons.noWorkflow)).toHaveLength(4);
  });

  it("explains each measured DORA tile, and only those", async () => {
    const base = report();
    mockFetch({
      "GET /api/repos/1/report": {
        body: { ...base, dora: { ...base.dora, leadTime: null, timeToRestore: null } },
      },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const frequency = (await screen.findByRole("heading", { name: copy.dora.deploymentFrequency })).closest("article")!;
    expect(within(frequency).getByText(copy.dora.explain.summary)).toBeInTheDocument();
    const failure = screen.getByRole("heading", { name: copy.dora.changeFailure }).closest("article")!;
    expect(within(failure).getByText(copy.dora.explain.summary)).toBeInTheDocument();
    for (const title of [copy.dora.leadTime, copy.dora.timeToRestore, copy.dora.rework]) {
      const tile = screen.getByRole("heading", { name: title }).closest("article")!;
      expect(within(tile).queryByText(copy.dora.explain.summary)).not.toBeInTheDocument();
    }
    expect(screen.getAllByText(copy.dora.explain.summary)).toHaveLength(2);
  });

  it("shows the gap and a practice link when a tile's explanation is opened", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const failure = (await screen.findByRole("heading", { name: copy.dora.changeFailure })).closest("article")!;
    await user.click(within(failure).getByText(copy.dora.explain.summary));
    expect(within(failure).getByText(/25% of deploys failed\. The Medium band needs 15% or less/)).toBeInTheDocument();
    expect(within(failure).getByRole("link", { name: /Test automation/ })).toHaveAttribute(
      "href",
      "https://dora.dev/capabilities/test-automation/",
    );
  });

  it("scrolls to the DORA section when the address names it", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1#dora-title" });
    await screen.findByRole("heading", { name: copy.dora.title });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it("names the profile with a link to its source that opens in a new tab", async () => {
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const link = await screen.findByRole("link", { name: /DORA 2023/ });
    expect(link.closest("p")).toHaveTextContent(`${copy.dora.profileLead} DORA 2023`);
    expect(link).toHaveAttribute("href", report().dora.profile.source.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows the rework rate beside change failure with no band", async () => {
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const tile = (await screen.findByRole("heading", { name: copy.dora.rework })).closest("article")!;
    expect(within(tile).getByText("25%")).toBeInTheDocument();
    expect(within(tile).getByText(copy.dora.reworkCount(1, 4))).toBeInTheDocument();
    expect(within(tile).getByText(copy.dora.reworkNoBand)).toBeInTheDocument();
    expect(within(tile).queryByText(/Elite|High|Medium|Low/)).not.toBeInTheDocument();
  });

  it("says the rework rate is not measured when the report has none", async () => {
    const base = report();
    mockFetch({
      "GET /api/repos/1/report": {
        body: { ...base, dora: { ...base.dora, changeFailure: { ...base.dora.changeFailure!, rework: null } } },
      },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const tile = (await screen.findByRole("heading", { name: copy.dora.rework })).closest("article")!;
    expect(within(tile).getByText(copy.dora.notMeasured)).toBeInTheDocument();
    expect(within(tile).getByText(copy.dora.reasons.noRework)).toBeInTheDocument();
  });

  it("compares AI-assisted with unassisted work and states the rule, the floor and the unknown count", async () => {
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const table = await screen.findByRole("table", { name: copy.aiCohorts.caption });
    expect(within(table).getByRole("columnheader", { name: copy.aiCohorts.assisted })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: copy.aiCohorts.unassisted })).toBeInTheDocument();
    const median = within(table).getByRole("row", { name: new RegExp(copy.aiCohorts.medianCycle) });
    expect(
      within(median)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["4.0 h", "10.0 h"]);
    const reviewed = within(table).getByRole("row", { name: new RegExp(copy.aiCohorts.reviewed) });
    expect(
      within(reviewed)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["100%", "50%"]);
    expect(screen.getByText(copy.aiCohorts.rule)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy.aiCohorts.unknownHint))).toHaveTextContent(copy.aiCohorts.unknown(3));
  });

  it("shows No data for cohort figures that could not be taken and hides the unknown note at zero", async () => {
    const base = report();
    const empty = {
      prs: 0,
      medianCycleHours: null,
      p75CycleHours: null,
      medianSize: null,
      reviewedShare: null,
      revertShare: null,
    };
    mockFetch({
      "GET /api/repos/1/report": {
        body: { ...base, aiCohorts: { assisted: empty, unassisted: base.aiCohorts.unassisted, unknown: 0 } },
      },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const table = await screen.findByRole("table", { name: copy.aiCohorts.caption });
    const median = within(table).getByRole("row", { name: new RegExp(copy.aiCohorts.medianCycle) });
    expect(within(median).getAllByRole("cell")[0]).toHaveTextContent(copy.common.notAvailable);
    expect(screen.queryByText(new RegExp(copy.aiCohorts.unknownHint))).not.toBeInTheDocument();
  });

  it("sends the profile from the address to the API", async () => {
    const fetchMock = mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1?profile=dora-2023" });
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    const reportUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/report"));
    expect(reportUrl).toContain("profile=dora-2023");
  });

  it("sorts and pages the pull request table", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/repos/1/report": { body: report({ prs: manyPrs }) },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const table = await screen.findByRole("table", { name: copy.prTable.title });
    expect(screen.getByText(copy.prTable.pageOf(1, 2))).toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: copy.prTable.size }));
    expect(within(table).getByRole("columnheader", { name: copy.prTable.size })).toHaveAttribute("aria-sort", "descending");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Change 25");
    await user.click(within(table).getByRole("button", { name: copy.prTable.size }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Change 1");

    await user.click(screen.getByRole("button", { name: copy.prTable.next }));
    expect(screen.getByText(copy.prTable.pageOf(2, 2))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.prTable.previous }));
    expect(screen.getByText(copy.prTable.pageOf(1, 2))).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: copy.prTable.author }));
    expect(within(table).getByRole("columnheader", { name: copy.prTable.author })).toHaveAttribute("aria-sort", "ascending");
  });

  it("leaves unticked authors out of the whole report, and offers everyone or no one", async () => {
    const user = userEvent.setup();
    const prs = manyPrs.map((pr) => ({ ...pr, author: pr.number % 5 === 0 ? "ade" : "bea" }));
    const choices = [
      { author: "bea", opened: 20 },
      { author: "ade", opened: 5 },
    ];
    // Stands in for the API: it drops the excluded authors and marks them in the choices.
    const fetchMock = mockFetch({
      "GET /api/repos/1/report": (url) => {
        const excluded = (url.searchParams.get("excludeAuthors") ?? "").split(",");
        return {
          body: report({
            prs: prs.filter((pr) => !excluded.includes(pr.author!)),
            authorChoices: choices.map((c) => ({ ...c, excluded: excluded.includes(c.author) })),
          }),
        };
      },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    const lastReportUrl = () =>
      new URL(
        String(
          fetchMock.mock.calls
            .map((c) => c[0])
            .filter((u) => String(u).includes("/report"))
            .at(-1),
        ),
        "http://localhost",
      );
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const table = await screen.findByRole("table", { name: copy.prTable.title });
    expect(within(table).getAllByRole("row")).toHaveLength(21);

    const menu = screen.getByText(copy.authorFilter.summary(2, 2));
    await user.click(menu);
    const list = screen.getByRole("group", { name: copy.authorFilter.legend });
    expect(
      within(list)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual([`bea${copy.authorFilter.opened(20)}`, `ade${copy.authorFilter.opened(5)}`]);

    await user.click(within(list).getByRole("checkbox", { name: /^bea/ }));
    expect(await screen.findByText(copy.repo.excludingAuthors(["bea"]))).toBeInTheDocument();
    expect(lastReportUrl().searchParams.get("excludeAuthors")).toBe("bea");
    expect(screen.getByText(copy.authorFilter.summary(1, 2))).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(6));

    await user.click(screen.getByRole("button", { name: copy.authorFilter.none }));
    expect(await screen.findByText(copy.authorFilter.noneChosen)).toBeInTheDocument();
    expect(lastReportUrl().searchParams.get("excludeAuthors")).toBe("bea,ade");
    expect(screen.getByRole("button", { name: copy.authorFilter.none })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: copy.authorFilter.all }));
    await waitFor(() => expect(screen.queryByText(copy.authorFilter.noneChosen)).not.toBeInTheDocument());
    expect(lastReportUrl().searchParams.has("excludeAuthors")).toBe(false);
    expect(screen.queryByText(copy.repo.excludingAuthors(["bea"]))).not.toBeInTheDocument();
  });

  it("closes the authors menu on Escape and on a click elsewhere", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1?exclude=grace" });
    const summary = await screen.findByText(copy.authorFilter.summary(1, 2));
    const menu = summary.closest("details")!;
    expect(screen.getByText(copy.repo.excludingAuthors(["grace"]))).toBeInTheDocument();

    await user.click(summary);
    expect(menu.open).toBe(true);
    expect(screen.getByRole("checkbox", { name: /^grace/ })).not.toBeChecked();
    await user.keyboard("{Escape}");
    expect(menu.open).toBe(false);
    expect(summary).toHaveFocus();

    await user.click(summary);
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(menu.open).toBe(false);
  });

  it("prints every pull request rather than the page on screen, then returns to paging", async () => {
    mockFetch({
      "GET /api/repos/1/report": { body: report({ prs: manyPrs }) },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    const table = await screen.findByRole("table", { name: copy.prTable.title });
    expect(within(table).getAllByRole("row")).toHaveLength(21);

    act(() => void window.dispatchEvent(new Event("beforeprint")));
    expect(within(table).getAllByRole("row")).toHaveLength(26);
    expect(screen.queryByText(copy.prTable.pageOf(1, 2))).not.toBeInTheDocument();

    act(() => void window.dispatchEvent(new Event("afterprint")));
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    expect(screen.getByText(copy.prTable.pageOf(1, 2))).toBeInTheDocument();
  });

  it("applies a date preset", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    await user.click(screen.getByRole("button", { name: copy.range.last30 }));
    expect(screen.getByRole("button", { name: copy.range.last30 })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("from="))).toBe(true);
  });

  it("shows the API error message", async () => {
    mockFetch({
      "GET /api/repos/1/report": { status: 404, body: { error: "Unknown repository" } },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    expect(await screen.findByText("Unknown repository")).toBeInTheDocument();
  });

  it("says so when the address does not name a repository, without asking the API", () => {
    const fetchMock = mockFetch({});
    for (const address of ["abc", "0", "1.5", "-3"]) {
      const { unmount } = renderRoute(<RepoPage />, { path: "/repos/:id", route: `/repos/${address}` });
      expect(screen.getByText(copy.repo.notFound)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.repo.toRepos })).toHaveAttribute("href", "/repos");
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RepoPage GitHub Issues link", () => {
  const open = async (listing: ReturnType<typeof repo>) => {
    mockFetch({
      "GET /api/repos/1/report": { body: report() },
      "GET /api/repos/1/code-health": noHealth,
      "GET /api/repos": { body: [listing] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
  };

  it("links to the repository's GitHub Issues page when it has issues", async () => {
    await open(repo({ issues: 12 }));
    expect(await screen.findByRole("link", { name: copy.repo.issuesLink })).toHaveAttribute("href", "/issues/1");
  });

  it("leaves the link out when the repository has no issues", async () => {
    await open(repo({ issues: 0 }));
    await waitFor(() => expect(screen.getByRole("button", { name: copy.report.download })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: copy.repo.issuesLink })).not.toBeInTheDocument();
  });
});
