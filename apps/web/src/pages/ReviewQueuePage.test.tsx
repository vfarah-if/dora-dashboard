import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueuePage } from "./ReviewQueuePage";
import { mockFetch, renderRoute } from "../test/render";
import { reviewQueue } from "../test/fixtures";
import { copy } from "../copy";

const text = copy.reviewQueue;

function renderQueue(queue = reviewQueue(), route = "/review-queue") {
  const fetchMock = mockFetch({ "GET /api/review-queue": { body: queue } });
  const utils = renderRoute(<ReviewQueuePage />, { path: "/review-queue", route });
  return { ...utils, fetchMock };
}

afterEach(() => vi.restoreAllMocks());

describe("ReviewQueuePage", () => {
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
    expect(card()).toHaveTextContent(/\+\d+ -\d+ · \d+ files? · checks failing/);
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

  it("reports a failed copy", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText(text.tiles.waiting);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: text.copySummary }));
    expect(await screen.findByText(text.copyFailed)).toBeInTheDocument();
  });

  it("refreshes with refresh=1", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderQueue();
    await screen.findByText(text.tiles.waiting);
    await user.click(screen.getByRole("button", { name: text.refresh }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("refresh=1"))).toBe(true));
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
    expect(tile()).toHaveTextContent(text.tiles.staleHint(text.tiles.none));
    expect(tile()).not.toHaveClass("tile-danger");
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
