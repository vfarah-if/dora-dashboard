import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewQueue } from "@dora-dashboard/core";
import { ReviewQueuePage } from "./ReviewQueuePage";
import { mockFetch, renderRoute } from "../test/render";
import { queueEntry, reviewQueue } from "../test/fixtures";
import { copy } from "../copy";
import { formatTime } from "../lib/format";

const text = copy.reviewQueue;

function renderQueue(queue = reviewQueue(), route = "/review-queue") {
  const fetchMock = mockFetch({ "GET /api/review-queue": { body: queue } });
  const utils = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route });
  return { ...utils, fetchMock };
}

afterEach(() => vi.restoreAllMocks());

/** The query string of every review queue request made so far, in order. */
const queueQueries = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost").searchParams);

describe("ReviewQueuePage", () => {
  it("announces the loading message once while the queue loads", () => {
    mockFetch({ "GET /api/review-queue": () => new Promise(() => undefined) });
    renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    expect(screen.getAllByRole("status").filter((el) => el.textContent === text.loading)).toHaveLength(1);
  });

  it("shows the tiles, the updated time and four lanes by default", async () => {
    renderQueue();
    expect(await screen.findByText(text.tiles.waiting)).toBeInTheDocument();
    expect(screen.getByText(/^Updated \d{2}:\d{2}$/)).toBeInTheDocument();
    for (const lane of ["no_reviewer", "awaiting_review", "with_author", "approved"] as const) {
      expect(screen.getByRole("heading", { name: new RegExp(`^${text.lanes[lane].title} \\d+$`) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: /Drafts and on hold/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Draft spike")).not.toBeInTheDocument();
    expect(screen.queryByText("Bump deps")).not.toBeInTheDocument();
  });

  it("lists stale pull requests first under Needs attention, with text flags", async () => {
    renderQueue();
    const section = (await screen.findByRole("heading", { name: text.attention.title })).closest("section")!;
    const rows = within(section).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Stale, 12 weekdays, no reviewer");
    expect(rows[0]).toHaveTextContent("Rework billing");
    expect(rows[1]).toHaveTextContent("Over 24h, 1 weekday, awaiting review");
  });

  it("hides names by default and reveals them with the toggle", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    expect(screen.queryByText(/casey/)).not.toBeInTheDocument();
    expect(screen.queryByText(/robin/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(text.controls.waitingOn)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    expect(screen.getAllByText(/by casey/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Waiting on robin/).length).toBeGreaterThan(0);
  });

  it("shows the author avatar only with Show names, and states the wait once", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    const card = () => screen.getByRole("link", { name: /^Fix retry/ }).closest("li")!;
    expect(card().querySelector(".pr-avatar")).toBeNull();
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    const avatar = await waitFor(() => {
      const found = card().querySelector(".pr-avatar");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(avatar).toHaveTextContent(/casey/);
    expect(avatar.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(card()).toHaveTextContent(/\+\d+ -\d+ · \d+ files?/);
    expect(within(card()).getByText(text.card.checks.failing).closest(".checks-status")).toHaveClass("checks-failing");
    const flagged = screen.getByRole("link", { name: /^Rework billing/ }).closest("li")!;
    expect(flagged).toHaveTextContent("Stale, 12 weekdays, no reviewer");
    expect(flagged).not.toHaveTextContent(/Waiting \d+ weekdays/);
  });

  it("makes the board a focusable region and shows a dashed placeholder in an empty lane", async () => {
    renderQueue(
      reviewQueue({
        entries: reviewQueue().entries.filter((e) => e.lane !== "approved"),
      }),
    );
    await screen.findByText(text.tiles.waiting);
    const board = screen.getByRole("region", { name: text.lanes.boardLabel });
    expect(board).toHaveAttribute("tabindex", "0");
    const lane = screen.getByRole("heading", { name: /^Approved 0$/ }).closest("section")!;
    expect(within(lane).getByText(text.lanes.empty)).toHaveClass("queue-lane-empty");
    expect(within(lane).queryByRole("list")).not.toBeInTheDocument();
  });

  it("adds the held column and bot pull requests when their toggles are on", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("switch", { name: text.controls.drafts }));
    await user.click(screen.getByRole("switch", { name: text.controls.bots }));
    expect(screen.getByRole("heading", { name: /Drafts and on hold/ })).toBeInTheDocument();
    expect(screen.getByText("Draft spike")).toBeInTheDocument();
    expect(screen.getByText("Bump deps")).toBeInTheDocument();
  });

  it("filters by search and by the reviewer waited on", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    await user.type(screen.getByLabelText(text.controls.search), "export");
    expect(screen.getAllByText("Add export").length).toBeGreaterThan(0);
    expect(screen.queryByText("Tidy docs")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText(text.controls.search));
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    await user.selectOptions(screen.getByLabelText(text.controls.waitingOn), "robin");
    expect(screen.queryByText("Tidy docs")).not.toBeInTheDocument();
    expect(screen.getAllByText("Add export").length).toBeGreaterThan(0);
  });

  it("narrows the queue to the repositories ticked and widens it again when unticked", async () => {
    const user = userEvent.setup();
    const base = reviewQueue();
    const gadget = queueEntry({ repoId: 2, repo: "acme/gadgets", number: 20, title: "Gadget fix" });
    renderQueue({
      ...base,
      entries: [...base.entries, gadget],
      repos: [...base.repos, { ...base.repos[0]!, repoId: 2, repo: "acme/gadgets", open: 1 }],
    });
    const gadgets = await screen.findByRole("checkbox", { name: "acme/gadgets" });
    expect(screen.getByRole("checkbox", { name: "acme/widgets" })).not.toBeChecked();
    expect(screen.getAllByText("Add export").length).toBeGreaterThan(0);

    await user.click(gadgets);
    expect(gadgets).toBeChecked();
    expect(screen.getByText("Gadget fix")).toBeInTheDocument();
    expect(screen.queryByText("Add export")).not.toBeInTheDocument();

    await user.click(gadgets);
    expect(gadgets).not.toBeChecked();
    expect(screen.getAllByText("Add export").length).toBeGreaterThan(0);
  });

  it("shows a band legend, a bar per repository and its table", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    const legend = screen.getByRole("list", { name: text.repos.legendLabel });
    expect(within(legend).getByText("Stale, 5 weekdays or more")).toBeInTheDocument();
    expect(screen.getByText(text.repos.weekendNote)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: text.repos.barLabel("acme/widgets") })).toBeInTheDocument();
    await user.click(screen.getByText(copy.common.viewAsTable));
    expect(screen.getByRole("table", { name: "acme/widgets" })).toBeInTheDocument();
  });

  it("groups features", async () => {
    renderQueue();
    expect(await screen.findByRole("heading", { name: text.features.title })).toBeInTheDocument();
    expect(screen.getByText(text.features.evidence.ticket)).toBeInTheDocument();
  });

  it("names a repository that could not be read", async () => {
    renderQueue(reviewQueue({ errors: [{ repoId: 2, repo: "acme/gadgets", message: "boom" }] }));
    expect(await screen.findByText(text.readErrorTitle("acme/gadgets"))).toBeInTheDocument();
  });

  it("copies a summary without names and confirms it", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: text.copySummary }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain("Stale, 12 weekdays, no reviewer");
    expect(writeText.mock.calls[0]![0]).not.toContain("casey");
    expect(await screen.findByText(text.copied)).toBeInTheDocument();
  });

  it("saves the queue as a PDF under a review queue file name", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    const titles: string[] = [];
    vi.spyOn(window, "print").mockImplementation(() => {
      titles.push(document.title);
      window.dispatchEvent(new Event("afterprint"));
    });
    await user.click(screen.getByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(titles).toHaveLength(1));
    expect(titles[0]).toMatch(/^review-queue-report-\d{4}-\d{2}-\d{2}$/);
  });

  it("reports a failed copy", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: text.copySummary }));
    expect(await screen.findByText(text.copyFailed)).toBeInTheDocument();
  });

  it("refreshes every repository with refresh=1 when none is ticked", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderQueue();
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(queueQueries(fetchMock).some((q) => q.get("refresh") === "1")).toBe(true));
    expect(queueQueries(fetchMock).some((q) => q.has("refreshIds"))).toBe(false);
  });

  it("refreshes only the ticked repositories, and says when those were read", async () => {
    const user = userEvent.setup();
    const base = reviewQueue();
    const { fetchMock } = renderQueue(
      {
        ...base,
        fetchedAt: "2026-03-09T09:30:00Z",
        repos: [base.repos[0]!, { ...base.repos[0]!, repoId: 2, repo: "acme/gadgets", fetchedAt: "2026-03-09T09:30:00Z" }],
      },
      "/review-queue?repos=1",
    );
    expect(await screen.findByText(text.updated(formatTime("2026-03-09T09:58:00Z")))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(queueQueries(fetchMock).some((q) => q.has("refreshIds"))).toBe(true));
    const refresh = queueQueries(fetchMock).find((q) => q.has("refreshIds"))!;
    // Exactly "1", so a request for repository 12 would not pass, and no `refresh`, which would read every repository.
    expect(refresh.get("refreshIds")).toBe("1");
    expect(refresh.has("refresh")).toBe(false);
  });

  it("names both repositories to read again when two are ticked", async () => {
    const user = userEvent.setup();
    const base = reviewQueue();
    const { fetchMock } = renderQueue(
      { ...base, repos: [base.repos[0]!, { ...base.repos[0]!, repoId: 2, repo: "acme/gadgets" }] },
      "/review-queue?repos=1,2",
    );
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(queueQueries(fetchMock).some((q) => q.has("refreshIds"))).toBe(true));
    const refresh = queueQueries(fetchMock).find((q) => q.has("refreshIds"))!;
    expect(refresh.get("refreshIds")).toBe("1,2");
    expect(refresh.has("refresh")).toBe(false);
  });

  it("keeps the button busy and the figures dimmed when the minute's poll lands mid-refresh, and still announces a failure after it", async () => {
    const user = userEvent.setup();
    let failRefresh = () => undefined as void;
    const fetchMock = mockFetch({
      "GET /api/review-queue": (url) =>
        url.searchParams.has("refresh")
          ? new Promise((resolve) => (failRefresh = () => resolve({ status: 502, body: { error: "GitHub is down" } })))
          : { body: reviewQueue() },
    });
    const { client } = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    const body = document.querySelector(".queue-body")!;
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await screen.findByRole("button", { name: text.refreshing });

    const before = fetchMock.mock.calls.length;
    await client.refetchQueries({ queryKey: ["review-queue"] });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
    expect(screen.getByRole("button", { name: text.refreshing })).toBeDisabled();
    expect(body).toHaveClass("is-refreshing");
    expect(body).toHaveAttribute("aria-busy", "true");

    // A failure is only news if it is later than the poll's answer, which is stamped to the millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    failRefresh();
    expect(await screen.findByText(text.refreshFailed)).toBeInTheDocument();
    expect(screen.getByText("GitHub is down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.refresh })).toBeEnabled();
  });

  it("does not put the answer for one Show names setting under the other when it is toggled mid-refresh", async () => {
    const user = userEvent.setup();
    const refreshed = reviewQueue({ fetchedAt: "2026-03-09T11:11:00Z" });
    let finish = () => undefined as void;
    mockFetch({
      "GET /api/review-queue": (url) =>
        url.searchParams.has("refresh")
          ? new Promise((resolve) => (finish = () => resolve({ body: refreshed })))
          : { body: reviewQueue() },
    });
    const { client } = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await screen.findByRole("button", { name: text.refreshing });
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    await waitFor(() => expect(client.getQueryData<ReviewQueue>(["review-queue", [], true])).toBeDefined());

    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: text.refresh })).toBeEnabled());
    expect(client.getQueryData<ReviewQueue>(["review-queue", [], false])?.fetchedAt).toBe(refreshed.fetchedAt);
    expect(client.getQueryData<ReviewQueue>(["review-queue", [], true])?.fetchedAt).not.toBe(refreshed.fetchedAt);
  });

  it("keeps the figures on screen, dimmed and busy, with a spinner on the button while a refresh runs", async () => {
    const user = userEvent.setup();
    let finish = () => undefined as void;
    mockFetch({
      "GET /api/review-queue": (url) =>
        url.searchParams.has("refresh")
          ? new Promise((resolve) => (finish = () => resolve({ body: reviewQueue() })))
          : { body: reviewQueue() },
    });
    renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    const body = document.querySelector(".queue-body")!;
    expect(body).toHaveAttribute("aria-busy", "false");
    expect(body).not.toHaveClass("is-refreshing");

    await user.click(screen.getByRole("button", { name: text.refresh }));
    const button = await screen.findByRole("button", { name: text.refreshing });
    expect(button).toBeDisabled();
    expect(button.querySelector(".spinner")).toHaveAttribute("aria-hidden", "true");
    expect(body).toHaveClass("is-refreshing");
    expect(body).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(text.tiles.waiting)).toBeInTheDocument();

    finish();
    await waitFor(() => expect(body).not.toHaveClass("is-refreshing"));
    expect(body).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: text.refresh }).querySelector(".spinner")).toBeNull();
  });

  it("dims the figures shown while the queue with names loads", async () => {
    const user = userEvent.setup();
    let finish = () => undefined as void;
    mockFetch({
      "GET /api/review-queue": (url) =>
        url.searchParams.has("names")
          ? new Promise((resolve) => (finish = () => resolve({ body: reviewQueue() })))
          : { body: reviewQueue() },
    });
    renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    const body = document.querySelector(".queue-body")!;
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    await waitFor(() => expect(body).toHaveClass("is-refreshing"));
    finish();
    await waitFor(() => expect(body).not.toHaveClass("is-refreshing"));
  });

  it("does not dim the figures for the minute's poll", async () => {
    let hold = false;
    let finish = () => undefined as void;
    const fetchMock = mockFetch({
      "GET /api/review-queue": () =>
        hold ? new Promise((resolve) => (finish = () => resolve({ body: reviewQueue() }))) : { body: reviewQueue() },
    });
    const { client } = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    hold = true;
    void client.refetchQueries({ queryKey: ["review-queue"] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = document.querySelector(".queue-body")!;
    expect(body).not.toHaveClass("is-refreshing");
    expect(body).toHaveAttribute("aria-busy", "false");
    finish();
  });

  it("asks for names only when Show names is on", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderQueue();
    await screen.findByText(text.tiles.waiting);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("names=1");
    await user.click(screen.getByRole("switch", { name: text.controls.names }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("names=1"))).toBe(true));
  });

  it("shows the reviewer count when names are hidden", async () => {
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    expect(screen.getAllByText(new RegExp(text.card.reviewersRequested(1))).length).toBeGreaterThan(0);
  });

  it("recomputes the tiles from the filtered pull requests", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    const tile = () => screen.getByRole("heading", { name: text.tiles.stale }).closest("article")!;
    expect(tile()).toHaveTextContent("1");
    expect(tile()).toHaveClass("tile-danger");
    await user.type(screen.getByLabelText(text.controls.search), "export");
    expect(tile()).toHaveTextContent(text.tiles.staleNone);
    expect(tile()).not.toHaveTextContent(/Longest wait/);
    expect(tile()).not.toHaveClass("tile-danger");
  });

  it("says plainly when no pull request is in a tile", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    await user.type(screen.getByLabelText(text.controls.search), "zzzz-no-match");
    const tile = (label: string) => screen.getByRole("heading", { name: label }).closest("article")!;
    expect(tile(text.tiles.pastDay)).toHaveTextContent(text.tiles.pastDayNone);
    expect(tile(text.tiles.noReviewer)).toHaveTextContent(text.tiles.noReviewerNone);
    expect(tile(text.tiles.stale)).toHaveTextContent(text.tiles.staleNone);
  });

  it("names each pull request link with the bracketed new tab note used across the app", async () => {
    renderQueue();
    const section = (await screen.findByRole("heading", { name: text.attention.title })).closest("section")!;
    expect(within(section).getAllByRole("link")[0]).toHaveTextContent(/Rework billing \(opens in a new tab\)$/);
    const board = screen.getByRole("region", { name: text.lanes.boardLabel });
    for (const link of within(board).getAllByRole("link")) {
      expect(link).toHaveTextContent(new RegExp(`${copy.common.opensInNewTab.replace(/[()]/g, "\\$&")}$`));
    }
  });

  it("shows a notice for partly read repositories", async () => {
    renderQueue(reviewQueue({ warnings: [{ repoId: 1, repo: "acme/widgets", message: "Only the newest 500 were read" }] }));
    expect(await screen.findByText(text.partialTitle("acme/widgets"))).toBeInTheDocument();
    expect(screen.getByText("Only the newest 500 were read")).toBeInTheDocument();
  });

  it("clears the refresh warning once a later poll succeeds", async () => {
    const user = userEvent.setup();
    let fail = false;
    const fetchMock = mockFetch({
      "GET /api/review-queue": (url) =>
        fail && url.searchParams.has("refresh") ? { status: 500, body: { error: "no" } } : { body: reviewQueue() },
    });
    const { client } = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    fail = true;
    await user.click(screen.getByRole("button", { name: text.refresh }));
    expect(await screen.findByText(text.refreshFailed)).toBeInTheDocument();
    fail = false;
    await client.refetchQueries({ queryKey: ["review-queue"] });
    await waitFor(() => expect(screen.queryByText(text.refreshFailed)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalled();
  });

  it("gives the reason each repository could not be read, beneath its title", async () => {
    renderQueue(reviewQueue({ errors: [{ repoId: 2, repo: "acme/gadgets", message: "GitHub answered 502" }] }));
    const title = await screen.findByText(text.readErrorTitle("acme/gadgets"));
    const notice = title.closest(".notice")!;
    expect(within(notice as HTMLElement).getByText("GitHub answered 502")).toBeInTheDocument();
    expect(within(notice as HTMLElement).getByText(text.readErrorBody)).toBeInTheDocument();
  });

  it("gives the reason a refresh failed", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/review-queue": (url) =>
        url.searchParams.has("refresh") ? { status: 502, body: { error: "GitHub answered 502" } } : { body: reviewQueue() },
    });
    renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("button", { name: text.refresh }));
    expect(await screen.findByText(text.refreshFailed)).toBeInTheDocument();
    expect(screen.getByText("GitHub answered 502")).toBeInTheDocument();
  });

  it("warns that the queue could not be updated, with when the figures were read, when a poll fails", async () => {
    let fail = false;
    mockFetch({
      "GET /api/review-queue": () => (fail ? { status: 500, body: { error: "no" } } : { body: reviewQueue() }),
    });
    const { client } = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    await screen.findByText(text.tiles.waiting);
    expect(screen.queryByText(text.pollFailed(formatTime(reviewQueue().fetchedAt)))).not.toBeInTheDocument();
    fail = true;
    await client.refetchQueries({ queryKey: ["review-queue"] });
    expect(await screen.findByText(text.pollFailed(formatTime(reviewQueue().fetchedAt)))).toBeInTheDocument();
    expect(screen.getByText(text.tiles.waiting)).toBeInTheDocument();

    fail = false;
    await client.refetchQueries({ queryKey: ["review-queue"] });
    await waitFor(() => expect(screen.queryByText(/could not be updated/)).not.toBeInTheDocument());
  });

  it("shows an empty state when nothing is open", async () => {
    renderQueue(reviewQueue({ entries: [], needsAttention: [], features: [] }));
    expect(await screen.findByText(text.empty)).toBeInTheDocument();
  });

  it("shows an error with a retry when the request fails", async () => {
    mockFetch({ "GET /api/review-queue": { status: 500, body: { error: "Queue unavailable" } } });
    renderRoute(<ReviewQueuePage />, { path: "/review-queue", route: "/review-queue" });
    expect(await screen.findByText("Queue unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });
});
