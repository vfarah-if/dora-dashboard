import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoPage } from "./RepoPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo, report } from "../test/fixtures";
import { copy } from "../copy";

const manyPrs = Array.from({ length: 25 }, (_, i) => ({
  ...report().prs[0]!,
  number: i + 1,
  title: `Change ${i + 1}`,
  size: i * 10,
}));

describe("RepoPage", () => {
  it("offers a PDF report named after the repository once the report has loaded", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    mockFetch({ "GET /api/repos/1/report": { body: report() }, "GET /api/repos": { body: [repo()] } });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).not.toBe(""));
    expect(printedAs).toMatch(/^acme-widgets-delivery-report-\d{4}-\d{2}-\d{2}$/);
  });

  it("shows the DORA tiles, flow tiles and charts for a repository", async () => {
    const fetchMock = mockFetch({
      "GET /api/repos/1/report": { body: report() },
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

  it("explains why DORA measures are missing when no deploy workflow is configured", async () => {
    const base = report();
    mockFetch({
      "GET /api/repos/1/report": {
        body: {
          ...base,
          repo: { ...base.repo, deployWorkflows: [] },
          dora: { deploymentFrequency: null, leadTime: null, changeFailure: null, timeToRestore: null },
        },
      },
      "GET /api/repos": { body: [repo()] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    expect(await screen.findAllByText(copy.dora.notMeasured)).toHaveLength(4);
    expect(screen.getAllByText(copy.dora.reasons.noWorkflow)).toHaveLength(4);
  });

  it("sorts and pages the pull request table", async () => {
    const user = userEvent.setup();
    mockFetch({ "GET /api/repos/1/report": { body: report({ prs: manyPrs }) }, "GET /api/repos": { body: [] } });
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

  it("prints every pull request rather than the page on screen, then returns to paging", async () => {
    mockFetch({ "GET /api/repos/1/report": { body: report({ prs: manyPrs }) }, "GET /api/repos": { body: [] } });
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
    const fetchMock = mockFetch({ "GET /api/repos/1/report": { body: report() }, "GET /api/repos": { body: [] } });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    await screen.findByRole("heading", { level: 1, name: "acme/widgets" });
    await user.click(screen.getByRole("button", { name: copy.range.last30 }));
    expect(screen.getByRole("button", { name: copy.range.last30 })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("from="))).toBe(true);
  });

  it("shows the API error message", async () => {
    mockFetch({
      "GET /api/repos/1/report": { status: 404, body: { error: "Unknown repository" } },
      "GET /api/repos": { body: [] },
    });
    renderRoute(<RepoPage />, { path: "/repos/:id", route: "/repos/1" });
    expect(await screen.findByText("Unknown repository")).toBeInTheDocument();
  });
});
