import type { SecurityReport } from "@dora-dashboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router";
import { SecurityPage } from "./SecurityPage";
import { mockFetch, renderRoute, type MockResponse } from "../test/render";
import { errorSource, noAccessSource, noSecurity, offSource, repo, securityAction, securityReport } from "../test/fixtures";
import { copy } from "../copy";

const show = (
  report: SecurityReport = securityReport(),
  route = "/repos/1/security",
  extra: Parameters<typeof mockFetch>[0] = {},
) => {
  const fetchMock = mockFetch({
    "GET /api/repos/1/security": { body: report },
    "GET /api/repos": { body: [repo()] },
    ...extra,
  });
  const view = renderRoute(<SecurityPage />, { path: "/repos/:id/security", route });
  return { fetchMock, ...view };
};

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("SecurityPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a loading state until the report arrives", async () => {
    show();
    expect(screen.getByRole("status")).toHaveTextContent(copy.security.page.loading);
    expect(await screen.findByRole("heading", { level: 2, name: copy.security.start.title })).toBeInTheDocument();
  });

  it("says nothing about approvals, reviews of merges or merged pull requests, which are a delivery matter and not a security one", async () => {
    show();
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(
      /approving review|approval|code owner|CODEOWNERS|merged pull request|reviewed by someone|another person/i,
    );
    expect(screen.queryByRole("heading", { name: /change control/i })).not.toBeInTheDocument();
  });

  it("runs its sections in order, from Start here to the glossary", async () => {
    show();
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    expect(headings()).toEqual([
      "Start here",
      "Security grade",
      "What to fix first",
      "Open alerts",
      "Open alerts by week",
      "What kind of problems",
      "Time to fix",
      "The worst open alerts",
      "Dependency upgrades",
      "Keeping dependencies up to date",
      "Workflows and supply chain",
      "Files that help",
      "Security tools in CI",
      "Container images",
      "Branch protection and settings",
      "Security issues",
      "OpenSSF Scorecard",
      "How each source is read",
      "What these words mean",
    ]);
  });

  it("puts the title, the repository, the dates, when alerts were read and the grade in the header", async () => {
    show();
    expect(await screen.findByRole("heading", { level: 1, name: copy.security.page.title })).toBeInTheDocument();
    expect(await screen.findByText("Showing 1 Jan 2026 to 1 Mar 2026 · Alerts read on 1 Mar 2026, 10:02")).toBeInTheDocument();
    expect(screen.getByText("acme/widgets", { selector: ".lede" })).toBeInTheDocument();
    const grade = screen.getByText(copy.security.page.gradeLine, { selector: ".grade-line span" }).closest("p")!;
    expect(grade).toHaveTextContent("Medium");
  });

  it("says when no alerts have been read and when there is no grade yet", async () => {
    show(noSecurity());
    expect(await screen.findByText(/Alerts have not been read yet/)).toBeInTheDocument();
    expect(screen.getByText(copy.security.page.gradeNone)).toBeInTheDocument();
  });

  it("shows the repository name from the list while the report loads", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    show(undefined, "/repos/1/security", {
      "GET /api/repos/1/security": async () => {
        await gate;
        return { body: securityReport() };
      },
    });
    expect(await screen.findByText("acme/widgets", { selector: ".lede" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.security.page.loading);
    release();
    expect(await screen.findByRole("heading", { level: 2, name: copy.security.start.title })).toBeInTheDocument();
  });

  it("prints as it shows: charts drawn in full, disclosures as left, long lists as collapsed, and no controls to press", async () => {
    const actions = Array.from({ length: 12 }, (_, i) => securityAction({ target: `npm:pkg-${i + 1}` }));
    const { container } = show(securityReport({ actions }));
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    const section = screen.getByRole("region", { name: copy.security.actions.title });
    act(() => void window.dispatchEvent(new Event("beforeprint")));
    const bars = [...container.querySelectorAll(".recharts-rectangle")];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((bar) => Number(bar.getAttribute("height")) > 0 && Number(bar.getAttribute("width")) > 0)).toBe(true);
    expect(container.querySelectorAll("details[open]")).toHaveLength(0);
    // The numbered actions, which are the items of the first list and not the steps inside one.
    const [list] = within(section).getAllByRole("list");
    expect(
      within(list!)
        .getAllByRole("listitem")
        .filter((item) => item.closest("ol, ul") === list),
    ).toHaveLength(10);
    expect(screen.getByText(copy.security.printMore(2))).toHaveClass("print-only");
    expect(screen.getByRole("link", { name: copy.security.start.seeAll })).toHaveClass("screen-only");
    act(() => void window.dispatchEvent(new Event("afterprint")));
  });

  it("offers a PDF named for the security report of the repository, with the date range controls and no bots switch", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    show();
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).not.toBe(""));
    expect(printedAs).toMatch(/^acme-widgets-security-report-\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByRole("group", { name: copy.range.legend })).toBeInTheDocument();
    expect(screen.queryByText(copy.range.includeBots)).not.toBeInTheDocument();
  });

  it("asks for the report with the range in the address, and again when the range changes", async () => {
    const user = userEvent.setup();
    const { fetchMock } = show(securityReport(), "/repos/1/security?from=2026-01-01&to=2026-02-01");
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    const urls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/security"));
    expect(urls()[0]).toContain("from=2026-01-01");
    expect(urls()[0]).toContain("to=2026-02-01");
    await user.click(screen.getByRole("button", { name: copy.range.allTime }));
    await waitFor(() => expect(urls().at(-1)).toBe("/api/repos/1/security"));
  });

  it("links back to the repository, keeping the range and nothing else", async () => {
    show(securityReport(), "/repos/1/security?from=2026-01-01&to=2026-02-01&source=osv");
    const back = await screen.findByRole("link", { name: copy.security.page.backToRepo });
    expect(back).toHaveAttribute("href", "/repos/1?from=2026-01-01&to=2026-02-01");
  });

  it("shows the grade, the actions and the alerts with no login anywhere", async () => {
    // A login placed where the page could pick one up, in the repository listing and beside an alert.
    const login = "octocat-9f3a";
    const base = securityReport();
    show({ ...base, openAlerts: base.openAlerts.map((alert) => ({ ...alert, dismissedBy: login })) }, "/repos/1/security", {
      "GET /api/repos": { body: [{ ...repo(), login, owner: { login } }] },
    });
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    await screen.findByText("src/db/query.ts line 42");
    expect(document.body.textContent).not.toContain(login);
    expect(screen.getByText(/^The lowest part is Known vulnerabilities and secrets/)).toBeInTheDocument();
    expect(
      screen.getAllByText("left-pad has 2 open critical alerts, and version 1.3.1 fixes them.", { selector: "p" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("src/db/query.ts line 42")).toBeInTheDocument();
  });

  it("filters the alerts table by the source named in the address", async () => {
    show(securityReport(), "/repos/1/security?source=code_scanning");
    const section = (await screen.findByRole("heading", { level: 2, name: copy.security.alerts.title })).closest("section")!;
    expect(within(section).getAllByRole("row")).toHaveLength(2);
    expect(within(section).getByText("Only alerts from Code scanning are listed here.")).toBeInTheDocument();
  });

  it("warns when part of the page could not be read, linking to how each source is read", async () => {
    const base = securityReport();
    show(securityReport({ sources: { ...base.sources, secret_scanning: noAccessSource("admin_only_or_off") } }));
    const notice = (await screen.findByText(copy.security.page.partlyRead.title)).closest("aside")!;
    expect(notice).toHaveClass("notice-warning");
    expect(notice).not.toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent("could not read secret scanning");
    expect(within(notice).getByRole("link", { name: copy.security.page.partlyRead.link })).toHaveAttribute(
      "href",
      "#security-sources",
    );
    expect(document.getElementById("security-sources")).not.toBeNull();
  });

  describe("a source whose last attempt failed", () => {
    // Dependabot has failed since 10 February, while code scanning and secret scanning read on 1 March.
    const stale = () => {
      const base = securityReport();
      return securityReport({
        sources: {
          ...base.sources,
          dependabot: errorSource("GitHub answered 502", { readAt: "2026-02-10T08:00:00Z", truncated: false, skipped: 0 }),
        },
      });
    };

    it("warns near the top, naming the source and when it last worked, and links to how each source is read", async () => {
      show(stale());
      const notice = (await screen.findByText(copy.security.failedSources.title)).closest("aside")!;
      expect(notice).toHaveClass("notice-warning");
      expect(notice).toHaveTextContent("Dependabot alerts, last read on 10 Feb 2026, 08:00");
      expect(within(notice).getByRole("link", { name: copy.security.failedSources.link })).toHaveAttribute(
        "href",
        "#security-sources",
      );
      // The grade still stands on the earlier alerts, so the page is not reduced to the part-read notice.
      expect(screen.queryByText(copy.security.page.partlyRead.title)).not.toBeInTheDocument();
    });

    it("does not claim a fresh read in the header, giving the oldest read the grade stands on", async () => {
      show(stale());
      expect(
        await screen.findByText(
          "Showing 1 Jan 2026 to 1 Mar 2026 · Some alerts are from an earlier read because a later one failed, and the oldest was read on 10 Feb 2026, 08:00",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Alerts read on/)).not.toBeInTheDocument();
    });

    it("names a source that has never read, and a failed branch read, with the stored messages in the sources panel", async () => {
      show(
        securityReport({
          sources: { ...securityReport().sources, secret_scanning: errorSource("GitHub answered 403") },
          postureFailure: { message: "GitHub answered 502", attemptedAt: "2026-03-02T10:00:00Z" },
        }),
      );
      const notice = (await screen.findByText(copy.security.failedSources.title)).closest("aside")!;
      // Secret scanning never read, so the unread notice names it and the failure notice does not say it twice.
      expect(notice).not.toHaveTextContent("secret scanning");
      expect(screen.getByText(copy.security.page.partlyRead.title).closest("aside")).toHaveTextContent("secret scanning");
      expect(notice).toHaveTextContent("Branch rules and settings, last read on 1 Mar 2026, 10:03");
      // The content is there from the first render, so it is not announced as a change.
      expect(notice).not.toHaveAttribute("role");
      expect(within(notice).getByRole("link", { name: copy.security.failedSources.link })).toHaveAttribute(
        "href",
        "#security-sources",
      );
      const panel = screen.getByRole("heading", { level: 2, name: copy.security.sources.title }).closest("section")!;
      expect(panel).toHaveTextContent('"GitHub answered 502"');
    });
  });

  it("shows the refusal notice alone, and not a failed sources warning as well, when every source failed or was refused", async () => {
    const never = noSecurity().sources;
    show(
      noSecurity({
        sources: {
          ...never,
          dependabot: errorSource("down"),
          code_scanning: noAccessSource(),
          secret_scanning: noAccessSource(),
        },
      }),
    );
    expect(await screen.findByText(copy.security.notRead.refused.title)).toBeInTheDocument();
    expect(screen.queryByText(copy.security.failedSources.title)).not.toBeInTheDocument();
  });

  it("does not warn about a failure when every source answered", async () => {
    show();
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    expect(screen.queryByText(copy.security.failedSources.title)).not.toBeInTheDocument();
  });

  it("says what happened, not that nothing has been read yet, when every source was refused", async () => {
    const refused = noSecurity().sources;
    show(
      noSecurity({
        sources: {
          dependabot: noAccessSource(),
          code_scanning: noAccessSource(),
          secret_scanning: noAccessSource(),
          osv: refused.osv,
        },
      }),
    );
    expect(await screen.findByText(copy.security.notRead.refused.title)).toBeInTheDocument();
    expect(screen.queryByText(copy.security.notRead.title)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.security.upgrades.none)).not.toBeInTheDocument();
  });

  it("does not warn when every source that matters was read", async () => {
    show();
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    expect(screen.queryByText(copy.security.page.partlyRead.title)).not.toBeInTheDocument();
  });

  it("says the week the range ends part way through is partial, above the weekly chart", async () => {
    show(securityReport({ range: { from: "2026-02-16T00:00:00Z", to: "2026-03-04T23:59:59Z" } }));
    expect(await screen.findByText(/^The range ends on 4 Mar, part way through the week starting 2 Mar/)).toBeInTheDocument();
  });

  it("says nothing about a part week when the range ends with a week", async () => {
    show(securityReport({ weekly: securityReport().weekly.map((w) => ({ ...w, partial: false })) }));
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    expect(screen.queryByText(/part way through the week/)).not.toBeInTheDocument();
  });

  it("says a crawl is in progress while one runs", async () => {
    mockFetch({
      "GET /api/repos/1/security": { body: securityReport() },
      "GET /api/repos": { body: [repo({ crawlStatus: "crawling" })] },
    });
    renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: "/repos/1/security" });
    expect(await screen.findByText(copy.security.page.crawlInProgress)).toBeInTheDocument();
  });

  it("scrolls to the sources panel when the address names it, as the link from the repository page does", async () => {
    const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      show(securityReport(), "/repos/1/security#security-sources");
      await screen.findByRole("heading", { level: 2, name: copy.security.sources.title });
      // The panel only exists once the report has loaded, so the scroll waits for it.
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll.mock.contexts[0]).toBe(document.getElementById("security-sources"));
    } finally {
      if (realScroll) Object.defineProperty(Element.prototype, "scrollIntoView", realScroll);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  describe("before the first crawl with security", () => {
    it("warns that the branch rules and settings failed to read, above the crawl prompt, and links to the sources", async () => {
      show(noSecurity({ postureFailure: { message: "GitHub answered 502", attemptedAt: "2026-03-02T10:00:00Z" } }));
      const notice = (await screen.findByText(copy.security.failedSources.title)).closest("aside")!;
      expect(notice).toHaveTextContent(copy.security.failedSources.never("Branch rules and settings"));
      expect(within(notice).getByRole("link", { name: copy.security.failedSources.link })).toHaveAttribute(
        "href",
        "#security-sources",
      );
      expect(screen.getByText(copy.security.notRead.title)).toBeInTheDocument();
    });

    it("leads with a notice and leaves out tables and charts of zeros", async () => {
      show(noSecurity());
      expect(await screen.findByText(copy.security.notRead.title)).toBeInTheDocument();
      expect(screen.getByText(copy.security.notRead.body)).toBeInTheDocument();
      expect(headings()).toEqual(["How each source is read", "What these words mean"]);
      expect(screen.queryByText(copy.security.upgrades.none)).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByText(copy.security.page.partlyRead.title)).not.toBeInTheDocument();
    });

    it("starts an incremental crawl from Crawl now, shows progress and reads the report again afterwards", async () => {
      const user = userEvent.setup();
      let posted = "";
      let crawling = false;
      let reads = 0;
      mockFetch({
        "GET /api/repos/1/security": () => {
          reads += 1;
          return { body: noSecurity() };
        },
        "GET /api/repos": () => ({ body: [repo({ crawlStatus: crawling ? "crawling" : "idle" })] }),
        "POST /api/repos/1/crawl": (url) => {
          posted = url.search || "(incremental)";
          crawling = true;
          return { status: 202, body: {} };
        },
      });
      const { client } = renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: "/repos/1/security" });
      await user.click(await screen.findByRole("button", { name: copy.security.notRead.crawl }));
      expect(posted).toBe("(incremental)");
      expect(await screen.findByRole("button", { name: copy.security.notRead.crawling })).toBeDisabled();
      expect(screen.getAllByRole("status").some((el) => el.textContent === copy.security.notRead.crawling)).toBe(true);
      const before = reads;
      crawling = false;
      await act(() => client.invalidateQueries({ queryKey: ["repos"] }));
      await waitFor(() => expect(reads).toBeGreaterThan(before));
    });

    it("says when the crawl could not be started", async () => {
      const user = userEvent.setup();
      mockFetch({
        "GET /api/repos/1/security": { body: noSecurity() },
        "GET /api/repos": { body: [repo()] },
        "POST /api/repos/1/crawl": { status: 500, body: { error: "no" } },
      });
      renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: "/repos/1/security" });
      await user.click(await screen.findByRole("button", { name: copy.security.notRead.crawl }));
      expect(await screen.findByText(copy.security.notRead.failed)).toBeInTheDocument();
    });

    it("disables the button while the repository is already crawling", async () => {
      mockFetch({
        "GET /api/repos/1/security": { body: noSecurity() },
        "GET /api/repos": { body: [repo({ crawlStatus: "crawling" })] },
      });
      renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: "/repos/1/security" });
      expect(await screen.findByRole("button", { name: copy.security.notRead.crawling })).toBeDisabled();
    });
  });

  describe("Dependabot version updates and alerts", () => {
    const off = (config: boolean) => {
      const base = securityReport();
      return securityReport({
        sources: { ...base.sources, dependabot: offSource("disabled") },
        dependabotVersionUpdates: config ? ".github/dependabot.yml" : null,
        actions: [
          securityAction({
            kind: "enable_dependabot",
            band: "medium",
            onPath: true,
            severity: null,
            target: null,
            refs: [],
          }),
        ],
      });
    };

    it("explains the difference in Start here, the action and the sources when the configuration file exists", async () => {
      show(off(true));
      const sentence =
        "Dependabot version updates are set up in .github/dependabot.yml and keep your packages current, but Dependabot alerts, which warn you when a package you use has a known vulnerability, are switched off.";
      expect((await screen.findAllByText(sentence, { exact: false })).length).toBeGreaterThanOrEqual(2);
      const sources = screen.getByRole("heading", { level: 3, name: "Dependabot alerts" }).closest("li")!;
      expect(sources).toHaveTextContent("Switch them on under the repository's Settings, then Advanced Security.");
      expect(within(sources).getByRole("link", { name: new RegExp(copy.security.settingsLink) })).toHaveAttribute(
        "href",
        "https://github.com/acme/widgets/settings/security_analysis",
      );
      expect(screen.getByText(copy.security.dependabotAlerts.why)).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: copy.security.snippets.dependabot })).not.toBeInTheDocument();
    });

    it("keeps the usual wording and offers the configuration file when there is none", async () => {
      show(off(false));
      await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
      expect(screen.queryByText(/Dependabot version updates are set up/)).not.toBeInTheDocument();
      expect(screen.getAllByText(copy.security.fix.enable_dependabot.what()).length).toBeGreaterThan(0);
      expect(screen.getByRole("group", { name: copy.security.snippets.dependabot })).toBeInTheDocument();
    });

    it("takes the file from the report's own field and not from the supply chain lines", async () => {
      // The update line says nothing is configured, yet the report names a file, and the report is what the page trusts.
      const report = off(true);
      show({
        ...report,
        supplyChain: {
          ...(report.supplyChain as Extract<typeof report.supplyChain, { status: "ok" }>),
          lines: [],
        },
      });
      expect(
        (await screen.findAllByText(/Dependabot version updates are set up in \.github\/dependabot\.yml/)).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("when no alert source has been read but other facts were", () => {
    const factsOnly = () => {
      const base = securityReport();
      const none = noSecurity();
      return {
        ...none,
        supplyChain: base.supplyChain,
        posture: base.posture,
        ecosystems: base.ecosystems,
      };
    };

    it("keeps the notice and the sources, and shows the workflow and branch facts that were read, but no alert sections", async () => {
      show(factsOnly());
      expect(await screen.findByText(copy.security.notRead.title)).toBeInTheDocument();
      expect(headings()).toEqual([
        "Workflows and supply chain",
        "Files that help",
        "Security tools in CI",
        "Container images",
        "Branch protection and settings",
        "How each source is read",
        "What these words mean",
      ]);
      expect(screen.queryByText(copy.security.upgrades.none)).not.toBeInTheDocument();
    });

    it("shows only the workflow facts when the branch settings were not read, and only the branch facts when the files were not", async () => {
      const { unmount } = show({ ...factsOnly(), posture: null });
      await screen.findByText(copy.security.notRead.title);
      expect(headings()).not.toContain("Branch protection and settings");
      expect(headings()).toContain("Workflows and supply chain");
      unmount();
      show({ ...factsOnly(), supplyChain: { status: "none", reason: "not_read" } });
      await screen.findByText(copy.security.notRead.title);
      expect(headings()).toContain("Branch protection and settings");
      expect(headings()).not.toContain("Workflows and supply chain");
    });
  });

  it("says the repository could not be found for an unknown one, and links to the list", async () => {
    show(undefined, "/repos/1/security", { "GET /api/repos/1/security": { status: 404, body: { error: "Unknown repository" } } });
    expect(await screen.findByText(copy.security.page.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.security.page.toList })).toHaveAttribute("href", "/security");
    expect(screen.queryByRole("button", { name: copy.common.retry })).not.toBeInTheDocument();
  });

  it("shows an error with a retry for any other failure", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    show(undefined, "/repos/1/security", {
      "GET /api/repos/1/security": () =>
        ++attempts === 1 ? { status: 500, body: { error: "Alerts are unavailable" } } : { body: securityReport() },
    });
    expect(await screen.findByText("Alerts are unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByRole("heading", { level: 2, name: copy.security.start.title })).toBeInTheDocument();
  });

  it("answers an address that does not name a repository without asking the API", () => {
    const fetchMock = mockFetch({});
    for (const address of ["abc", "0", "1.5", "-3"]) {
      const { unmount } = renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: `/repos/${address}/security` });
      expect(screen.getByText(copy.security.page.invalidAddress)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.security.page.toList })).toHaveAttribute("href", "/security");
      unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never shows another repository's report under the next repository's address while that one loads", async () => {
    const user = userEvent.setup();
    let release: (response: MockResponse) => void = () => undefined;
    const gadgets = securityReport({
      repo: { id: 2, owner: "acme", name: "gadgets", deployBranch: "main", lastCrawledAt: "2026-03-01T10:00:00Z" },
    });
    mockFetch({
      "GET /api/repos": { body: [repo({ id: 1 }), repo({ id: 2, name: "gadgets" })] },
      "GET /api/repos/1/security": { body: securityReport() },
      "GET /api/repos/2/security": () => new Promise<MockResponse>((resolve) => (release = resolve)),
    });
    renderRoute(
      <>
        <SecurityPage />
        <Link to="/repos/2/security">Next repository</Link>
      </>,
      { path: "/repos/:id/security", route: "/repos/1/security" },
    );
    expect(await screen.findByRole("heading", { level: 2, name: copy.security.start.title })).toBeInTheDocument();
    expect(screen.getByText("acme/widgets", { selector: ".lede" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Next repository" }));

    expect(await screen.findByRole("status")).toHaveTextContent(copy.security.page.loading);
    expect(screen.queryByRole("heading", { level: 2, name: copy.security.start.title })).not.toBeInTheDocument();
    release({ body: gadgets });
    expect(await screen.findByRole("heading", { level: 2, name: copy.security.start.title })).toBeInTheDocument();
    expect(screen.getByText("acme/gadgets", { selector: ".lede" })).toBeInTheDocument();
  });

  it("reads the report again when a crawl of the repository finishes", async () => {
    let calls = 0;
    let crawling = true;
    mockFetch({
      "GET /api/repos/1/security": () => {
        calls += 1;
        return { body: securityReport() };
      },
      "GET /api/repos": () => ({ body: [repo({ crawlStatus: crawling ? "crawling" : "idle" })] }),
    });
    const { client } = renderRoute(<SecurityPage />, { path: "/repos/:id/security", route: "/repos/1/security" });
    await screen.findByRole("heading", { level: 2, name: copy.security.start.title });
    await waitFor(() => expect(client.getQueryData(["repos"])).toBeDefined());
    expect(calls).toBe(1);
    crawling = false;
    await act(() => client.invalidateQueries({ queryKey: ["repos"] }));
    await waitFor(() => expect(calls).toBe(2));
  });
});
