import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpacesPage } from "./SpacesPage";
import { mockFetch, renderRoute } from "../test/render";
import { CRAWL_POLL_MS, type SpaceListItem } from "../api/hooks";
import { copy } from "../copy";

const space = (overrides: Partial<SpaceListItem> = {}): SpaceListItem => ({
  id: 7,
  key: "WID",
  name: "Widgets",
  siteUrl: "https://acme.example.test",
  lastCrawledAt: "2026-03-01T10:00:00Z",
  crawlStatus: "idle",
  crawlError: null,
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

  it("says which spaces failed their last crawl and why", async () => {
    mockFetch({
      "GET /api/health": { body: { jira: true } },
      "GET /api/spaces": {
        body: [
          space({ crawlStatus: "failed", crawlError: "Rate limited by Jira" }),
          space({ id: 8, key: "GAD", name: "Gadgets" }),
          space({ id: 9, key: "OPS", name: "Operations", crawlStatus: "failed", crawlError: null }),
        ],
      },
    });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    const widgets = (await screen.findByRole("link", { name: "Widgets" })).closest("li")!;
    expect(within(widgets).getByText(copy.spaces.crawlFailedTitle)).toBeInTheDocument();
    expect(within(widgets).getByText(copy.spaces.crawlFailedReason("Rate limited by Jira"))).toBeInTheDocument();
    const gadgets = screen.getByRole("link", { name: "Gadgets" }).closest("li")!;
    expect(within(gadgets).queryByText(copy.spaces.crawlFailedTitle)).not.toBeInTheDocument();
    const operations = screen.getByRole("link", { name: "Operations" }).closest("li")!;
    expect(within(operations).getByText(copy.spaces.crawlFailedTitle)).toBeInTheDocument();
    expect(within(operations).queryByText(/The reason given/)).not.toBeInTheDocument();
  });

  it("shows an error with a retry, and asks for no spaces, when the health check fails", async () => {
    const user = userEvent.setup();
    let healthy = false;
    const fetchMock = mockFetch({
      "GET /api/health": () => (healthy ? { body: { jira: true } } : { status: 500, body: { error: "health down" } }),
      "GET /api/spaces": { body: [space()] },
    });
    renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
    expect(await screen.findByText("health down")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("/api/spaces");
    healthy = true;
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByRole("link", { name: "Widgets" })).toBeInTheDocument();
  });

  it("asks for the list again after the poll interval while a space is crawling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let crawling = true;
      const fetchMock = mockFetch({
        "GET /api/health": { body: { jira: true } },
        "GET /api/spaces": () => ({ body: [space({ crawlStatus: crawling ? "crawling" : "idle" })] }),
      });
      renderRoute(<SpacesPage />, { path: "/spaces", route: "/spaces" });
      await screen.findByRole("link", { name: "Widgets" });
      const listCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/spaces").length;
      expect(listCalls()).toBe(1);
      crawling = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CRAWL_POLL_MS);
      });
      await waitFor(() => expect(listCalls()).toBe(2));
      // Once nothing is crawling the polling stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CRAWL_POLL_MS * 3);
      });
      expect(listCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
