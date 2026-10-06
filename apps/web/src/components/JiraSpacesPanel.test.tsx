import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrackerSite, TrackerSpaceSummary } from "@dora-dashboard/core";
import { JiraSpacesPanel } from "./JiraSpacesPanel";
import { mockFetch, renderRoute, type MockResponse } from "../test/render";
import type { LinkedSpace } from "../api/hooks";
import { copy } from "../copy";

const site: TrackerSite = { id: "cloud-1", url: "https://acme.example.test", name: "Acme" };
const spaces: TrackerSpaceSummary[] = [
  { key: "WID", name: "Widgets", type: "software" },
  { key: "GAD", name: "Gadgets", type: "software" },
  { key: "OPS", name: "Operations", type: "business" },
];
const detail = {
  statuses: [
    { id: "1", name: "Backlog", category: "todo" },
    { id: "2", name: "Doing", category: "in_progress" },
    { id: "3", name: "Shipped", category: "done" },
  ],
  columns: [
    { name: "Ready", statusIds: ["1"] },
    { name: "Underway", statusIds: ["2"] },
    { name: "Finished", statusIds: ["3"] },
  ],
};

function linked(overrides: Partial<LinkedSpace> = {}): LinkedSpace {
  return {
    id: 7,
    siteId: "cloud-1",
    siteUrl: site.url,
    key: "WID",
    name: "Widgets",
    statuses: detail.statuses as LinkedSpace["statuses"],
    columns: detail.columns,
    lastCrawledAt: "2026-03-01T10:00:00Z",
    crawlStatus: "idle",
    crawlError: null,
    crawlProgress: null,
    workItemCount: 1234,
    ...overrides,
  };
}

const unauthorised: MockResponse = { status: 401, body: { error: "jira_unauthorised", message: "Connect Jira again" } };

function baseRoutes(extra: Record<string, MockResponse | ((url: URL, init?: RequestInit) => MockResponse)> = {}) {
  return {
    "GET /api/health": { body: { jira: true } },
    "GET /api/jira": { body: { enabled: true, connected: true, sites: [site] } },
    "GET /api/repos/1/spaces": { body: [] },
    "GET /api/jira/sites/cloud-1/spaces": { body: spaces },
    ...extra,
  };
}

const assign = vi.fn();
const original = window.location;

beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: original });
});

describe("JiraSpacesPanel", () => {
  it("renders nothing when the feature is off", async () => {
    const fetchMock = mockFetch({ "GET /api/health": { body: { jira: false } } });
    const { container } = renderRoute(<JiraSpacesPanel repoId={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the health check fails", async () => {
    mockFetch({ "GET /api/health": { status: 500, body: { error: "boom" } } });
    const { container } = renderRoute(<JiraSpacesPanel repoId={1} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("offers to connect and navigates to the start route with the current path", async () => {
    const user = userEvent.setup();
    mockFetch({ ...baseRoutes(), "GET /api/jira": { body: { enabled: true, connected: false, sites: [] } } });
    renderRoute(<JiraSpacesPanel repoId={1} />, { path: "/repos", route: "/repos?x=1" });
    expect(screen.queryByText(copy.jira.lede)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: copy.jira.connect }));
    expect(screen.getByText(copy.jira.lede)).toBeInTheDocument();
    expect(assign).toHaveBeenCalledWith("/api/auth/jira/start?returnTo=%2Frepos%3Fx%3D1");
  });

  it("shows a dismissible error when the sign-in came back with jira=error", async () => {
    const user = userEvent.setup();
    mockFetch({ ...baseRoutes(), "GET /api/jira": { body: { enabled: true, connected: false, sites: [] } } });
    renderRoute(<JiraSpacesPanel repoId={1} />, { path: "/repos", route: "/repos?jira=error" });
    expect(await screen.findByText(copy.jira.connectFailedTitle)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.jira.dismiss }));
    expect(screen.queryByText(copy.jira.connectFailedTitle)).not.toBeInTheDocument();
  });

  it("auto-selects a single site, filters spaces, preselects linked ones and saves the chosen keys", async () => {
    const user = userEvent.setup();
    let put: unknown;
    mockFetch(
      baseRoutes({
        "GET /api/repos/1/spaces": { body: [linked()] },
        "PUT /api/repos/1/spaces": (_url, init) => {
          put = JSON.parse(String(init?.body));
          return { status: 202, body: [linked(), linked({ id: 8, key: "GAD", name: "Gadgets" })] };
        },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);

    expect(await screen.findByLabelText(copy.jira.siteLabel)).toHaveValue("cloud-1");
    const widgets = await screen.findByRole("checkbox", { name: /Widgets/ });
    expect(widgets).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Gadgets/ })).not.toBeChecked();

    await user.type(screen.getByLabelText(copy.jira.searchLabel), "gad");
    expect(screen.queryByRole("checkbox", { name: /Operations/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 3 spaces/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Gadgets/ }));
    await user.clear(screen.getByLabelText(copy.jira.searchLabel));
    await user.type(screen.getByLabelText(copy.jira.searchLabel), "zzz");
    expect(screen.getByText(copy.jira.noMatches)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(copy.jira.searchLabel));

    await user.click(screen.getByRole("button", { name: copy.jira.saveLinks }));
    expect(await screen.findByText(copy.jira.linksSaved)).toBeInTheDocument();
    expect(put).toEqual({ siteId: "cloud-1", keys: ["WID", "GAD"] });
  });

  it("asks which site when there are several and shows linked space facts and crawl actions", async () => {
    const user = userEvent.setup();
    const crawls: string[] = [];
    mockFetch(
      baseRoutes({
        "GET /api/jira": {
          body: {
            enabled: true,
            connected: true,
            sites: [site, { id: "cloud-2", url: "https://other.example.test", name: "Other" }],
          },
        },
        "GET /api/repos/1/spaces": { body: [linked()] },
        "POST /api/spaces/7/crawl": (url) => {
          crawls.push(url.search);
          return { status: 202, body: {} };
        },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);

    const select = await screen.findByLabelText(copy.jira.siteLabel);
    await waitFor(() => expect(select).toHaveValue("cloud-1"));
    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText(site.url)).toBeInTheDocument();
    expect(screen.getByText(copy.jira.status.idle)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.jira.recrawlLabel("Widgets") }));
    await user.click(screen.getByRole("button", { name: copy.jira.fullRecrawlLabel("Widgets") }));
    await waitFor(() => expect(crawls).toEqual(["", "?full=1"]));
  });

  it("links a linked space's name to its delivery page", async () => {
    mockFetch(baseRoutes({ "GET /api/repos/1/spaces": { body: [linked()] } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByRole("link", { name: "Widgets" })).toHaveAttribute("href", "/spaces/7");
  });

  it("starts with a placeholder when several sites exist and none is linked", async () => {
    const user = userEvent.setup();
    mockFetch(
      baseRoutes({
        "GET /api/jira": {
          body: {
            enabled: true,
            connected: true,
            sites: [site, { id: "cloud-2", url: "https://other.example.test", name: "Other" }],
          },
        },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    const select = await screen.findByLabelText(copy.jira.siteLabel);
    expect(select).toHaveValue("");
    expect(await screen.findByText(copy.jira.noLinked)).toBeInTheDocument();
    await user.selectOptions(select, "cloud-1");
    expect(await screen.findByRole("checkbox", { name: /Widgets/ })).toBeInTheDocument();
  });

  it("shows crawl progress and a failed crawl's error", async () => {
    mockFetch(
      baseRoutes({
        "GET /api/repos/1/spaces": {
          body: [
            linked({ crawlStatus: "crawling", crawlProgress: "120 of 400 issues" }),
            linked({
              id: 8,
              key: "GAD",
              name: "Gadgets",
              crawlStatus: "failed",
              crawlError: "Rate limited",
              lastCrawledAt: null,
            }),
          ],
        },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByText("120 of 400 issues")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Rate limited");
    expect(screen.getByText(copy.jira.neverCrawled)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.jira.recrawlLabel("Widgets") })).toBeDisabled();
  });

  it("explains how a space flows, with text labels for each category", async () => {
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "GET /api/jira/sites/cloud-1/spaces/WID": { body: detail } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);

    await user.click(await screen.findByRole("checkbox", { name: /Widgets/ }));
    const toggle = screen.getByRole("button", { name: copy.jira.flowToggleLabel("Widgets") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const columns = await screen.findAllByRole("listitem");
    const names = columns.map((c) => c.textContent);
    expect(names.some((t) => t?.startsWith("Ready"))).toBe(true);
    expect(screen.getByText(copy.jira.categories.todo)).toBeInTheDocument();
    expect(screen.getByText(copy.jira.categories.in_progress)).toBeInTheDocument();
    const done = screen.getByText(copy.jira.categories.done).closest("div") as HTMLElement;
    expect(within(done).getByText("Shipped")).toBeInTheDocument();
  });

  it("says when a space has no board", async () => {
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "GET /api/jira/sites/cloud-1/spaces/WID": { body: { statuses: detail.statuses, columns: [] } } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("checkbox", { name: /Widgets/ }));
    await user.click(screen.getByRole("button", { name: copy.jira.flowToggleLabel("Widgets") }));
    expect(await screen.findByText(copy.jira.noBoard)).toBeInTheDocument();
  });

  it("says when a space has no statuses and reports a detail failure", async () => {
    const user = userEvent.setup();
    mockFetch(
      baseRoutes({
        "GET /api/jira/sites/cloud-1/spaces/WID": { body: { statuses: [], columns: [] } },
        "GET /api/jira/sites/cloud-1/spaces/GAD": { status: 502, body: { error: "Jira is down" } },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("checkbox", { name: /Widgets/ }));
    await user.click(screen.getByRole("checkbox", { name: /Gadgets/ }));
    await user.click(screen.getByRole("button", { name: copy.jira.flowToggleLabel("Widgets") }));
    expect(await screen.findByText(copy.jira.noStatuses)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.jira.flowToggleLabel("Gadgets") }));
    expect(await screen.findByText("Jira is down")).toBeInTheDocument();
  });

  it("shows Connect Jira again when the space list is unauthorised", async () => {
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "GET /api/jira/sites/cloud-1/spaces": unauthorised }));
    renderRoute(<JiraSpacesPanel repoId={1} />, { path: "/repos", route: "/repos" });
    expect(await screen.findByText(copy.jira.unauthorisedTitle)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.jira.connectAgain }));
    expect(assign).toHaveBeenCalledWith("/api/auth/jira/start?returnTo=%2Frepos");
  });

  it("shows Connect Jira again when the account lookup is unauthorised", async () => {
    mockFetch(baseRoutes({ "GET /api/jira": unauthorised }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByRole("button", { name: copy.jira.connectAgain })).toBeInTheDocument();
  });

  it("shows Connect Jira again when a re-crawl is unauthorised", async () => {
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "GET /api/repos/1/spaces": { body: [linked()] }, "POST /api/spaces/7/crawl": unauthorised }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: copy.jira.recrawlLabel("Widgets") }));
    expect(await screen.findAllByRole("button", { name: copy.jira.connectAgain })).not.toHaveLength(0);
  });

  it("shows a friendly notice, not an error, when the space is already being crawled", async () => {
    const user = userEvent.setup();
    mockFetch(
      baseRoutes({
        "GET /api/repos/1/spaces": { body: [linked()] },
        "POST /api/spaces/7/crawl": { status: 409, body: { error: "A crawl of this space is already running" } },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: copy.jira.recrawlLabel("Widgets") }));
    expect(await screen.findByText(copy.jira.crawlAlreadyRunning)).toBeInTheDocument();
    expect(screen.queryByText("A crawl of this space is already running")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows other failures plainly", async () => {
    mockFetch(baseRoutes({ "GET /api/jira": { status: 500, body: { error: "Jira lookup failed" } } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Jira lookup failed");
  });

  it("reports a failed save and a failed list of linked spaces", async () => {
    const user = userEvent.setup();
    mockFetch(
      baseRoutes({
        "GET /api/repos/1/spaces": { status: 500, body: { error: "Links unavailable" } },
        "PUT /api/repos/1/spaces": { status: 400, body: { error: "Too many spaces" } },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("checkbox", { name: /Widgets/ }));
    await user.click(screen.getByRole("button", { name: copy.jira.saveLinks }));
    expect(await screen.findByText("Too many spaces")).toBeInTheDocument();
    expect(screen.getByText("Links unavailable")).toBeInTheDocument();
  });

  it("explains an empty site and a site with no spaces", async () => {
    mockFetch(baseRoutes({ "GET /api/jira/sites/cloud-1/spaces": { body: [] } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByText(copy.jira.noSpaces)).toBeInTheDocument();
  });

  it("says when the account has no sites", async () => {
    mockFetch(baseRoutes({ "GET /api/jira": { body: { enabled: true, connected: true, sites: [] } } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    expect(await screen.findByText(copy.jira.noSites)).toBeInTheDocument();
  });

  it("stops offering more spaces at the limit", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      key: `AB${String.fromCharCode(65 + i)}`,
      name: `Space ${i}`,
      type: null,
    }));
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "GET /api/jira/sites/cloud-1/spaces": { body: many } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    for (let i = 0; i < 20; i += 1) await user.click(await screen.findByRole("checkbox", { name: new RegExp(`Space ${i} `) }));
    expect(screen.getByRole("checkbox", { name: /Space 20 / })).toBeDisabled();
    expect(screen.getByText(new RegExp(copy.jira.limitReached(20)))).toBeInTheDocument();
  });

  it("disconnects and then offers to connect again", async () => {
    const user = userEvent.setup();
    let connected = true;
    mockFetch(
      baseRoutes({
        "GET /api/jira": () => ({ body: { enabled: true, connected, sites: connected ? [site] : [] } }),
        "DELETE /api/jira": () => {
          connected = false;
          return { status: 204 };
        },
      }),
    );
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: copy.jira.disconnect }));
    expect(await screen.findByRole("button", { name: copy.jira.connect })).toBeInTheDocument();
  });

  it("reports a failed disconnect", async () => {
    const user = userEvent.setup();
    mockFetch(baseRoutes({ "DELETE /api/jira": { status: 500, body: { error: "Could not revoke" } } }));
    renderRoute(<JiraSpacesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: copy.jira.disconnect }));
    expect(await screen.findByText("Could not revoke")).toBeInTheDocument();
  });
});
