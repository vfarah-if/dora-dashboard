import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewExemptionsPanel } from "./ReviewExemptionsPanel";
import { mockFetch, renderRoute } from "../test/render";
import { useRepos } from "../api/hooks";
import { repo, reviewExemptionDefaults } from "../test/fixtures";
import { copy } from "../copy";

const text = copy.reviewExemptions;

function setup(
  listing = repo(),
  response: { status?: number; body?: unknown } = { body: listing },
  defaults: { status?: number; body?: unknown } = { body: reviewExemptionDefaults() },
) {
  let body: unknown = "not sent";
  const fetchMock = mockFetch({
    "GET /api/repos": { body: [listing] },
    "GET /api/review-exemptions/defaults": defaults,
    "PUT /api/repos/1/review-exemptions": (_url, init) => {
      body = JSON.parse(String(init?.body));
      return response;
    },
  });
  renderRoute(<ReviewExemptionsPanel repo={listing} />);
  return { sent: () => body, fetchMock, user: userEvent.setup() };
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: text.open }));
  await waitFor(() => expect(screen.getByRole("button", { name: text.save })).toBeEnabled());
};
const words = () => screen.getByLabelText(text.titleWordsLabel);
const labels = () => screen.getByLabelText(text.labelsLabel);

describe("ReviewExemptionsPanel", () => {
  it("stays closed, and asks the API for nothing, until it is opened", () => {
    const { fetchMock } = setup();
    expect(screen.getByRole("button", { name: text.open })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("form", { name: text.title })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains in plain words that a review by a tool under the author's account counts, and that syncs can be left out", async () => {
    const { user } = setup();
    await open(user);
    expect(screen.getByRole("button", { name: text.close })).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/posted by Claude or any other tool under the author's own account counts as a review/),
    ).toBeInTheDocument();
    expect(screen.getByText(/such as a sync, can be left out/)).toBeInTheDocument();
  });

  it("shows the default words and label in the boxes, and lists them as the defaults", async () => {
    const { user } = setup();
    await open(user);
    expect(words()).toHaveValue("sync, synced, syncing, synchronise");
    expect(labels()).toHaveValue("reviewed-elsewhere");
    expect(
      screen.getByText("The defaults are the title words sync, synced, syncing, synchronise and the label reviewed-elsewhere."),
    ).toBeInTheDocument();
  });

  it("starts from the repository's own rules when it has them", async () => {
    const { user } = setup(repo({ reviewExemptions: { titleWords: ["mirror"], labels: ["vendored", "ported"] } }));
    await open(user);
    expect(words()).toHaveValue("mirror");
    expect(labels()).toHaveValue("vendored, ported");
  });

  it("sends both lists with entries trimmed and split on commas", async () => {
    const { user, sent } = setup();
    await open(user);
    await user.clear(words());
    await user.type(words(), " mirror ,  Vendor,, ");
    await user.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByText(text.saved)).toBeInTheDocument();
    expect(sent()).toEqual({ exemptions: { titleWords: ["mirror", "Vendor"], labels: ["reviewed-elsewhere"] } });
  });

  it("sends empty lists when both boxes are cleared, which leaves nothing out", async () => {
    const { user, sent } = setup();
    await open(user);
    await user.clear(words());
    await user.clear(labels());
    await user.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByText(text.saved)).toBeInTheDocument();
    expect(sent()).toEqual({ exemptions: { titleWords: [], labels: [] } });
  });

  it("sends null when reset, and shows the defaults again", async () => {
    const { user, sent } = setup(repo({ reviewExemptions: { titleWords: ["mirror"], labels: [] } }));
    await open(user);
    await user.type(words(), ", extra");
    await user.click(screen.getByRole("button", { name: text.reset }));
    expect(await screen.findByText(text.resetDone)).toBeInTheDocument();
    expect(sent()).toEqual({ exemptions: null });
  });

  it("reads the repositories and every report again after a save, with no crawl", async () => {
    const listing = repo();
    const reads = { repos: 0 };
    const user = userEvent.setup();
    const fetchMock = mockFetch({
      "GET /api/repos": () => {
        reads.repos += 1;
        return { body: [listing] };
      },
      "GET /api/review-exemptions/defaults": { body: reviewExemptionDefaults() },
      "PUT /api/repos/1/review-exemptions": { body: listing },
    });
    function Around() {
      useRepos();
      return <ReviewExemptionsPanel repo={listing} />;
    }
    renderRoute(<Around />);
    await waitFor(() => expect(reads.repos).toBe(1));
    await open(user);
    await user.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(reads.repos).toBe(2));
    const calls = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0])}`);
    expect(calls.some((m) => m.includes("crawl"))).toBe(false);
  });

  it("shows the API's reason and no saved message when the save is refused", async () => {
    const { user } = setup(repo(), { status: 400, body: { error: "exemptions.titleWords has too many entries" } });
    await open(user);
    await user.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("exemptions.titleWords has too many entries");
    expect(screen.queryByText(text.saved)).not.toBeInTheDocument();
  });

  it("shows the error when a reset fails", async () => {
    const { user } = setup(repo(), { status: 500, body: { error: "boom" } });
    await open(user);
    await user.click(screen.getByRole("button", { name: text.reset }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText(text.resetDone)).not.toBeInTheDocument();
  });

  it("warns when the saved rules could not be read", async () => {
    const { user } = setup(repo({ reviewExemptionsUnreadable: true }));
    await open(user);
    expect(screen.getByText(text.unreadable)).toBeInTheDocument();
  });

  it("keeps Save off and says why when a box holds more entries than the API allows", async () => {
    const defaults = { ...reviewExemptionDefaults(), limits: { titleWords: 4, labels: 30, length: 100 } };
    const { user, sent } = setup(repo(), undefined, { body: defaults });
    await open(user);
    await user.clear(words());
    await user.click(words());
    await user.paste("a,b,c,d,e");
    expect(screen.getByText(text.tooMany(4))).toBeInTheDocument();
    expect(words()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(sent()).toBe("not sent");
  });

  it("says when an entry is longer than the API allows", async () => {
    const defaults = { ...reviewExemptionDefaults(), limits: { titleWords: 30, labels: 30, length: 20 } };
    const { user } = setup(repo(), undefined, { body: defaults });
    await open(user);
    await user.clear(labels());
    await user.click(labels());
    await user.paste("x".repeat(21));
    expect(screen.getByText(text.tooLong(20))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  });

  it("says when an entry holds a control character and keeps Save off", async () => {
    const { user } = setup();
    await open(user);
    await user.click(words());
    await user.paste("bad\u0007word");
    expect(screen.getByText(text.control)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  });

  it("keeps Save off, with a notice, while the defaults load, and shows an error with retry if they fail", async () => {
    const { user } = setup(repo(), undefined, { status: 500, body: { error: "defaults failed" } });
    await user.click(screen.getByRole("button", { name: text.open }));
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(await screen.findByText(/defaults failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  });

  it("closes again", async () => {
    const { user } = setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: text.close }));
    expect(screen.queryByRole("form", { name: text.title })).not.toBeInTheDocument();
  });
});
