import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewExemptionsPanel } from "./ReviewExemptionsPanel";
import { mockFetch, renderRoute } from "../test/render";
import { useCompare, useReport, useRepos } from "../api/hooks";
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
    const { user } = setup(
      repo({ reviewExemptions: { kind: "override", rules: { titleWords: ["mirror"], labels: ["vendored", "ported"] } } }),
    );
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

  it("sends null when reset, and shows the defaults again once the listing no longer holds an override", async () => {
    const override = repo({ reviewExemptions: { kind: "override", rules: { titleWords: ["mirror"], labels: [] } } });
    let listing = override;
    const user = userEvent.setup();
    let body: unknown = "not sent";
    mockFetch({
      "GET /api/repos": () => ({ body: [listing] }),
      "GET /api/review-exemptions/defaults": { body: reviewExemptionDefaults() },
      "PUT /api/repos/1/review-exemptions": (_url, init) => {
        body = JSON.parse(String(init?.body));
        listing = repo();
        return { body: listing };
      },
    });
    function Around() {
      const repos = useRepos();
      const current = repos.data?.[0] ?? override;
      return <ReviewExemptionsPanel repo={current} />;
    }
    renderRoute(<Around />);
    await open(user);
    expect(words()).toHaveValue("mirror");
    await user.type(words(), ", extra");
    await user.click(screen.getByRole("button", { name: text.reset }));
    expect(await screen.findByText(text.resetDone)).toBeInTheDocument();
    expect(body).toEqual({ exemptions: null });
    await waitFor(() => expect(words()).toHaveValue("sync, synced, syncing, synchronise"));
    expect(labels()).toHaveValue("reviewed-elsewhere");
  });

  it("reads the repositories and every report again after a save, with no crawl", async () => {
    const listing = repo();
    const reads = { repos: 0, report: 0, compare: 0 };
    const user = userEvent.setup();
    const fetchMock = mockFetch({
      "GET /api/repos": () => {
        reads.repos += 1;
        return { body: [listing] };
      },
      "GET /api/review-exemptions/defaults": { body: reviewExemptionDefaults() },
      "GET /api/repos/1/report": () => {
        reads.report += 1;
        return { body: {} };
      },
      "GET /api/compare": () => {
        reads.compare += 1;
        return { body: {} };
      },
      "PUT /api/repos/1/review-exemptions": { body: listing },
    });
    const range = { from: "2026-01-01", to: "2026-02-01", includeBots: false };
    function Around() {
      useRepos();
      useReport(1, range, []);
      useCompare([1, 2], range);
      return <ReviewExemptionsPanel repo={listing} />;
    }
    renderRoute(<Around />);
    await waitFor(() => expect(reads).toEqual({ repos: 1, report: 1, compare: 1 }));
    await open(user);
    await user.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(reads).toEqual({ repos: 2, report: 2, compare: 2 }));
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
    const { user } = setup(repo({ reviewExemptions: { kind: "unreadable" } }));
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
    // Announced as it appears, so a person typing the extra entry hears it.
    expect(screen.getByRole("alert")).toHaveTextContent(text.tooMany(4));
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

  it("refuses a title word with no letter or digit before saving, and announces why", async () => {
    const { user, sent } = setup();
    await open(user);
    await user.clear(words());
    await user.type(words(), "mirror, ---");
    expect(screen.getByRole("alert")).toHaveTextContent(text.noWord);
    expect(words()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(sent()).toBe("not sent");
    // The same text is fine as a label, which the API does not hold to the rule.
    await user.clear(words());
    await user.type(words(), "mirror");
    await user.clear(labels());
    await user.type(labels(), "---");
    expect(screen.queryByText(text.noWord)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeEnabled();
  });

  it("accepts a title word with letters or digits in any script", async () => {
    const { user } = setup();
    await open(user);
    await user.clear(words());
    await user.type(words(), "v2, 同期");
    expect(screen.queryByText(text.noWord)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeEnabled();
  });

  it("says when an entry holds a control character and keeps Save off", async () => {
    const { user } = setup();
    await open(user);
    await user.click(words());
    await user.paste("bad\u0007word");
    expect(screen.getByText(text.control)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
  });

  it("keeps Save off, with a notice, while the defaults load, and offers a retry that recovers if they fail", async () => {
    const listing = repo();
    const user = userEvent.setup();
    let answer: (response: { status?: number; body?: unknown }) => void = () => undefined;
    const first = new Promise<{ status?: number; body?: unknown }>((resolve) => (answer = resolve));
    let calls = 0;
    mockFetch({
      "GET /api/repos": { body: [listing] },
      "GET /api/review-exemptions/defaults": () => {
        calls += 1;
        return calls === 1 ? first : { body: reviewExemptionDefaults() };
      },
    });
    renderRoute(<ReviewExemptionsPanel repo={listing} />);
    await user.click(screen.getByRole("button", { name: text.open }));
    expect(await screen.findByText(text.loadingDefaults)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();

    answer({ status: 500, body: { error: "defaults failed" } });
    expect(await screen.findByText(/defaults failed/)).toBeInTheDocument();
    expect(screen.queryByText(text.loadingDefaults)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    await waitFor(() => expect(screen.getByRole("button", { name: text.save })).toBeEnabled());
    expect(screen.queryByText(/defaults failed/)).not.toBeInTheDocument();
  });

  it("closes again", async () => {
    const { user } = setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: text.close }));
    expect(screen.queryByRole("form", { name: text.title })).not.toBeInTheDocument();
  });
});
