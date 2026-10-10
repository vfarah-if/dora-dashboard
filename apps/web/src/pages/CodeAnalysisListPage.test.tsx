import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { CodeAnalysisListPage } from "./CodeAnalysisListPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const route = { path: "/code", route: "/code" };

describe("CodeAnalysisListPage", () => {
  it("lists every repository with its last crawl, status and a link to its analysis", async () => {
    mockFetch({
      "GET /api/repos": {
        body: [repo({ id: 1 }), repo({ id: 2, name: "gadgets", lastCrawledAt: null, crawlStatus: "failed" })],
      },
    });
    renderRoute(<CodeAnalysisListPage />, route);
    const widgets = (await screen.findByRole("link", { name: copy.codeAnalysis.listOpen("acme/widgets") })).closest("li")!;
    expect(screen.getByRole("link", { name: copy.codeAnalysis.listOpen("acme/widgets") })).toHaveAttribute(
      "href",
      "/repos/1/code",
    );
    expect(within(widgets).getByText("1 Mar 2026, 10:00")).toBeInTheDocument();
    expect(within(widgets).getByText(copy.repos.status.idle)).toBeInTheDocument();
    const gadgets = screen.getByRole("link", { name: copy.codeAnalysis.listOpen("acme/gadgets") });
    expect(gadgets).toHaveAttribute("href", "/repos/2/code");
    expect(within(gadgets.closest("li")!).getByText(copy.codeAnalysis.listNeverCrawled)).toBeInTheDocument();
    expect(within(gadgets.closest("li")!).getByText(copy.repos.status.failed)).toBeInTheDocument();
  });

  it("keeps the title and the introduction in the sticky panel at the top, so they stay in view as the list scrolls", async () => {
    mockFetch({ "GET /api/repos": { body: [repo()] } });
    renderRoute(<CodeAnalysisListPage />, route);
    const panel = screen.getByRole("heading", { level: 1, name: copy.codeAnalysis.listTitle }).closest(".sticky-panel");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText(copy.codeAnalysis.listLede)).toBeInTheDocument();
    // The list itself scrolls beneath the panel rather than inside it.
    const row = await screen.findByRole("link", { name: copy.codeAnalysis.listOpen("acme/widgets") });
    expect(panel!.contains(row)).toBe(false);
  });

  it("shows a loading skeleton until the repositories arrive", async () => {
    mockFetch({ "GET /api/repos": { body: [repo()] } });
    renderRoute(<CodeAnalysisListPage />, route);
    expect(screen.getByText(copy.codeAnalysis.listLoading)).toBeInTheDocument();
    await screen.findByRole("link", { name: copy.codeAnalysis.listOpen("acme/widgets") });
    expect(screen.queryByText(copy.codeAnalysis.listLoading)).not.toBeInTheDocument();
  });

  it("points to the repositories page when none has been added", async () => {
    mockFetch({ "GET /api/repos": { body: [] } });
    renderRoute(<CodeAnalysisListPage />, route);
    expect(await screen.findByText(copy.codeAnalysis.listEmptyTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.codeAnalysis.listToRepos })).toHaveAttribute("href", "/repos");
  });

  it("offers a retry when the list cannot be read", async () => {
    mockFetch({ "GET /api/repos": { status: 500, body: { error: "boom" } } });
    renderRoute(<CodeAnalysisListPage />, route);
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
