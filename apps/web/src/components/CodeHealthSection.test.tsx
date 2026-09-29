import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { CodeHealthReport } from "@dora-dashboard/core";
import { CodeHealthSection } from "./CodeHealthSection";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const ok: CodeHealthReport = {
  status: "ok",
  commitSha: "abcdef0123456789",
  analysedAt: "2026-03-01T10:00:00Z",
  functions: 120,
  nloc: 4500,
  ccn: { mean: 4.2, median: 3, p75: 6, max: 31 },
  shareAboveWarn: 0.15,
  shareAboveHigh: 0.05,
  distribution: [
    { label: "1 to 5", min: 1, max: 5, count: 80 },
    { label: "6 to 10", min: 6, max: 10, count: 22 },
    { label: "11 to 20", min: 11, max: 20, count: 12 },
    { label: "21 to 50", min: 21, max: 50, count: 6 },
    { label: "Over 50", min: 51, max: null, count: 0 },
  ],
  languages: [{ language: "TypeScript", functions: 120, nloc: 4500, meanCcn: 4.2 }],
  hotspots: [
    { file: "src/pipeline.ts", language: "TypeScript", name: "runPipeline", startLine: 42, ccn: 31, nloc: 90, params: 3 },
    { file: "src/util.ts", language: "TypeScript", name: "parse", startLine: 7, ccn: 22, nloc: 40, params: 1 },
  ],
};

function show(body: unknown, status = 200) {
  mockFetch({ "GET /api/repos/1/code-health": { body, status }, "GET /api/repos": { body: [repo()] } });
  renderRoute(<CodeHealthSection repoId={1} />);
}

describe("CodeHealthSection", () => {
  it("shows a loading state before the analysis arrives", async () => {
    show(ok);
    expect(screen.getByText(copy.codeHealth.loading)).toBeInTheDocument();
    await screen.findByText(copy.codeHealth.medianCcn);
  });

  it("shows the tiles, commit, explanation and hotspots for an analysed repository", async () => {
    show(ok);
    expect(await screen.findByText(copy.codeHealth.analysedAt("abcdef0", "1 Mar 2026, 10:00"))).toBeInTheDocument();
    const tile = (label: string) => screen.getByRole("heading", { name: label }).closest("article")!;
    expect(within(tile(copy.codeHealth.medianCcn)).getByText("3")).toBeInTheDocument();
    expect(within(tile(copy.codeHealth.p75Ccn)).getByText("6")).toBeInTheDocument();
    expect(within(tile(copy.codeHealth.shareAbove(10))).getByText("15%")).toBeInTheDocument();
    expect(within(tile(copy.codeHealth.nloc)).getByText("4,500")).toBeInTheDocument();
    expect(within(tile(copy.codeHealth.functions)).getByText("120")).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.explainer)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.codeHealth.chart.title })).toBeInTheDocument();

    const table = screen.getByRole("table", { name: copy.codeHealth.hotspots.title });
    const first = within(table).getAllByRole("row")[1]!;
    expect(first).toHaveTextContent("runPipeline");
    expect(first).toHaveTextContent("src/pipeline.ts:42");
    expect(first).toHaveTextContent("31");
    expect(first).toHaveTextContent("90");
  });

  it("warns quietly when a newer analysis failed and the figures are from an earlier commit", async () => {
    show({ ...ok, lastError: { message: "clone failed", analysedAt: "2026-03-08T09:00:00Z" } });
    const notice = await screen.findByText(copy.codeHealth.staleTitle);
    expect(notice.closest("aside")).toHaveTextContent(copy.codeHealth.stale("1 Mar 2026", "8 Mar 2026", "clone failed"));
    expect(screen.getByText(copy.codeHealth.medianCcn)).toBeInTheDocument();
  });

  it("shows no warning when the latest analysis succeeded", async () => {
    show(ok);
    await screen.findByText(copy.codeHealth.medianCcn);
    expect(screen.queryByText(copy.codeHealth.staleTitle)).not.toBeInTheDocument();
  });

  it("offers the distribution as a table", async () => {
    show(ok);
    const table = await screen.findByRole("table", { name: copy.codeHealth.chart.title });
    expect(within(table).getByRole("row", { name: /6 to 10/ })).toHaveTextContent("22");
  });

  it("says when there are no functions to list", async () => {
    show({ ...ok, hotspots: [], distribution: ok.distribution.map((b) => ({ ...b, count: 0 })) });
    expect(await screen.findByText(copy.codeHealth.hotspots.empty)).toBeInTheDocument();
    expect(screen.getByText(copy.charts.noData)).toBeInTheDocument();
  });

  it("invites a crawl when nothing has been analysed", async () => {
    show({ status: "none" });
    expect(await screen.findByText(copy.codeHealth.none.title)).toBeInTheDocument();
    expect(screen.getByText(copy.codeHealth.none.body)).toBeInTheDocument();
  });

  it("explains how to install lizard when the analysis failed", async () => {
    show({ status: "error", message: "lizard is not installed", analysedAt: "2026-03-01T10:00:00Z" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.codeHealth.error.title);
    expect(alert).toHaveTextContent("lizard is not installed");
    expect(alert).toHaveTextContent("pipx install lizard");
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
