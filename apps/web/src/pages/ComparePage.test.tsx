import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparePage } from "./ComparePage";
import { mockFetch, renderRoute } from "../test/render";
import { report } from "../test/fixtures";
import { copy } from "../copy";

const reports = [
  report({ id: 1, name: "widgets", authorCount: 2 }),
  report({ id: 2, name: "gadgets", authorCount: 5, projectStart: "2026-01-12T09:00:00Z" }),
];

function renderCompare(route = "/compare?ids=1,2") {
  const fetchMock = mockFetch({ "GET /api/compare": { body: reports } });
  const utils = renderRoute(<ComparePage />, { path: "/compare", route });
  return { ...utils, fetchMock };
}

describe("ComparePage", () => {
  it("offers a PDF report named after every compared repository", async () => {
    const user = userEvent.setup();
    let printedAs = "";
    vi.spyOn(window, "print").mockImplementation(() => {
      printedAs = document.title;
    });
    renderCompare();
    await user.click(await screen.findByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(printedAs).not.toBe(""));
    expect(printedAs).toMatch(/^acme-widgets-vs-acme-gadgets-delivery-report-\d{4}-\d{2}-\d{2}$/);
  });

  it("renders one headline column per repository with DORA band labels", async () => {
    const { fetchMock } = renderCompare();
    const table = await screen.findByRole("table", { name: copy.compare.headline.title });
    expect(within(table).getByRole("columnheader", { name: "acme/widgets" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "acme/gadgets" })).toBeInTheDocument();
    expect(within(table).getAllByText("Low").length).toBe(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("ids=1%2C2");
  });

  it("links each repository's column to the DORA section of its own page, carrying the range", async () => {
    renderCompare("/compare?ids=1,2&from=2026-01-05&to=2026-01-25&bots=1");
    const table = await screen.findByRole("table", { name: copy.compare.headline.title });
    const row = within(table).getByRole("row", { name: new RegExp(copy.dora.explain.whyBandRow) });
    const links = within(row).getAllByRole("link", { name: /Why this band/ });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAccessibleName(copy.dora.explain.whyBandLabel("acme/widgets"));
    expect(links[0]).toHaveAttribute("href", "/repos/1?from=2026-01-05&to=2026-01-25&bots=1#dora-title");
    expect(links[1]).toHaveAttribute("href", "/repos/2?from=2026-01-05&to=2026-01-25&bots=1#dora-title");
  });

  it("does not repeat the explanations on the comparison", async () => {
    renderCompare();
    await screen.findByRole("table", { name: copy.compare.headline.title });
    expect(screen.queryByText(copy.dora.explain.summary)).not.toBeInTheDocument();
  });

  it("states the profile once above the headline when every repository shares it", async () => {
    renderCompare();
    const link = await screen.findByRole("link", { name: /DORA 2023/ });
    expect(link).toHaveAttribute("href", report().dora.profile.source.url);
    expect(screen.getAllByRole("link", { name: /DORA 2023/ })).toHaveLength(1);
    expect(screen.queryByText(copy.dora.profileMismatch)).not.toBeInTheDocument();
  });

  it("warns when the repositories were graded against different profiles", async () => {
    const other = report({ id: 2, name: "gadgets" });
    other.dora = { ...other.dora, profile: { ...other.dora.profile, id: "other", name: "Other" } };
    mockFetch({ "GET /api/compare": { body: [reports[0], other] } });
    renderRoute(<ComparePage />, { path: "/compare", route: "/compare?ids=1,2" });
    expect(await screen.findByText(copy.dora.profileMismatch)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /DORA 2023/ })).not.toBeInTheDocument();
  });

  it("keeps Show people off by default and reveals the authors tables when switched on", async () => {
    const user = userEvent.setup();
    renderCompare();
    await screen.findByRole("table", { name: copy.compare.headline.title });
    const toggle = screen.getByRole("switch", { name: copy.compare.showPeople });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("columnheader", { name: copy.authors.reviewsGiven })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("heading", { name: copy.compare.people.title })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: copy.authors.reviewsGiven })).toHaveLength(2);
    expect(screen.getAllByText("ada").length).toBeGreaterThan(0);
  });

  it("switches the axis to weeks since first PR when aligned and says the view is clipped", async () => {
    const user = userEvent.setup();
    renderCompare();
    await screen.findByRole("table", { name: copy.compare.headline.title });
    expect(screen.getAllByText(copy.charts.weekStarting).length).toBeGreaterThan(0);
    expect(screen.queryByText(copy.compare.alignedAxis)).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: copy.compare.align }));
    expect(screen.getAllByText(copy.compare.alignedAxis).length).toBeGreaterThan(0);
    expect(screen.queryByText(copy.charts.weekStarting)).not.toBeInTheDocument();
    expect(screen.getByText(copy.compare.clippedNote(3))).toBeInTheDocument();
  });

  it("always shows the batch size caveat and the Reading this fairly panel", async () => {
    renderCompare();
    expect(await screen.findByText(copy.compare.batch.caveat)).toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: copy.compare.fair.title });
    expect(within(panel).getByText(copy.compare.fair.authorsOf("acme/widgets", 2))).toBeInTheDocument();
    expect(within(panel).getByText(copy.compare.fair.authorsOf("acme/gadgets", 5))).toBeInTheDocument();
    expect(within(panel).getByText(copy.compare.fair.overlap)).toBeInTheDocument();
  });

  it("retitles throughput per contributor and offers the period all were active first", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderCompare();
    await screen.findByRole("table", { name: copy.compare.headline.title });
    await user.click(screen.getByRole("switch", { name: copy.compare.perContributor }));
    expect(screen.getByRole("heading", { name: copy.compare.throughput.titlePerContributor })).toBeInTheDocument();

    const presets = within(screen.getByRole("group", { name: copy.range.presetsLabel })).getAllByRole("button");
    expect(presets[0]).toHaveTextContent(copy.range.allActive);
    await user.click(presets[0]!);
    expect(presets[0]).toHaveAttribute("aria-pressed", "true");
    const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(lastUrl).toContain("from=2026-01-12");

    await user.click(screen.getByRole("switch", { name: copy.compare.logScale }));
    expect(screen.getByText(copy.compare.openToMerge.logNote)).toBeInTheDocument();
  });

  it("asks for at least two repositories", () => {
    mockFetch({});
    renderRoute(<ComparePage />, { path: "/compare", route: "/compare?ids=1" });
    expect(screen.getByText(copy.compare.needTwo)).toBeInTheDocument();
  });

  it("shows the API error message", async () => {
    mockFetch({ "GET /api/compare": { status: 500, body: { error: "Database is locked" } } });
    renderRoute(<ComparePage />, { path: "/compare", route: "/compare?ids=1,2" });
    expect(await screen.findByText("Database is locked")).toBeInTheDocument();
  });

  it("says when a requested repository is missing", async () => {
    mockFetch({ "GET /api/compare": { body: reports } });
    renderRoute(<ComparePage />, { path: "/compare", route: "/compare?ids=1,2,9" });
    expect(await screen.findByText(copy.compare.missing(1))).toBeInTheDocument();
  });
});
