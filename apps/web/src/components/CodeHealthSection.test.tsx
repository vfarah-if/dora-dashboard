import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { CodeHealthReport } from "@dora-dashboard/core";
import { CodeHealthSection } from "./CodeHealthSection";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const hotspot = {
  file: "src/pipeline.ts",
  language: "TypeScript",
  name: "runPipeline",
  startLine: 42,
  ccn: 31,
  nloc: 90,
  params: 3,
};

// 120 source functions. Above 10 there are 12 + 6 = 18 (15%), above 20 there are 6 (5%). 12 functions (10%) are
// over 60 lines. Nine of 36 qualifying pull requests changed tests (25%).
const ok: CodeHealthReport = {
  status: "ok",
  commitSha: "abcdef0123456789",
  analysedAt: "2026-03-01T10:00:00Z",
  functions: 120,
  nloc: 4500,
  ccn: { mean: 4.2, median: 3, p75: 6, max: 31 },
  shareAboveWarn: 0.15,
  shareAboveHigh: 0.05,
  countAboveWarn: 18,
  countAboveHigh: 6,
  mostComplex: hotspot,
  distribution: [
    { label: "1 to 5", min: 1, max: 5, count: 80 },
    { label: "6 to 10", min: 6, max: 10, count: 22 },
    { label: "11 to 20", min: 11, max: 20, count: 12 },
    { label: "21 to 50", min: 21, max: 50, count: 6 },
    { label: "Over 50", min: 51, max: null, count: 0 },
  ],
  languages: [{ language: "TypeScript", functions: 120, nloc: 4500, meanCcn: 4.2 }],
  hotspots: [
    { ...hotspot, shape: "dense", lineShare: 0.02, onPath: true },
    {
      ...hotspot,
      name: "parse",
      file: "src/util.ts",
      startLine: 7,
      ccn: 22,
      nloc: 40,
      shape: "branching",
      lineShare: 0.01,
      onPath: false,
    },
  ],
  nextBand: {
    from: "medium",
    to: "high",
    functions: [hotspot, { ...hotspot, name: "parse", file: "src/util.ts", startLine: 7, ccn: 22, nloc: 40 }],
    lines: 130,
  },
  partlyMeasured: [],
  unmeasuredFiles: 0,
  tests: { functions: 35, nloc: 2000 },
  maintainability: { linesAboveWarn: 0.08, linesAboveHigh: 0.04, longFunctions: 0.1, manyParams: 0.01 },
  testing: { testRatio: 0.45, prsWithTests: { share: 0.25, withTests: 9, total: 36 }, ciRunsTests: true, coverageFloor: 40 },
  hygiene: {
    linterConfigured: true,
    formatterConfigured: true,
    ciRunsLinter: false,
    ciChecksFormat: true,
    onlyEditorconfig: false,
    linters: ["eslint"],
    formatters: ["prettier"],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
  },
  tooling: {
    linters: ["eslint"],
    formatters: ["prettier"],
    weakFormatters: ["editorconfig"],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
    ciRunsTests: true,
    coverageFloor: 40,
  },
  longestFunction: { ...hotspot, name: "RepoCharts", file: "src/RepoCharts.tsx", startLine: 30, ccn: 12, nloc: 233 },
  grade: {
    overall: { part: "maintainability", band: "low", check: "longFunctions", reason: "unused" },
    maintainability: { band: "low", check: "longFunctions", reason: "unused" },
    testing: { band: "medium", check: "prsWithTests", reason: "unused" },
    hygiene: { band: "high", check: "ciLinter", reason: "unused" },
  },
  checks: [
    { part: "maintainability", check: "linesAboveWarn", value: 0.03, band: "elite", count: 3, limits: false },
    { part: "maintainability", check: "linesAboveHigh", value: 0.04, band: "medium", count: 6, limits: false },
    { part: "maintainability", check: "longFunctions", value: 0.1, band: "low", count: 12, limits: true },
    { part: "maintainability", check: "manyParams", value: 0.005, band: "elite", count: 1, limits: false },
    { part: "testing", check: "testRatio", value: 0.45, band: "high", met: false, limits: false },
    { part: "testing", check: "prsWithTests", value: 0.25, band: "medium", met: false, count: 9, total: 36, limits: true },
    { part: "testing", check: "ciRunsTests", value: true, band: "elite", met: true, limits: false },
    { part: "testing", check: "coverageFloor", value: 40, band: "high", met: false, limits: false },
    { part: "hygiene", check: "linter", value: true, met: true, detail: ["eslint"], limits: false },
    { part: "hygiene", check: "formatter", value: true, met: true, detail: ["prettier"], limits: false },
    { part: "hygiene", check: "ciLinter", value: false, met: false, detail: [], limits: true },
    { part: "hygiene", check: "ciFormat", value: true, met: true, detail: ["prettier"], limits: false },
  ],
};

function show(body: unknown, status = 200) {
  const fetchMock = mockFetch({ "GET /api/repos/1/code-health": { body, status }, "GET /api/repos": { body: [repo()] } });
  renderRoute(<CodeHealthSection repoId={1} range={{ from: "2026-01-01", to: "2026-02-01" }} />);
  return fetchMock;
}

const items = (name: string) =>
  within(screen.getByRole("heading", { name }).closest("section")!)
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("CodeHealthSection", () => {
  it("shows a loading state before the analysis arrives", async () => {
    show(ok);
    expect(screen.getByText(copy.codeHealth.loading)).toBeInTheDocument();
    await screen.findByText(copy.codeHealth.verdict.title);
  });

  it("sends the page range so the testing figure follows it", async () => {
    const fetchMock = show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    const url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("code-health"))!;
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-02-01");
  });

  it("gives the overall band as text with the part and check that limited it", async () => {
    show(ok);
    const verdict = (await screen.findByRole("heading", { name: copy.codeHealth.verdict.title })).closest("article")!;
    expect(verdict).toHaveTextContent("Low");
    expect(verdict).toHaveTextContent(
      "Maintainability is the lowest part. 12 functions are longer than 60 lines, the longest being RepoCharts at 233 lines.",
    );
  });

  it("lists what is good and ranks what to improve worst first", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(items(copy.codeHealth.lists.goodTitle)).toEqual([
      "Only 3.0% of source lines are in functions above complexity 10",
      "Only 0.5% of functions take more than 5 parameters",
      "CI runs the tests",
      "A linter is configured (ESLint)",
      "A formatter is configured (Prettier)",
      "Formatting is checked in CI with Prettier",
    ]);
    // Lowest band first; within medium and high the check limiting its part comes first.
    expect(items(copy.codeHealth.lists.improveTitle)).toEqual([
      "12 functions are longer than 60 lines, the longest being RepoCharts at 233 lines",
      "Only 25% of merged pull requests changed tests alongside code (9 of 36)",
      "4.0% of source lines are in functions above complexity 20",
      "CI does not run a linter",
      "Test code is 0.45 of the size of source code",
      "A coverage floor of 40% is configured but below the 60% needed for elite",
    ]);
  });

  it("shows each part with its band and limiting check", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    const tile = (name: string) => screen.getByRole("heading", { name }).closest("article")!;
    expect(tile(copy.codeHealth.parts.testing)).toHaveTextContent("Medium");
    expect(tile(copy.codeHealth.parts.testing)).toHaveTextContent("25% of merged pull requests changed tests alongside code");
    expect(tile(copy.codeHealth.parts.hygiene)).toHaveTextContent("High");
    expect(tile(copy.codeHealth.parts.hygiene)).toHaveTextContent("CI does not run a linter.");
  });

  it("shows counts with one-decimal shares, the most complex function and the separate test count", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    const tile = (label: string) => screen.getByRole("heading", { name: label }).closest("article")!;
    expect(tile(copy.codeHealth.detail.above(10))).toHaveTextContent("18 (15.0%)");
    expect(tile(copy.codeHealth.detail.above(20))).toHaveTextContent("6 (5.0%)");
    expect(tile(copy.codeHealth.detail.mostComplex)).toHaveTextContent("Complexity 31");
    expect(tile(copy.codeHealth.detail.mostComplex)).toHaveTextContent("runPipeline at src/pipeline.ts:42");
    expect(tile(copy.codeHealth.detail.nloc)).toHaveTextContent("4,500");
    expect(tile(copy.codeHealth.detail.functions)).toHaveTextContent("120");
    expect(tile(copy.codeHealth.detail.functions)).toHaveTextContent("35 test functions are counted separately");
    expect(screen.queryByText("Median complexity")).not.toBeInTheDocument();
  });

  it("shows the range key, the distribution table and the hotspots", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(screen.getByRole("list", { name: copy.codeHealth.chart.keyTitle })).toHaveTextContent("Very hard to test");
    const dist = screen.getByRole("table", { name: copy.codeHealth.chart.title });
    expect(within(dist).getByRole("row", { name: /6 to 10/ })).toHaveTextContent("22");
    const hot = screen.getByRole("table", { name: copy.codeHealth.hotspots.title });
    expect(within(hot).getAllByRole("row")[1]).toHaveTextContent("src/pipeline.ts:42");
    expect(screen.getByText(copy.codeHealth.explainer)).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.analysedAt("abcdef0", "1 Mar 2026, 10:00"))).toBeInTheDocument();
  });

  it("shows the testing panel and marks a weak formatter in the hygiene table", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    const testing = screen.getByRole("heading", { name: copy.codeHealth.testing.title }).closest("section")!;
    expect(testing).toHaveTextContent("25% (9 of 36 that changed source)");
    expect(testing).toHaveTextContent("40% of lines, configured but below the 60% needed for elite");
    const table = screen.getByRole("table", { name: copy.codeHealth.hygiene.title });
    const row = (name: string) => within(table).getByRole("row", { name: new RegExp(name) });
    expect(row("ESLint")).toHaveTextContent("Linter");
    expect(row("ESLint")).toHaveTextContent("No");
    expect(row("Prettier")).toHaveTextContent("Yes");
    expect(row("EditorConfig")).toHaveTextContent(copy.codeHealth.hygiene.weak);
    expect(row("EditorConfig")).toHaveTextContent(copy.codeHealth.hygiene.notApplicable);
  });

  it("asks for a full crawl when no pull request has file data", async () => {
    show({
      ...ok,
      testing: { ...ok.testing, prsWithTests: null },
      checks: ok.checks.map((c) =>
        c.check === "prsWithTests" ? { part: "testing", check: "prsWithTests", value: null, limits: false } : c,
      ),
    });
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(screen.getByText(copy.codeHealth.testing.prsNeedsCrawl)).toBeInTheDocument();
    expect(screen.queryByText(/merged pull requests changed tests/)).not.toBeInTheDocument();
  });

  it("explains that the next crawl will produce a missing grade, and still shows the figures", async () => {
    show({
      ...ok,
      grade: null,
      hygiene: null,
      tooling: null,
      checks: ok.checks.filter((c) => c.part === "maintainability"),
      testing: { ...ok.testing, ciRunsTests: null },
    });
    expect(await screen.findByText(copy.codeHealth.verdict.missingTitle)).toBeInTheDocument();
    expect(screen.getByText(/The next crawl will produce it/)).toBeInTheDocument();
    expect(screen.queryByText(copy.codeHealth.parts.title)).not.toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.testing.unavailable)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.codeHealth.detail.above(10) })).toBeInTheDocument();
  });

  it("says the verdict is elite everywhere when nothing held it back", async () => {
    show({
      ...ok,
      maintainability: { linesAboveWarn: 0, linesAboveHigh: 0, longFunctions: 0, manyParams: 0 },
      checks: ok.checks.map((c) => ({ ...c, limits: false, ...(c.band ? { band: "elite" as const } : {}), met: true })),
      grade: {
        overall: { part: "maintainability", band: "elite", check: "all", reason: "" },
        maintainability: { band: "elite", check: "all", reason: "" },
        testing: { band: "elite", check: "all", reason: "" },
        hygiene: { band: "elite", check: "all", reason: "" },
      },
    });
    const verdict = (await screen.findByRole("heading", { name: copy.codeHealth.verdict.title })).closest("article")!;
    expect(verdict).toHaveTextContent("Elite");
    expect(verdict).toHaveTextContent(copy.codeHealth.verdict.allPass);
  });

  it("warns quietly when a newer analysis failed and the figures are from an earlier commit", async () => {
    show({ ...ok, lastError: { message: "clone failed", analysedAt: "2026-03-08T09:00:00Z", reason: "failed" } });
    const notice = await screen.findByText(copy.codeHealth.staleTitle);
    expect(notice.closest("aside")).toHaveTextContent(copy.codeHealth.stale("1 Mar 2026", "8 Mar 2026", "clone failed"));
  });

  it("shows no warning when the latest analysis succeeded", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(screen.queryByText(copy.codeHealth.staleTitle)).not.toBeInTheDocument();
  });

  it("says which functions to simplify to reach the next band, and that the figure is a floor", async () => {
    show(ok);
    const card = (await screen.findByRole("heading", { name: copy.codeHealth.start.title })).closest("section")!;
    expect(card).toHaveTextContent("Simplifying these 2 functions (130 lines) would lift maintainability from medium to high.");
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["runPipeline at src/pipeline.ts:42 (90 lines)", "parse at src/util.ts:7 (40 lines)"]);
    expect(card).toHaveTextContent(copy.codeHealth.start.floor);
  });

  it("uses the singular for a single function", async () => {
    show({ ...ok, nextBand: { ...ok.nextBand!, functions: [hotspot], lines: 90 } });
    const card = (await screen.findByRole("heading", { name: copy.codeHealth.start.title })).closest("section")!;
    expect(card).toHaveTextContent("Simplifying this function (90 lines) would lift");
  });

  it("says maintainability is already elite when there is nothing to lift", async () => {
    show({ ...ok, nextBand: null });
    const card = (await screen.findByRole("heading", { name: copy.codeHealth.start.title })).closest("section")!;
    expect(card).toHaveTextContent(copy.codeHealth.start.elite);
    expect(within(card).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("shows no where to start card without functions, or without a grade or path", async () => {
    show({ ...ok, functions: 0, nextBand: null, hotspots: [], mostComplex: null });
    await screen.findByText(copy.codeHealth.hotspots.empty);
    expect(screen.queryByRole("heading", { name: copy.codeHealth.start.title })).not.toBeInTheDocument();
  });

  it("shows no card when there is no grade and no path", async () => {
    show({ ...ok, grade: null, nextBand: null });
    await screen.findByText(copy.codeHealth.verdict.missingTitle);
    expect(screen.queryByRole("heading", { name: copy.codeHealth.start.title })).not.toBeInTheDocument();
  });

  it("gives advice for each shape in the hotspots table", async () => {
    const fn = { ...hotspot, lineShare: 0.01, onPath: false };
    show({
      ...ok,
      hotspots: [
        { ...fn, name: "a", shape: "component" },
        { ...fn, name: "b", shape: "dense" },
        { ...fn, name: "c", shape: "long" },
        { ...fn, name: "d", shape: "branching" },
        { ...fn, name: "e", shape: null },
      ],
    });
    const table = await screen.findByRole("table", { name: copy.codeHealth.hotspots.title });
    const advice = copy.codeHealth.hotspots.adviceFor;
    const expected = { a: advice.component, b: advice.dense, c: advice.long, d: advice.branching, e: advice.within };
    for (const [name, text] of Object.entries(expected)) {
      expect(within(table).getByRole("row", { name: new RegExp(`^${name} `) })).toHaveTextContent(text);
    }
    expect(within(table).getByRole("columnheader", { name: copy.codeHealth.hotspots.advice })).toBeInTheDocument();
  });

  it("marks only the functions on the path with a Start here tag", async () => {
    show(ok);
    const table = await screen.findByRole("table", { name: copy.codeHealth.hotspots.title });
    expect(within(table).getByRole("row", { name: /runPipeline/ })).toHaveTextContent("Start here");
    expect(within(table).getByRole("row", { name: /parse/ })).not.toHaveTextContent("Start here");
  });

  it("explains that complexity is weighed with length", async () => {
    show(ok);
    expect(await screen.findByText(/Complexity is weighed with length/)).toBeInTheDocument();
  });

  it("warns which files may be partly measured, and shows no notice otherwise", async () => {
    show({ ...ok, partlyMeasured: ["src/A.tsx", "src/B.tsx"] });
    const notice = (await screen.findByText(copy.codeHealth.partly.title)).closest("aside")!;
    expect(notice).toHaveTextContent(copy.codeHealth.partly.body(2));
    expect(
      within(notice)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["src/A.tsx", "src/B.tsx"]);
  });

  it("lists the first ten partly measured files and counts the rest", async () => {
    show({ ...ok, partlyMeasured: Array.from({ length: 12 }, (_, i) => `src/F${i}.tsx`) });
    const notice = (await screen.findByText(copy.codeHealth.partly.title)).closest("aside")!;
    expect(within(notice).getAllByRole("listitem")).toHaveLength(11);
    expect(notice).toHaveTextContent("and 2 more");
    expect(notice).not.toHaveTextContent("src/F11.tsx");
  });

  it("shows no partly measured notice when every file was read in full", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(screen.queryByText(copy.codeHealth.partly.title)).not.toBeInTheDocument();
  });

  it("says how many files were not measured and shows how to install lizard", async () => {
    show({ ...ok, unmeasuredFiles: 3 });
    const notice = (await screen.findByText(copy.codeHealth.unmeasured.title)).closest("aside")!;
    expect(notice).toHaveTextContent(copy.codeHealth.unmeasured.body(3));
    expect(screen.getByRole("heading", { name: copy.codeHealth.install.title })).toBeInTheDocument();
    expect(screen.getByText("uv tool install lizard")).toBeInTheDocument();
  });

  it("uses the singular when one file was not measured", async () => {
    show({ ...ok, unmeasuredFiles: 1 });
    const notice = (await screen.findByText(copy.codeHealth.unmeasured.title)).closest("aside")!;
    expect(notice).toHaveTextContent("1 source file in languages other than JavaScript and TypeScript was not measured");
  });

  it("shows no unmeasured notice or install commands when every file was measured", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.verdict.title);
    expect(screen.queryByText(copy.codeHealth.unmeasured.title)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.codeHealth.install.title)).not.toBeInTheDocument();
  });

  it("says when there are no functions to list", async () => {
    show({ ...ok, mostComplex: null, hotspots: [], distribution: ok.distribution.map((b) => ({ ...b, count: 0 })) });
    expect(await screen.findByText(copy.codeHealth.hotspots.empty)).toBeInTheDocument();
    expect(screen.getByText(copy.charts.noData)).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.detail.mostComplexNone)).toBeInTheDocument();
  });

  it("invites a crawl when nothing has been analysed", async () => {
    show({ status: "none" });
    expect(await screen.findByText(copy.codeHealth.none.title)).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.none.body)).toBeInTheDocument();
  });

  it("shows the API message once when the analysis has never succeeded", async () => {
    show({ status: "error", message: "The clone timed out.", analysedAt: "2026-03-01T10:00:00Z", reason: "failed" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.codeHealth.error.title);
    expect(alert.textContent!.match(/The clone timed out\./g)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: copy.codeHealth.install.title })).not.toBeInTheDocument();
  });

  it("shows how to install lizard on each platform when the API cannot find it", async () => {
    show({ status: "error", message: "lizard is missing", analysedAt: "2026-03-01T10:00:00Z", reason: "analyser-missing" });
    const guide = (await screen.findByRole("heading", { name: copy.codeHealth.install.title })).closest("section")!;

    for (const option of copy.codeHealth.install.options) {
      expect(guide).toHaveTextContent(option.label);
      for (const command of option.commands) expect(guide).toHaveTextContent(command);
    }
    expect(guide).toHaveTextContent("uv tool install lizard");
    expect(guide).toHaveTextContent("brew install pipx");
    expect(guide).toHaveTextContent("winget install --id astral-sh.uv -e");
    expect(guide).toHaveTextContent(copy.codeHealth.install.after);
  });

  it("offers the install guide beside older figures when lizard has since gone missing", async () => {
    show({ ...ok, lastError: { message: "lizard is missing", analysedAt: "2026-03-08T09:00:00Z", reason: "analyser-missing" } });
    expect(await screen.findByRole("heading", { name: copy.codeHealth.install.title })).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.verdict.title)).toBeInTheDocument();
  });

  it("shows the request failure and offers a retry", async () => {
    show({ error: "Unknown repository" }, 404);
    expect(await screen.findByText("Unknown repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("refetches when a crawl of the repository finishes", async () => {
    let crawling = true;
    let calls = 0;
    mockFetch({
      "GET /api/repos/1/code-health": () => {
        calls += 1;
        return { body: { status: "none" } };
      },
      "GET /api/repos": () => ({ body: [repo({ crawlStatus: crawling ? "crawling" : "idle" })] }),
    });
    const { client } = renderRoute(<CodeHealthSection repoId={1} />);
    await screen.findByText(copy.codeHealth.none.title);
    expect(calls).toBe(1);
    crawling = false;
    await client.invalidateQueries({ queryKey: ["repos"] });
    await waitFor(() => expect(calls).toBe(2));
  });
});
