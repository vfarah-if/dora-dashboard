import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodeDetailReport } from "@dora-dashboard/core";
import { CodeAnalysisPage } from "./CodeAnalysisPage";
import { PRINT_CHART_WIDTH } from "../components/chartParts";
import { mockFetch, renderRoute, type Handler } from "../test/render";
import { codeDetailReport, codeHealthReport, coverageOk, repo } from "../test/fixtures";
import { isoDaysAgo } from "../lib/format";
import { copy } from "../copy";

const c = copy.codeAnalysis;

function show(body: unknown, { status = 200, route = "/repos/1/code" }: { status?: number; route?: string } = {}) {
  const detail: Handler = () => ({ body, status });
  const fetchMock = mockFetch({
    "GET /api/repos/1/code-detail": detail,
    "GET /api/repos/1/code-health": { body: codeHealthReport() },
    "GET /api/repos": { body: [repo()] },
  });
  const rendered = renderRoute(<CodeAnalysisPage />, { path: "/repos/:id/code", route });
  return { fetchMock, ...rendered };
}

const detailUrls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls
    .map((call) => new URL(String(call[0]), "http://localhost"))
    .filter((u) => u.pathname.endsWith("code-detail"));

const withCoverage = (coverage: CodeDetailReport["coverage"], overrides: Partial<CodeDetailReport> = {}) =>
  codeDetailReport({ coverage, ...overrides });

afterEach(() => {
  document.title = "";
  document.documentElement.classList.remove("is-printing");
  vi.restoreAllMocks();
});

describe("CodeAnalysisPage", () => {
  it("shows a loading state before the analysis arrives", async () => {
    show(codeDetailReport());
    expect(screen.getByText(c.loading)).toBeInTheDocument();
    await screen.findByRole("heading", { name: c.areas.packagesTitle });
  });

  it("invites a crawl when nothing has been analysed", async () => {
    show({ status: "none" });
    expect(await screen.findByText(c.none.title)).toBeInTheDocument();
    expect(screen.getByText(c.none.body)).toBeInTheDocument();
  });

  it("shows the API message once when the analysis has never succeeded", async () => {
    show({ status: "error", message: "The clone timed out.", analysedAt: "2026-03-01T10:00:00Z", reason: "failed" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(c.error.title);
    expect(alert.textContent!.match(/The clone timed out\./g)).toHaveLength(1);
    expect(alert).toHaveTextContent(c.error.when("1 Mar 2026, 10:00"));
  });

  it("shows the request failure and offers a retry", async () => {
    show({ error: "Unknown repository" }, { status: 404 });
    expect(await screen.findByText("Unknown repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("answers an address that names no repository without asking the API", () => {
    const fetchMock = mockFetch({});
    renderRoute(<CodeAnalysisPage />, { path: "/repos/:id/code", route: "/repos/abc/code" });
    expect(screen.getByText(c.notFound)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("with a report", () => {
    it("shows the commit, the repository grade as text and the detail sections in order", async () => {
      show(codeDetailReport());
      expect(await screen.findByText(c.analysedAt("abcdef0", "1 Mar 2026, 10:00"))).toBeInTheDocument();
      expect(await screen.findByText(c.gradeLine)).toBeInTheDocument();
      expect(screen.getByText(c.gradeLine).closest("p")).toHaveTextContent("Low");
      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(headings).toEqual([c.areas.packagesTitle, c.scope.titleWhole, c.coverage.title]);
    });

    it("calls the areas folders when the repository is not a monorepo", async () => {
      show(codeDetailReport({ mode: "folder" }));
      expect(await screen.findByRole("heading", { name: c.areas.foldersTitle })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: c.areas.packagesTitle })).not.toBeInTheDocument();
    });

    it("gives each area a maintainability band as text and says an area has no overall grade", async () => {
      show(codeDetailReport());
      const table = await screen.findByRole("table", { name: c.areas.packagesTitle });
      expect(within(table).getByRole("row", { name: /apps\/api/ })).toHaveTextContent("Low");
      expect(within(table).getByRole("row", { name: /packages\/core/ })).toHaveTextContent("Elite");
      expect(screen.getByText(c.areas.bandNote)).toBeInTheDocument();
    });

    it("draws the areas chart with a table behind it and no extra headings from the legend", async () => {
      show(codeDetailReport());
      const card = await screen.findByRole("region", { name: c.areas.chart.title });
      expect(card).toHaveTextContent(c.areas.chart.subtitle(10));
      const table = within(card).getByRole("table", { name: c.areas.chart.title });
      expect(within(table).getByRole("row", { name: /apps\/api/ })).toHaveTextContent("41");
    });

    it("draws the areas chart at the printed page's width while printing, and only then", async () => {
      show(codeDetailReport());
      const card = await screen.findByRole("region", { name: c.areas.chart.title });
      const surface = () => card.querySelector("svg.recharts-surface");
      expect(surface()).toHaveAttribute("width", "800");
      act(() => void window.dispatchEvent(new Event("beforeprint")));
      expect(surface()).toHaveAttribute("width", String(PRINT_CHART_WIDTH));
      act(() => void window.dispatchEvent(new Event("afterprint")));
      expect(surface()).toHaveAttribute("width", "800");
    });

    it("shows the scope's tiles, maintainability band as text and each check", async () => {
      show(codeDetailReport());
      await screen.findByRole("heading", { name: c.scope.titleWhole });
      const tile = (label: string) => screen.getByRole("heading", { name: label }).closest("article")!;
      expect(tile(copy.codeHealth.detail.above(10))).toHaveTextContent("18 (15.0%)");
      const checks = screen.getByRole("heading", { name: c.scope.checks.title }).closest("section")!;
      expect(checks).toHaveTextContent(c.scope.checks.bandLabel);
      expect(checks).toHaveTextContent("Low");
      expect(checks).toHaveTextContent(c.scope.checks.bandNote);
      expect(checks).toHaveTextContent("12 functions are longer than 60 lines, the longest being RepoCharts at 233 lines");
      expect(screen.getByRole("heading", { name: copy.codeHealth.start.title })).toBeInTheDocument();
    });

    it("lists the scope's functions with their area and keeps that table out of the printed report", async () => {
      show(codeDetailReport());
      const table = await screen.findByRole("table", { name: c.functions.title });
      expect(within(table).getByRole("row", { name: /runPipeline/ })).toHaveTextContent("apps/api/src/pipeline.ts:42");
      expect(table.closest("section")).toHaveClass("screen-only");
    });

    it("names the root area readably in the function table", async () => {
      const base = codeDetailReport();
      show({ ...base, functions: { total: 1, items: [{ ...base.functions.items[0]!, area: "." }] } });
      const table = await screen.findByRole("table", { name: c.functions.title });
      expect(table).toHaveTextContent(c.areas.root);
    });

    it("says when the scope has no source functions", async () => {
      show(codeDetailReport({ scope: { ...codeDetailReport().scope, functions: 0 } }));
      expect(await screen.findByText(c.scope.empty)).toBeInTheDocument();
    });

    it("warns about partly measured files in scope", async () => {
      show(codeDetailReport({ scope: { ...codeDetailReport().scope, partlyMeasured: ["apps/web/src/A.tsx"] } }));
      const notice = (await screen.findByText(c.scope.partly.title)).closest("aside")!;
      expect(notice).toHaveTextContent(c.scope.partly.body(1));
    });

    it("warns quietly when a newer analysis failed", async () => {
      show(codeDetailReport({ lastError: { message: "clone failed", analysedAt: "2026-03-08T09:00:00Z", reason: "failed" } }));
      const notice = (await screen.findByText(c.staleTitle)).closest("aside")!;
      expect(notice).toHaveTextContent(c.stale("1 Mar 2026", "8 Mar 2026", "clone failed"));
    });
  });

  describe("areas in the address", () => {
    it("sends the area from the address to the API and marks that row as selected", async () => {
      const { fetchMock } = show(codeDetailReport({ area: "packages/core" }), { route: "/repos/1/code?area=packages%2Fcore" });
      const table = await screen.findByRole("table", { name: c.areas.packagesTitle });
      expect(detailUrls(fetchMock)[0]!.searchParams.get("area")).toBe("packages/core");
      const link = within(table).getByRole("link", { name: "packages/core" });
      expect(link).toHaveAttribute("aria-current", "true");
      expect(within(table).getByRole("row", { name: /packages\/core/ })).toHaveTextContent(c.areas.table.selected);
      expect(screen.getByRole("heading", { name: c.scope.titleArea("packages/core") })).toBeInTheDocument();
    });

    it("sets the area in the address when a row is chosen, keeping the range, and asks the API for it", async () => {
      const user = userEvent.setup();
      const { fetchMock } = show(codeDetailReport(), { route: "/repos/1/code?from=2026-01-01&to=2026-02-01" });
      const table = await screen.findByRole("table", { name: c.areas.packagesTitle });
      const link = within(table).getByRole("link", { name: "packages/core" });
      expect(link).toHaveAttribute("href", "/repos/1/code?from=2026-01-01&to=2026-02-01&area=packages%2Fcore");

      await user.click(link);
      await waitFor(() => expect(detailUrls(fetchMock).some((u) => u.searchParams.get("area") === "packages/core")).toBe(true));
    });

    it("links the whole repository back without the area", async () => {
      show(codeDetailReport({ area: "apps/api" }), { route: "/repos/1/code?area=apps%2Fapi&from=2026-01-01" });
      const link = await screen.findByRole("link", { name: c.areas.wholeRepository });
      expect(link).toHaveAttribute("href", "/repos/1/code?from=2026-01-01");
    });

    it("keeps the range on the back link and drops the area", async () => {
      show(codeDetailReport(), { route: "/repos/1/code?from=2026-01-01&to=2026-02-01&bots=1&area=apps%2Fapi" });
      const back = await screen.findByRole("link", { name: c.backToRepo });
      expect(back).toHaveAttribute("href", "/repos/1?from=2026-01-01&to=2026-02-01&bots=1");
    });

    it("explains an area that was not found and offers the whole repository", async () => {
      const user = userEvent.setup();
      const { fetchMock } = show(codeDetailReport({ missingArea: "gone/away" }), { route: "/repos/1/code?area=gone%2Faway" });
      const notice = (await screen.findByText(c.missingArea.title)).closest("aside")!;
      expect(notice).toHaveTextContent(c.missingArea.body("gone/away"));
      await user.click(within(notice).getByRole("button", { name: c.missingArea.clear }));
      await waitFor(() => expect(detailUrls(fetchMock).some((u) => !u.searchParams.has("area"))).toBe(true));
    });

    it("explains that older snapshots guess the areas and a crawl will find workspaces", async () => {
      show(codeDetailReport({ mode: "unknown" }));
      const notice = (await screen.findByText(c.unknownMode.title)).closest("aside")!;
      expect(notice).toHaveTextContent("Crawl this repository again to find its workspaces");
    });

    it("says there are no areas when the list is empty", async () => {
      show(codeDetailReport({ areas: { items: [], total: 0 } }));
      expect(await screen.findByText(c.areas.empty)).toBeInTheDocument();
    });

    it("says when only the largest areas are listed", async () => {
      const base = codeDetailReport();
      show({ ...base, areas: { ...base.areas, total: 305 } });
      expect(await screen.findByText(c.areas.capped(2, 305))).toBeInTheDocument();
    });
  });

  describe("coverage", () => {
    it("explains the artefact, the deploy branch, the formats and the crawl when nothing has been read", async () => {
      show(codeDetailReport());
      const empty = (await screen.findByText(c.coverage.empty.title)).closest(".empty-state")!;
      expect(empty).toHaveTextContent(c.coverage.empty.intro);
      expect(empty).toHaveTextContent("The artefact name must contain the word coverage");
      expect(empty).toHaveTextContent("lcov.info, coverage-final.json, coverage-summary.json or a Cobertura XML file");
      expect(empty).toHaveTextContent("deploy branch");
      expect(empty).toHaveTextContent("read on the next crawl");
    });

    it("shows a failed read that has no earlier figures", async () => {
      show(withCoverage({ status: "error", message: "Artefact expired", fetchedAt: "2026-03-02T10:00:00Z" }));
      const alert = (await screen.findAllByRole("alert"))[0]!;
      expect(alert).toHaveTextContent(c.coverage.error.body("Artefact expired", "2 Mar 2026"));
    });

    it("shows tiles for lines, branches and functions with what each means", async () => {
      show(withCoverage(coverageOk()));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      const tile = (label: string) => screen.getByRole("heading", { name: label }).closest("article")!;
      expect(tile(c.coverage.tiles.lines)).toHaveTextContent("80%");
      expect(tile(c.coverage.tiles.lines)).toHaveTextContent("80 of 100 lines that can run were run by the tests.");
      expect(tile(c.coverage.tiles.branches)).toHaveTextContent("50%");
      expect(tile(c.coverage.tiles.functions)).toHaveTextContent("90%");
      expect(screen.getByText(/Read from coverage-api, run 77, on 1 Mar 2026, 12:00, in lcov format\./)).toBeInTheDocument();
      expect(screen.queryByText(c.coverage.otherCommit.title)).not.toBeInTheDocument();
    });

    it("leaves the creation time out when no artefact carried one", async () => {
      show(withCoverage(coverageOk({ source: { ...okSource(), createdAt: null } })));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      expect(screen.getByText(/Read from coverage-api/)).not.toHaveTextContent("created");
    });

    it("says a figure is not reported when the report does not carry it", async () => {
      show(withCoverage(coverageOk({ branches: null })));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      const tile = screen.getByRole("heading", { name: c.coverage.tiles.branches }).closest("article")!;
      expect(tile).toHaveTextContent(c.coverage.tiles.notReported);
      expect(tile).toHaveTextContent(c.coverage.tiles.notReportedHint);
    });

    it("warns when the coverage was measured on a different commit", async () => {
      show(withCoverage(coverageOk({ otherCommit: true, source: { ...okSource(), commitSha: "1234567890abcdef" } })));
      const notice = (await screen.findByText(c.coverage.otherCommit.title)).closest("aside")!;
      expect(notice).toHaveTextContent(c.coverage.otherCommit.body("1234567", "abcdef0"));
    });

    it("labels each line level table when the coverage is from a different commit", async () => {
      const base = codeDetailReport({ coverage: coverageOk({ otherCommit: true }) });
      show({ ...base, functions: { total: 1, items: [{ ...base.functions.items[0]!, coverage: 0.5 }] } });
      const tables = [c.coverage.least.title, c.coverage.untested.title, c.functions.title];
      for (const name of tables) {
        const heading = await screen.findByRole("heading", { name });
        expect(heading.closest("section")!.querySelector('[role="note"]')).toHaveTextContent(c.coverage.lineNote);
      }
      expect(screen.getAllByRole("note")).toHaveLength(3);
    });

    it("adds no line note when the coverage is from the analysed commit", async () => {
      show(withCoverage(coverageOk()));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("says when the newest report was created, and leaves that out when it is not known", async () => {
      show(withCoverage(coverageOk()));
      expect(await screen.findByText(/The newest report was created on 28 Feb 2026, 16:30\./)).toBeInTheDocument();
    });

    it("warns, without a sha, when the commit of the coverage is not known", async () => {
      show(withCoverage(coverageOk({ otherCommit: true, source: { ...okSource(), commitSha: null } })));
      const notice = (await screen.findByText(c.coverage.otherCommit.title)).closest("aside")!;
      expect(notice).toHaveTextContent(c.coverage.otherCommit.body(null, "abcdef0"));
    });

    it("warns that the latest read failed and keeps the earlier figures", async () => {
      show(withCoverage(coverageOk({ lastError: { message: "Artefact expired", fetchedAt: "2026-03-02T10:00:00Z" } })));
      const notice = (await screen.findByText(c.coverage.lastError.title)).closest("aside")!;
      expect(notice).toHaveTextContent(c.coverage.lastError.body("Artefact expired", "2 Mar 2026"));
      expect(screen.getByRole("heading", { name: c.coverage.tiles.lines })).toBeInTheDocument();
    });

    it("lists the least covered files with their uncovered ranges written as 'first to last'", async () => {
      show(withCoverage(coverageOk()));
      const table = await screen.findByRole("table", { name: c.coverage.least.title });
      const row = within(table).getByRole("row", { name: /pipeline\.ts/ });
      expect(row).toHaveTextContent("10 of 40");
      expect(row).toHaveTextContent("12 to 30, 44");
    });

    it("says how many ranges and files were left off", async () => {
      const ok = coverageOk() as Extract<CodeDetailReport["coverage"], { status: "ok" }>;
      const file = { ...ok.leastCovered.items[0]!, uncovered: { items: [[1, 2]] as [number, number][], total: 4 } };
      show(withCoverage({ ...ok, leastCovered: { items: [file], total: 60 } }));
      const table = await screen.findByRole("table", { name: c.coverage.least.title });
      expect(table).toHaveTextContent("1 to 2 and 3 more");
      expect(screen.getByText(c.coverage.least.capped(1, 60))).toBeInTheDocument();
    });

    it("says totals only when the report carries no line detail", async () => {
      show(withCoverage(coverageOk({ lineDetail: false })));
      expect(await screen.findByText(c.coverage.totalsOnly)).toBeInTheDocument();
      const table = screen.getByRole("table", { name: c.coverage.least.title });
      expect(table).not.toHaveTextContent("12 to 30");
    });

    it("lists the files that are not in the report, and the complex functions with no coverage", async () => {
      show(withCoverage(coverageOk()));
      const missing = await screen.findByRole("table", { name: c.coverage.notInReport.title });
      expect(within(missing).getByRole("row", { name: /orphan\.ts/ })).toHaveTextContent("25");
      const untested = screen.getByRole("table", { name: c.coverage.untested.title });
      expect(within(untested).getByRole("row", { name: /runPipeline/ })).toHaveTextContent("apps/api/src/pipeline.ts:42");
      expect(screen.getByText(c.coverage.untested.subtitle(10))).toBeInTheDocument();
    });

    it("says each list is empty when nothing qualifies, and how many files could not be matched", async () => {
      const empty = { items: [], total: 0 };
      show(
        withCoverage(
          coverageOk({
            leastCovered: empty,
            notInReport: empty,
            untestedComplex: empty,
            files: { inReport: 10, matched: 7, unmatched: 3 },
          }),
        ),
      );
      expect(await screen.findByText(c.coverage.least.empty)).toBeInTheDocument();
      expect(screen.getByText(c.coverage.notInReport.empty)).toBeInTheDocument();
      expect(screen.getByText(c.coverage.untested.empty)).toBeInTheDocument();
      expect(screen.getByText(c.coverage.files(7, 10, 3))).toBeInTheDocument();
    });

    it("shows coverage beside each function when it was read", async () => {
      const base = codeDetailReport({ coverage: coverageOk() });
      show({ ...base, functions: { total: 1, items: [{ ...base.functions.items[0]!, coverage: 0.5 }] } });
      const table = await screen.findByRole("table", { name: c.functions.title });
      expect(within(table).getByRole("row", { name: /runPipeline/ })).toHaveTextContent("50%");
    });
  });

  describe("saving as a PDF", () => {
    it("names the file for the repository and a code analysis", async () => {
      const user = userEvent.setup();
      let title = "";
      vi.spyOn(window, "print").mockImplementation(() => {
        title = document.title;
        window.dispatchEvent(new Event("afterprint"));
      });
      show(codeDetailReport());
      await user.click(await screen.findByRole("button", { name: copy.report.download }));
      await waitFor(() => expect(title).not.toBe(""));
      expect(title).toBe(`acme-widgets-code-analysis-${isoDaysAgo(0)}`);
    });
  });

  it("asks again when a crawl of the repository finishes", async () => {
    let crawling = true;
    let calls = 0;
    mockFetch({
      "GET /api/repos/1/code-detail": () => {
        calls += 1;
        return { body: { status: "none" } };
      },
      "GET /api/repos/1/code-health": { body: { status: "none" } },
      "GET /api/repos": () => ({ body: [repo({ crawlStatus: crawling ? "crawling" : "idle" })] }),
    });
    const { client } = renderRoute(<CodeAnalysisPage />, { path: "/repos/:id/code", route: "/repos/1/code" });
    await screen.findByText(c.none.title);
    expect(calls).toBe(1);
    crawling = false;
    await client.invalidateQueries({ queryKey: ["repos"] });
    await waitFor(() => expect(calls).toBe(2));
  });
});

function okSource() {
  return (coverageOk() as Extract<CodeDetailReport["coverage"], { status: "ok" }>).source;
}
