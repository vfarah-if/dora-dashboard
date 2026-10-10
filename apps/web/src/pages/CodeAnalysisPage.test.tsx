import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { Link, useLocation, useNavigate } from "react-router";
import userEvent from "@testing-library/user-event";
import type { CodeDetailReport } from "@dora-dashboard/core";
import { CodeAnalysisPage } from "./CodeAnalysisPage";
import { PRINT_CHART_WIDTH } from "../components/chartParts";
import { mockFetch, renderRoute, type Handler } from "../test/render";
import { codeDetailReport, codeHealthReport, coverageOk, repo } from "../test/fixtures";
import { isoDaysAgo } from "../lib/format";
import { copy } from "../copy";

const c = copy.codeAnalysis;

/** Shows where the address is, and can go back, so a test can tell a pushed entry from a replaced one. */
function History() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="address">{search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        go back
      </button>
    </>
  );
}

function show(
  body: unknown,
  { status = 200, route = "/repos/1/code", extra = null }: { status?: number; route?: string; extra?: ReactNode } = {},
) {
  const detail: Handler = () => ({ body, status });
  const fetchMock = mockFetch({
    "GET /api/repos/1/code-detail": detail,
    "GET /api/repos/1/code-health": { body: codeHealthReport() },
    "GET /api/repos": { body: [repo()] },
  });
  const rendered = renderRoute(
    <>
      {extra}
      <CodeAnalysisPage />
    </>,
    { path: "/repos/:id/code", route },
  );
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

  it("shows the request failure and asks again when retry is pressed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = show({ error: "Unknown repository" }, { status: 404 });
    expect(await screen.findByText("Unknown repository")).toBeInTheDocument();
    expect(detailUrls(fetchMock)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    await waitFor(() => expect(detailUrls(fetchMock)).toHaveLength(2));
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
      expect(notice).toHaveTextContent("has no list of this repository's files");
      expect(notice).toHaveTextContent("A full re-crawl of the repository finds its workspaces");
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
      expect(empty).toHaveTextContent("lcov.info or a .lcov file, coverage-final.json, coverage-summary.json");
      expect(empty).toHaveTextContent("Cobertura XML file named coverage.xml or with cobertura in its name");
      expect(empty).toHaveTextContent("deploy branch");
      expect(empty).toHaveTextContent("read on the next crawl while code analysis is switched on");
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

    it("says a figure is not reported when the report does not carry it", async () => {
      show(withCoverage(coverageOk({ branches: null })));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      const tile = screen.getByRole("heading", { name: c.coverage.tiles.branches }).closest("article")!;
      expect(tile).toHaveTextContent(c.coverage.tiles.notReported);
      expect(tile).toHaveTextContent(c.coverage.tiles.notReportedHint);
    });

    it("says what was read when the run held more coverage artefacts than were used", async () => {
      show(withCoverage(coverageOk({ source: { ...okSource(), artefacts: ["a", "b", "c", "d", "e"], artefactsInRun: 8 } })));
      expect(await screen.findByText(c.coverage.artefactsRead(5, 8))).toHaveTextContent("5 of the 8 coverage artefacts");
    });

    it("says nothing about unread artefacts when every one was read", async () => {
      show(withCoverage(coverageOk()));
      await screen.findByRole("heading", { name: c.coverage.least.title });
      expect(screen.queryByText(/coverage artefacts in that run/)).not.toBeInTheDocument();
      expect(screen.queryByText(/could not be read and/)).not.toBeInTheDocument();
    });

    it("says how many coverage files could not be read and were left out", async () => {
      show(withCoverage(coverageOk({ source: { ...okSource(), unreadableFiles: 3 } })));
      expect(await screen.findByText("3 coverage files could not be read and were left out.")).toBeInTheDocument();
    });

    it("says one coverage file in the singular", async () => {
      show(withCoverage(coverageOk({ source: { ...okSource(), unreadableFiles: 1 } })));
      expect(await screen.findByText("1 coverage file could not be read and was left out.")).toBeInTheDocument();
    });

    it("explains a share that is not reported while the scope has matched files", async () => {
      show(withCoverage(coverageOk({ lines: null })));
      const tile = (await screen.findByRole("heading", { name: c.coverage.tiles.lines })).closest("article")!;
      expect(tile).toHaveTextContent("have nothing that can be measured for it");
    });

    it("says the report does not reach the selected area, with no cards or tile hints", async () => {
      show(
        withCoverage(
          coverageOk({
            filesInScope: 0,
            lines: null,
            branches: null,
            functions: null,
            leastCovered: { items: [], total: 0 },
            notInReport: { items: [], total: 0 },
            untestedComplex: { items: [], total: 0 },
          }),
          { area: "apps/api" },
        ),
      );
      const notice = (await screen.findByText(c.coverage.notCovered.titleArea)).closest("aside")!;
      expect(notice).toHaveTextContent("Your CI may upload coverage for other packages only");
      expect(screen.queryByRole("heading", { name: c.coverage.tiles.lines })).not.toBeInTheDocument();
      expect(screen.queryByText(c.coverage.tiles.notReportedHint)).not.toBeInTheDocument();
      for (const title of [c.coverage.least.title, c.coverage.notInReport.title, c.coverage.untested.title]) {
        expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
      }
      expect(screen.queryByText(c.coverage.least.empty)).not.toBeInTheDocument();
      expect(screen.queryByText(c.coverage.untested.empty)).not.toBeInTheDocument();
    });

    it("says the report matches nothing when the whole repository has no matched file", async () => {
      show(withCoverage(coverageOk({ filesInScope: 0, lines: null, branches: null, functions: null })));
      expect(await screen.findByText(c.coverage.notCovered.titleWhole)).toBeInTheDocument();
    });

    it("says how many files in kinds of code the report does not cover are not listed", async () => {
      show(withCoverage(coverageOk({ notInReportOtherKinds: 4 })));
      expect(await screen.findByText(c.coverage.notInReport.otherKinds(4))).toHaveTextContent(
        "4 source files in areas or languages the report does not cover are not listed.",
      );
    });

    it("says a single such file in the singular and leaves the note out when there are none", async () => {
      show(withCoverage(coverageOk({ notInReportOtherKinds: 1 })));
      expect(
        await screen.findByText(/1 source file in areas or languages the report does not cover is not listed/),
      ).toBeInTheDocument();
    });

    it("leaves the other kinds note out when every unlisted file is accounted for", async () => {
      show(withCoverage(coverageOk()));
      await screen.findByRole("heading", { name: c.coverage.notInReport.title });
      expect(screen.queryByText(/does not cover are not listed/)).not.toBeInTheDocument();
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

    it("says when the newest report was created", async () => {
      show(withCoverage(coverageOk()));
      expect(await screen.findByText(/The newest report was created on 28 Feb 2026, 16:30\./)).toBeInTheDocument();
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
      const ok = coverageOk() as Extract<CodeDetailReport["coverage"], { status: "ok" }>;
      const file = { ...ok.leastCovered.items[0]!, uncovered: null };
      show(withCoverage({ ...ok, lineDetail: false, leastCovered: { items: [file], total: 1 } }));
      expect(await screen.findByText(c.coverage.totalsOnly)).toBeInTheDocument();
      const table = screen.getByRole("table", { name: c.coverage.least.title });
      expect(table).not.toHaveTextContent("12 to 30");
      expect(table).toHaveTextContent(copy.common.notAvailable);
    });

    it("says per-function coverage is not available, not that nothing is uncovered, for a totals only report", async () => {
      show(withCoverage(coverageOk({ lineDetail: false, untestedComplex: { items: [], total: 0 } })));
      const card = (await screen.findByRole("heading", { name: c.coverage.untested.title })).closest("section")!;
      expect(card).toHaveTextContent(c.coverage.untested.totalsOnly);
      expect(card).not.toHaveTextContent(c.coverage.untested.empty);
    });

    it("decides each file's not-run cell by that file's own ranges, not the report's", async () => {
      const ok = coverageOk() as Extract<CodeDetailReport["coverage"], { status: "ok" }>;
      const withRanges = ok.leastCovered.items[0]!;
      const without = { ...withRanges, path: "apps/api/src/totals.ts", uncovered: null };
      show(withCoverage({ ...ok, leastCovered: { items: [withRanges, without], total: 2 } }));
      const table = await screen.findByRole("table", { name: c.coverage.least.title });
      expect(within(table).getByRole("row", { name: /pipeline\.ts/ })).toHaveTextContent("12 to 30, 44");
      expect(within(table).getByRole("row", { name: /totals\.ts/ })).toHaveTextContent(copy.common.notAvailable);
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
      expect(screen.getByText(c.coverage.least.empty)).toHaveTextContent("kinds of code this report covers");
    });

    it("shows coverage beside each function when it was read", async () => {
      const base = codeDetailReport({ coverage: coverageOk() });
      show({ ...base, functions: { total: 1, items: [{ ...base.functions.items[0]!, coverage: 0.5 }] } });
      const table = await screen.findByRole("table", { name: c.functions.title });
      expect(within(table).getByRole("row", { name: /runPipeline/ })).toHaveTextContent("50%");
    });
  });

  describe("grade line", () => {
    it("says the grade is unavailable when the code health request fails", async () => {
      mockFetch({
        "GET /api/repos/1/code-detail": { body: codeDetailReport() },
        "GET /api/repos/1/code-health": { status: 500, body: { error: "boom" } },
        "GET /api/repos": { body: [repo()] },
      });
      renderRoute(<CodeAnalysisPage />, { path: "/repos/:id/code", route: "/repos/1/code" });
      expect(await screen.findByText(c.gradeUnavailable)).toBeInTheDocument();
      expect(screen.queryByText(c.gradeLine)).not.toBeInTheDocument();
    });

    it("tells people the grade is the one part that follows the date range", async () => {
      show(codeDetailReport());
      expect(
        await screen.findByText(/Apart from the overall grade, nothing on this page follows the date range/),
      ).toBeInTheDocument();
    });
  });

  it("shows no band, and says why, when the scope has no source function to judge", async () => {
    show(codeDetailReport({ scope: { ...codeDetailReport().scope, maintainabilityBand: null } }));
    const checks = (await screen.findByRole("heading", { name: c.scope.checks.title })).closest("section")!;
    const line = checks.querySelector(".band-line")!;
    expect(line).toHaveTextContent(c.scope.checks.noBand);
    expect(line).not.toHaveTextContent(/Elite|High|Medium|Low/);
  });

  describe("while another area loads", () => {
    it("keeps the old figures, marks the body busy and dims it until the new area arrives", async () => {
      const user = userEvent.setup();
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mockFetch({
        "GET /api/repos/1/code-detail": async (url) => {
          if (url.searchParams.get("area") === "packages/core") {
            await gate;
            return { body: codeDetailReport({ area: "packages/core" }) };
          }
          return { body: codeDetailReport() };
        },
        "GET /api/repos/1/code-health": { body: codeHealthReport() },
        "GET /api/repos": { body: [repo()] },
      });
      const { container } = renderRoute(<CodeAnalysisPage />, { path: "/repos/:id/code", route: "/repos/1/code" });
      const table = await screen.findByRole("table", { name: c.areas.packagesTitle });
      const body = () => container.querySelector(".detail-body")!;
      expect(body()).toHaveAttribute("aria-busy", "false");
      expect(body()).not.toHaveClass("is-refreshing");

      await user.click(within(table).getByRole("link", { name: "packages/core" }));
      await waitFor(() => expect(body()).toHaveAttribute("aria-busy", "true"));
      expect(body()).toHaveClass("is-refreshing");
      expect(screen.getByRole("heading", { name: c.scope.titleWhole })).toBeInTheDocument();

      release?.();
      expect(await screen.findByRole("heading", { name: c.scope.titleArea("packages/core") })).toBeInTheDocument();
      expect(body()).toHaveAttribute("aria-busy", "false");
      expect(body()).not.toHaveClass("is-refreshing");
    });
  });

  describe("moving between repositories", () => {
    it("never shows the first repository's analysis under the second one's address", async () => {
      const user = userEvent.setup();
      const never = new Promise<never>(() => undefined);
      mockFetch({
        "GET /api/repos/1/code-detail": { body: codeDetailReport() },
        "GET /api/repos/2/code-detail": () => never,
        "GET /api/repos/1/code-health": { body: codeHealthReport() },
        "GET /api/repos/2/code-health": () => never,
        "GET /api/repos": { body: [repo()] },
      });
      renderRoute(
        <>
          <Link to="/repos/2/code">next repository</Link>
          <CodeAnalysisPage />
        </>,
        { path: "/repos/:id/code", route: "/repos/1/code" },
      );
      expect(await screen.findByText(c.analysedAt("abcdef0", "1 Mar 2026, 10:00"))).toBeInTheDocument();
      expect(await screen.findByText(c.gradeLine)).toBeInTheDocument();

      await user.click(screen.getByRole("link", { name: "next repository" }));
      expect(await screen.findByText(c.loading)).toBeInTheDocument();
      expect(screen.queryByText(c.analysedAt("abcdef0", "1 Mar 2026, 10:00"))).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: c.areas.packagesTitle })).not.toBeInTheDocument();
      expect(screen.queryByText(c.gradeLine)).not.toBeInTheDocument();
    });
  });

  describe("clearing an area", () => {
    it("adds a history entry, so Back returns to the area that was cleared", async () => {
      const user = userEvent.setup();
      show(codeDetailReport({ missingArea: "gone/away" }), {
        route: "/repos/1/code?area=gone%2Faway&from=2026-01-01",
        extra: <History />,
      });
      const notice = (await screen.findByText(c.missingArea.title)).closest("aside")!;
      expect(screen.getByLabelText("address")).toHaveTextContent("?area=gone%2Faway&from=2026-01-01");

      await user.click(within(notice).getByRole("button", { name: c.missingArea.clear }));
      await waitFor(() => expect(screen.getByLabelText("address")).toHaveTextContent(/^\?from=2026-01-01$/));

      await user.click(screen.getByRole("button", { name: "go back" }));
      await waitFor(() => expect(screen.getByLabelText("address")).toHaveTextContent("?area=gone%2Faway&from=2026-01-01"));
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
