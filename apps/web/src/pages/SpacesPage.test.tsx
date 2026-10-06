import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { SpacesPage } from "./SpacesPage";
import { mockFetch, renderRoute } from "../test/render";
import type { SpaceListItem } from "../api/hooks";
import { copy } from "../copy";

const space = (overrides: Partial<SpaceListItem> = {}): SpaceListItem => ({
  id: 7,
  key: "WID",
  name: "Widgets",
  siteUrl: "https://acme.example.test",
  lastCrawledAt: "2026-03-01T10:00:00Z",
  crawlStatus: "idle",
  workItemCount: 1234,
  repos: [{ id: 1, name: "acme/widgets" }],
  ...overrides,
});

describe("SpacesPage", () => {
  it("lists each space with its facts and a link to its page", async () => {
    mockFetch({
      "GET /api/health": { body: { jira: true } },
      "GET /api/spaces": {
        body: [space(), space({ id: 8, key: "GAD", name: "Gadgets", lastCrawledAt: null, repos: [], workItemCount: 5 })],
      },
    });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    const widgets = (await screen.findByRole("link", { name: "Widgets" })).closest("li")!;
    expect(screen.getByRole("link", { name: "Widgets" })).toHaveAttribute("href", "/spaces/7");
    expect(within(widgets).getByText("WID")).toBeInTheDocument();
    expect(within(widgets).getByText("https://acme.example.test")).toBeInTheDocument();
    expect(within(widgets).getByText("1,234")).toBeInTheDocument();
    expect(within(widgets).getByText("acme/widgets")).toBeInTheDocument();
    const gadgets = screen.getByRole("link", { name: "Gadgets" }).closest("li")!;
    expect(screen.getByRole("link", { name: "Gadgets" })).toHaveAttribute("href", "/spaces/8");
    expect(within(gadgets).getByText(copy.spaces.neverCrawled)).toBeInTheDocument();
    expect(within(gadgets).getByText(copy.spaces.noLinkedRepos)).toBeInTheDocument();
  });

  it("points to Configure deploy on Repositories when no space is tracked", async () => {
    mockFetch({ "GET /api/health": { body: { jira: true } }, "GET /api/spaces": { body: [] } });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    expect(await screen.findByText(copy.spaces.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.spaces.emptyBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.spaces.toRepos })).toHaveAttribute("href", "/repos");
  });

  it("explains that Jira is off and never asks for spaces", async () => {
    const fetchMock = mockFetch({ "GET /api/health": { body: { jira: false } } });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    expect(await screen.findByText(copy.spaces.offTitle)).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("/api/spaces");
  });

  it("shows an error with a retry when the list cannot be read", async () => {
    mockFetch({ "GET /api/health": { body: { jira: true } }, "GET /api/spaces": { status: 500, body: { error: "boom" } } });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });
});
