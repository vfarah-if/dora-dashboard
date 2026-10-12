import type { SecuritySummary } from "@dora-dashboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecurityListPage } from "./SecurityListPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo, securityAction, securitySummary } from "../test/fixtures";
import { copy } from "../copy";

const second = securitySummary({
  repo: { id: 2, owner: "acme", name: "gadgets", lastCrawledAt: null, crawlStatus: "idle" },
  band: "low",
  open: { critical: 3, high: 0, medium: 0, low: 0, unknown: 0 },
  pastFix: 2,
  actions: 4,
  topAction: securityAction({ kind: "rotate_secret", target: "GitHub Personal Access Token", count: 1 }),
  scorecard: 7.25,
});
const ungraded = securitySummary({
  repo: { id: 3, owner: "acme", name: "gizmos", lastCrawledAt: null, crawlStatus: "idle" },
  band: null,
  limitedBy: null,
  gradeMissing: "not_crawled",
  open: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  pastFix: 0,
  actions: 0,
  readAt: null,
  read: false,
  raiseGrade: null,
  sources: { dependabot: "not_read", code_scanning: "not_read", secret_scanning: "not_read", osv: "not_read" },
  used: { dependabot: false, code_scanning: false, secret_scanning: false, osv: false },
  supplyChain: "not_read",
  topAction: null,
});

const show = (summaries: SecuritySummary[], health: unknown = { osv: true }) => {
  const fetchMock = mockFetch({
    "GET /api/security": { body: summaries },
    "GET /api/health": { body: health },
    "GET /api/repos": { body: [] },
  });
  const view = renderRoute(<SecurityListPage />, { path: "/security", route: "/security" });
  return { fetchMock, ...view };
};

describe("SecurityListPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a loading state until the summaries arrive", async () => {
    show([securitySummary()]);
    expect(screen.getByRole("status")).toHaveTextContent(copy.security.list.loading);
    expect(await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ })).toBeInTheDocument();
  });

  it("lists graded repositories in the order the API gave, each linking to its report", async () => {
    show([second, securitySummary()]);
    const links = await screen.findAllByRole("link", { name: /Open the security report for/ });
    expect(links.map((l) => l.textContent)).toEqual(["acme/gadgets", "acme/widgets"]);
    expect(links[0]).toHaveAttribute("href", "/repos/2/security");
    expect(links[0]).toHaveAccessibleName("Open the security report for acme/gadgets");
    expect(links[0]!.closest("li")).toHaveClass("card", "repo-row");
  });

  it("shows the grade as a band with its word, the open alerts in words, the alerts past fix-by, the actions and the last read", async () => {
    show([securitySummary()]);
    const row = (await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ })).closest("li")!;
    const facts = row.querySelector("dl")!;
    const fact = (name: string) => within(facts).getByText(name).parentElement!;
    expect(fact(copy.security.list.facts.grade)).toHaveTextContent("Medium");
    expect(fact(copy.security.list.facts.open)).toHaveTextContent("1 critical, 2 high, 2 medium and 1 low");
    expect(fact(copy.security.list.facts.pastFix)).toHaveTextContent("1");
    expect(fact(copy.security.list.facts.actions)).toHaveTextContent("2");
    expect(fact(copy.security.list.facts.read)).toHaveTextContent("1 Mar 2026, 10:02");
    expect(within(facts).queryByText(copy.security.list.facts.scorecard)).not.toBeInTheDocument();
  });

  it("says which sources were read and what to start with", async () => {
    show([securitySummary()]);
    expect(
      await screen.findByText(
        "Read Dependabot alerts, code scanning and workflow and dependency files. Not read secret scanning.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.security.list.startWith)).toBeInTheDocument();
    expect(screen.getByText("left-pad has 2 open critical alerts, and version 1.3.1 fixes them.")).toBeInTheDocument();
  });

  it("shows the Scorecard figure when there is one", async () => {
    show([second]);
    const row = (await screen.findByRole("heading", { level: 3, name: /acme\/gadgets/ })).closest("li")!;
    expect(within(row).getByText(copy.security.list.facts.scorecard).parentElement).toHaveTextContent("7.3 out of 10");
  });

  it("puts repositories without a grade in their own list with the reason, and says Not graded", async () => {
    show([securitySummary(), ungraded]);
    const heading = await screen.findByRole("heading", { level: 2, name: copy.security.list.notGradedTitle });
    const row = within(heading.closest("section")!)
      .getByRole("heading", { level: 3, name: /acme\/gizmos/ })
      .closest("li")!;
    expect(row).toHaveTextContent(copy.security.list.facts.notGraded);
    expect(row).toHaveTextContent(copy.security.list.gradeMissing.not_crawled);
    // Open alerts, past fix-by and actions all say Not read yet, so no zero reads as an all clear.
    const facts = row.querySelector("dl")!;
    for (const name of [copy.security.list.facts.open, copy.security.list.facts.pastFix, copy.security.list.facts.actions]) {
      expect(within(facts).getByText(name).parentElement).toHaveTextContent(copy.security.list.notReadRow);
    }
    expect(row).not.toHaveTextContent("No open alerts");
    expect(row).toHaveTextContent(copy.security.list.facts.neverRead);
    expect(row).toHaveTextContent("Nothing has been read yet.");
    expect(within(row).queryByText(copy.security.list.startWith)).not.toBeInTheDocument();
    const graded = screen.getByRole("heading", { level: 2, name: copy.security.list.gradedTitle }).closest("section")!;
    expect(within(graded).queryByText(/gizmos/)).not.toBeInTheDocument();
  });

  it("leaves out the not graded list when every repository has a grade, and says none is graded when none is", async () => {
    const { unmount } = show([securitySummary()]);
    await screen.findByRole("heading", { level: 2, name: copy.security.list.gradedTitle });
    expect(screen.queryByRole("heading", { level: 2, name: copy.security.list.notGradedTitle })).not.toBeInTheDocument();
    unmount();
    show([ungraded]);
    expect(await screen.findByText(copy.security.list.noneGraded)).toBeInTheDocument();
  });

  it("says nothing could be measured when that is the reason", async () => {
    show([securitySummary({ ...ungraded, gradeMissing: "nothing_measured" })]);
    expect(await screen.findByText(copy.security.list.gradeMissing.nothing_measured)).toBeInTheDocument();
  });

  it("totals open critical alerts, those past their fix-by date and the repositories not graded", async () => {
    show([securitySummary(), second, ungraded]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;
    // 1 + 3 critical, 1 + 2 + 0 past fix-by, and one repository without a grade.
    expect(tile(copy.security.list.tiles.critical)).toHaveTextContent("4");
    expect(tile(copy.security.list.tiles.pastFix)).toHaveTextContent("3");
    expect(tile(copy.security.list.tiles.pastFix)).toHaveClass("tile-danger");
    expect(tile(copy.security.list.tiles.pastFix)).toHaveTextContent("have waited longer than their fix-by date allows");
    expect(tile(copy.security.list.tiles.notGraded)).toHaveTextContent("1");
  });

  it("adds up only the repositories that were read, and says from how many", async () => {
    const unreadWithZeros = { ...ungraded, open: { critical: 9, high: 0, medium: 0, low: 0, unknown: 0 }, pastFix: 5 };
    show([securitySummary(), second, unreadWithZeros]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;
    // The third repository was never read, so its 9 and 5 are not counted: 1 + 3 critical and 1 + 2 past fix-by.
    expect(tile(copy.security.list.tiles.critical)).toHaveTextContent("4");
    expect(tile(copy.security.list.tiles.pastFix)).toHaveTextContent("3");
    expect(tile(copy.security.list.tiles.critical)).toHaveTextContent("From 2 of 3 repositories read.");
    expect(tile(copy.security.list.tiles.pastFix)).toHaveTextContent("From 2 of 3 repositories read.");
  });

  it("says one repository in the singular", async () => {
    show([securitySummary()]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    const tile = screen.getByRole("heading", { level: 3, name: copy.security.list.tiles.critical }).closest("article")!;
    expect(tile).toHaveTextContent("From 1 of 1 repository read.");
  });

  it("tells a read repository from one never read by the summary's own flag", async () => {
    show([
      securitySummary({
        read: false,
        sources: { dependabot: "no_access", code_scanning: "not_read", secret_scanning: "not_read", osv: "not_read" },
        supplyChain: "not_read",
        used: { dependabot: false, code_scanning: false, secret_scanning: false, osv: false },
      }),
    ]);
    const row = (await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ })).closest("li")!;
    // Refused is not "not read yet", because a crawl would not change it.
    expect(within(row.querySelector("dl")!).getByText(copy.security.list.facts.open).parentElement).toHaveTextContent(
      copy.security.list.notUsedRow,
    );
    expect(row).toHaveTextContent(copy.security.list.coverage.noneUsable);
    expect(row).not.toHaveTextContent("Nothing has been read yet.");
  });

  it("explains Dependabot version updates against alerts, in the detail page's words, when the summary says so", async () => {
    show([
      securitySummary({
        dependabotVersionUpdates: ".github/dependabot.yml",
        sources: { dependabot: "off", code_scanning: "ok", secret_scanning: "ok", osv: "not_used" },
        used: { dependabot: false, code_scanning: true, secret_scanning: true, osv: false },
        topAction: securityAction({ kind: "enable_dependabot", target: "dependabot", count: 1 }),
      }),
    ]);
    const words = copy.security.dependabotAlerts.what(".github/dependabot.yml");
    // Once as the row's note and once as the action to start with, the same sentence on both pages.
    expect(await screen.findAllByText(words)).toHaveLength(2);
  });

  it("writes the real number of days in a row's top action from the summary's thresholds", async () => {
    const thresholds = { ...securitySummary().thresholds, lowAlertAdviceDays: 45 };
    show([
      securitySummary({
        thresholds,
        topAction: securityAction({ kind: "fix_low_alerts", target: null, count: 3 }),
      }),
    ]);
    expect(await screen.findByText(/3 low severity alerts have been open for more than 45 days/)).toBeInTheDocument();
    expect(screen.queryByText(/the time a low severity alert is allowed/)).not.toBeInTheDocument();
  });

  it("says nothing about version updates when the summary has none", async () => {
    show([securitySummary()]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    expect(screen.queryByText(/Dependabot version updates are set up/)).not.toBeInTheDocument();
  });

  it("does not call Dependabot unread when the OSV lookup covered for it", async () => {
    show([
      securitySummary({
        sources: { dependabot: "off", code_scanning: "ok", secret_scanning: "ok", osv: "ok" },
        used: { dependabot: false, code_scanning: true, secret_scanning: true, osv: true },
      }),
    ]);
    expect(
      await screen.findByText("Read code scanning, secret scanning, the OSV.dev lookup and workflow and dependency files."),
    ).toBeInTheDocument();
  });

  it("does not outline the past fix-by tile when none is past, and says so in words", async () => {
    show([securitySummary({ pastFix: 0 })]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    const tile = screen.getByRole("heading", { level: 3, name: copy.security.list.tiles.pastFix }).closest("article")!;
    expect(tile).not.toHaveClass("tile-danger");
    expect(tile).toHaveTextContent("No open alert has waited longer");
  });

  it("warns that a read failed without raising an alert, naming the repositories", async () => {
    show([
      securitySummary({ failed: true }),
      second,
      securitySummary({
        failed: true,
        repo: { id: 4, owner: "acme", name: "doodads", lastCrawledAt: null, crawlStatus: "idle" },
      }),
    ]);
    const warning = (await screen.findByText(copy.security.list.failedTitle)).closest("aside")!;
    expect(warning).toHaveClass("notice-warning");
    expect(warning).not.toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent("failed for acme/widgets and acme/doodads");
  });

  it("shows no failure notice when every read worked", async () => {
    show([securitySummary()]);
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    expect(screen.queryByText(copy.security.list.failedTitle)).not.toBeInTheDocument();
  });

  it("notes that the OSV lookup is off when the server says so", async () => {
    show([securitySummary()], { osv: false });
    expect(await screen.findByText(copy.security.list.osvOff)).toBeInTheDocument();
  });

  it("treats an answer that does not mention OSV as off", async () => {
    show([securitySummary()], {});
    expect(await screen.findByText(copy.security.list.osvOff)).toBeInTheDocument();
  });

  it("leaves out the OSV note when it is on", async () => {
    show([securitySummary()], { osv: true });
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2, name: copy.security.list.gradedTitle })).toBeInTheDocument(),
    );
    expect(screen.queryByText(copy.security.list.osvOff)).not.toBeInTheDocument();
  });

  it("leaves out the OSV note when the health answer fails", async () => {
    mockFetch({
      "GET /api/security": { body: [securitySummary()] },
      "GET /api/health": { status: 500, body: { error: "down" } },
      "GET /api/repos": { body: [] },
    });
    renderRoute(<SecurityListPage />, { path: "/security", route: "/security" });
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    expect(screen.queryByText(copy.security.list.osvOff)).not.toBeInTheDocument();
  });

  it("shows an error with a retry that reads the summaries again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockFetch({
      "GET /api/security": () =>
        ++attempts === 1 ? { status: 500, body: { error: "The summaries failed" } } : { body: [securitySummary()] },
      "GET /api/health": { body: { osv: true } },
      "GET /api/repos": { body: [] },
    });
    renderRoute(<SecurityListPage />, { path: "/security", route: "/security" });
    expect(await screen.findByText("The summaries failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ })).toBeInTheDocument();
  });

  it("invites adding a repository when there are none", async () => {
    show([]);
    expect(await screen.findByText(copy.security.list.emptyTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.security.list.toRepos })).toHaveAttribute("href", "/repos");
    expect(screen.queryByRole("button", { name: copy.report.download })).not.toBeInTheDocument();
  });

  it("offers a PDF named for the security summary of all repositories once there is something to print", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    show([securitySummary()]);
    expect(screen.queryByRole("button", { name: copy.report.download })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).not.toBe(""));
    expect(printedAs).toMatch(/^all-repositories-security-summary-\d{4}-\d{2}-\d{2}$/);
  });

  it("describes the page in plain words and asks for no login anywhere", async () => {
    show([securitySummary()]);
    expect(await screen.findByRole("heading", { level: 1, name: copy.security.list.title })).toBeInTheDocument();
    expect(screen.getByText(copy.security.list.lede)).toBeInTheDocument();
    expect(JSON.stringify(securitySummary())).not.toMatch(/login|"secret"|_by"/);
  });

  it("reads the summaries again when any crawl finishes", async () => {
    let calls = 0;
    let crawling = true;
    mockFetch({
      "GET /api/security": () => {
        calls += 1;
        return { body: [securitySummary()] };
      },
      "GET /api/health": { body: { osv: true } },
      "GET /api/repos": () => ({ body: [repo({ crawlStatus: crawling ? "crawling" : "idle" })] }),
    });
    const { client } = renderRoute(<SecurityListPage />, { path: "/security", route: "/security" });
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    await waitFor(() => expect(client.getQueryData(["repos"])).toBeDefined());
    expect(calls).toBe(1);
    crawling = false;
    await act(() => client.invalidateQueries({ queryKey: ["repos"] }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it("does not read the summaries again while a crawl is still running or when none ever started", async () => {
    let calls = 0;
    mockFetch({
      "GET /api/security": () => {
        calls += 1;
        return { body: [securitySummary()] };
      },
      "GET /api/health": { body: { osv: true } },
      "GET /api/repos": { body: [repo({ crawlStatus: "crawling" })] },
    });
    const { client } = renderRoute(<SecurityListPage />, { path: "/security", route: "/security" });
    await screen.findByRole("heading", { level: 3, name: /acme\/widgets/ });
    await waitFor(() => expect(client.getQueryData(["repos"])).toBeDefined());
    await act(() => client.invalidateQueries({ queryKey: ["repos"] }));
    expect(calls).toBe(1);
  });
});
