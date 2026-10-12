import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copy } from "../copy";
import { securityAlert, securityReport } from "../test/fixtures";
import { renderRoute } from "../test/render";
import { AlertsTable } from "./AlertsTable";
import { DependencyTable } from "./DependencyTable";
import { OpenAlertsChart } from "./OpenAlertsChart";
import { OpenAlertTiles, TimeToFix } from "./SecurityTiles";
import { WeaknessesChart } from "./WeaknessesChart";

const card = (title: string) => screen.getByRole("region", { name: title });

async function tableOf(title: string) {
  const user = userEvent.setup();
  const chart = card(title);
  await user.click(within(chart).getByText(copy.common.viewAsTable));
  return within(chart).getByRole("table");
}

const rowsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));

/**
 * Each drawn bar's size. Recharts grows a bar from nothing when it mounts unless told not to, and printing re-mounts the
 * chart at the page's width, so a bar still growing at that moment is captured empty in the PDF.
 */
const bars = (chart: HTMLElement) =>
  [...chart.querySelectorAll(".recharts-rectangle")].map((bar) => ({
    width: Number(bar.getAttribute("width")),
    height: Number(bar.getAttribute("height")),
  }));

describe("OpenAlertsChart", () => {
  const { weekly } = securityReport();

  it("tables each week's open alerts by severity with a total, marking the part week", async () => {
    render(<OpenAlertsChart weekly={weekly} part={{ week: "2026-03-02", through: "2026-03-04", current: true }} />);
    const table = await tableOf(copy.security.weekly.chartTitle);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Week starting", "Critical", "High", "Medium", "Low", "Total"]);
    expect(rowsOf(table)).toEqual([
      ["16 Feb", "0", "1", "1", "0", "2"],
      ["23 Feb", "1", "2", "2", "1", "6"],
      ["2 Mar, so far", "1", "2", "2", "1", "6"],
    ]);
  });

  it("has a title, a subtitle saying what it measures, and a legend for its severities and the part week", () => {
    render(<OpenAlertsChart weekly={weekly} part={{ week: "2026-03-02", through: "2026-03-04", current: true }} />);
    const chart = card(copy.security.weekly.chartTitle);
    expect(within(chart).getByText(copy.security.weekly.subtitle)).toBeInTheDocument();
    const legend = within(chart)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(legend).toEqual(["Critical", "High", "Medium", "Low", "Week starting 2 Mar, so far"]);
  });

  it("draws its bars at full height straight after the page begins printing, not growing up from nothing", () => {
    render(<OpenAlertsChart weekly={weekly} part={null} />);
    act(() => void window.dispatchEvent(new Event("beforeprint")));
    const drawn = bars(card(copy.security.weekly.chartTitle));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every(({ height }) => height > 0)).toBe(true);
  });

  it("colours each legend swatch on the stage ramp, never on a band", () => {
    const { container } = render(<OpenAlertsChart weekly={weekly} part={null} />);
    const colours = [...container.querySelectorAll<HTMLElement>(".series-legend .legend-swatch")].map((s) => s.style.background);
    expect(colours).toEqual(["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)"]);
  });

  it("says there is no data when no week had an open alert", () => {
    render(<OpenAlertsChart weekly={[]} part={null} />);
    expect(within(card(copy.security.weekly.chartTitle)).getByText(copy.charts.noData)).toBeInTheDocument();
  });
});

describe("WeaknessesChart", () => {
  it("names each kind of problem in plain words beside its id, its counts and its meaning", async () => {
    render(<WeaknessesChart weaknesses={securityReport().weaknesses} />);
    const table = await tableOf(copy.security.weaknesses.chartTitle);
    expect(rowsOf(table)).toEqual([
      ["Prototype pollution", "CWE-1321", "2", "1", copy.security.cwe["CWE-1321"].meaning],
      ["Cross-site scripting", "CWE-79", "1", "0", copy.security.cwe["CWE-79"].meaning],
      ["CWE-9999", "CWE-9999", "1", "2", copy.security.weaknesses.unnamed],
    ]);
  });

  it("has a legend naming open and fixed", () => {
    render(<WeaknessesChart weaknesses={securityReport().weaknesses} />);
    expect(
      within(card(copy.security.weaknesses.chartTitle))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Open", "Fixed in range"]);
  });

  it("draws its bars in full straight after the page begins printing, not growing up from nothing", () => {
    render(<WeaknessesChart weaknesses={securityReport().weaknesses} />);
    act(() => void window.dispatchEvent(new Event("beforeprint")));
    const drawn = bars(card(copy.security.weaknesses.chartTitle));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
  });

  it("says there is no data without a weakness", () => {
    render(<WeaknessesChart weaknesses={[]} />);
    expect(within(card(copy.security.weaknesses.chartTitle)).getByText(copy.charts.noData)).toBeInTheDocument();
  });
});

describe("OpenAlertTiles", () => {
  const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;

  it("says Critical alerts and High severity alerts, never a bare High, with the plain explanation beside each", () => {
    render(<OpenAlertTiles report={securityReport()} />);
    expect(screen.queryByText("High", { selector: "h3" })).not.toBeInTheDocument();
    expect(tile("Critical alerts")).toHaveTextContent("1");
    expect(tile("Critical alerts")).toHaveTextContent(
      "Critical means someone could take over the system or read private data with little effort. Fix within 7 days.",
    );
    expect(tile("High severity alerts")).toHaveTextContent("2");
    expect(tile("Medium severity alerts")).toHaveTextContent("Fix within 90 days.");
    expect(tile("Low severity alerts")).toHaveTextContent("Fix within 180 days.");
  });

  it("outlines a severity with alerts past their fix-by date and says so in words", () => {
    render(<OpenAlertTiles report={securityReport()} />);
    expect(tile("High severity alerts")).toHaveClass("tile-danger");
    expect(tile("High severity alerts")).toHaveTextContent("1 past the fix-by date");
    expect(tile("Critical alerts")).not.toHaveClass("tile-danger");
    expect(tile("Critical alerts")).toHaveTextContent("None past the fix-by date");
  });

  it("shows the alerts without a rating only when there are some", () => {
    const base = securityReport();
    const { rerender } = render(<OpenAlertTiles report={base} />);
    expect(screen.queryByRole("heading", { name: "Alerts without a rating" })).not.toBeInTheDocument();
    rerender(
      <OpenAlertTiles
        report={securityReport({
          open: {
            ...base.open,
            bySeverity: { ...base.open.bySeverity, unknown: 2 },
            pastFix: { ...base.open.pastFix, unknown: 1 },
          },
        })}
      />,
    );
    expect(tile("Alerts without a rating")).toHaveTextContent("2");
    expect(tile("Alerts without a rating")).toHaveTextContent("treated like medium");
  });

  it("explains the likely to be exploited soon tag and counts it", () => {
    render(<OpenAlertTiles report={securityReport()} />);
    expect(tile(copy.security.open.likelyTitle)).toHaveTextContent("1");
    expect(tile(copy.security.open.likelyTitle)).toHaveTextContent("exploit prediction score is 10% or more");
    expect(screen.getByText(copy.security.likelyExploitedWhy("10%"))).toBeInTheDocument();
  });

  it("writes the exploit prediction share from the report's threshold, so a change shows in the words", () => {
    const base = securityReport();
    render(<OpenAlertTiles report={{ ...base, thresholds: { ...base.thresholds, likelyExploitedEpss: 0.25 } }} />);
    expect(tile(copy.security.open.likelyTitle)).toHaveTextContent("exploit prediction score is 25% or more");
    expect(screen.getByText(/At 25% or more we say it is likely to be exploited soon/)).toBeInTheDocument();
    expect(screen.queryByText(/10%/)).not.toBeInTheDocument();
  });

  it("totals the open alerts and splits them by source", () => {
    render(<OpenAlertTiles report={securityReport()} />);
    expect(screen.getByText("6 open in all, made up of 4 from Dependabot alerts and 2 from Code scanning.")).toBeInTheDocument();
  });

  it("congratulates when nothing is open, and says some sources could not be read when that is so", () => {
    const empty = securityReport({
      openAlertTotal: 0,
      open: {
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        bySource: { dependabot: 0, code_scanning: 0, secret_scanning: 0, osv: 0 },
        pastFix: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      },
    });
    const { rerender } = render(<OpenAlertTiles report={empty} />);
    expect(screen.getByText(copy.security.open.none)).toBeInTheDocument();
    rerender(<OpenAlertTiles report={{ ...empty, supplyChain: { status: "none", reason: "not_read" } }} />);
    expect(screen.getByText(copy.security.open.noneButUnread)).toBeInTheDocument();
  });
});

describe("TimeToFix", () => {
  it("shows how many were fixed, the typical time, the slowest quarter and the dismissals with their reasons", () => {
    render(<TimeToFix report={securityReport()} />);
    const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;
    expect(tile(copy.security.fixTime.fixed)).toHaveTextContent("4");
    // The median is 48 hours, which the one formatter writes as 2.0 days, and the slowest quarter is 96 hours, 4.0 days.
    expect(tile(copy.security.fixTime.median)).toHaveTextContent("2.0 days");
    expect(tile(copy.security.fixTime.median)).toHaveTextContent("three quarters within 4.0 days");
    expect(tile(copy.security.fixTime.slowest)).toHaveTextContent("4.0 days");
    expect(tile(copy.security.fixTime.dismissed)).toHaveTextContent("3");
    expect(tile(copy.security.fixTime.dismissed)).toHaveTextContent("Closed without a fix, 2 risk accepted and 1 a false alarm.");
  });

  it("tables every severity with the days it is allowed beside what was achieved, always visible", () => {
    render(<TimeToFix report={securityReport()} />);
    const table = screen.getByRole("table", { name: copy.security.fixTime.bySeverity.title });
    expect(rowsOf(table)).toEqual([
      // 24 hours is under 48, so the one formatter writes it in hours.
      ["Critical", "4", "24.0 h", "2.0 days", "7 days"],
      ["High", "4", "4.0 days", "8.0 days", "30 days"],
      ["Medium", "0", "No data", "No data", "90 days"],
      ["Low", "0", "No data", "No data", "180 days"],
      ["Not rated", "0", "No data", "No data", "90 days"],
    ]);
  });

  it("says so when nothing was fixed or dismissed, and when push protection was bypassed", () => {
    const base = securityReport();
    const { rerender } = render(
      <TimeToFix
        report={securityReport({
          fixedInRange: 0,
          timeToFix: { count: 0, median: null, p75: null, mean: null },
          dismissed: { total: 0, byReason: [] },
        })}
      />,
    );
    expect(screen.getByText(copy.security.fixTime.medianHint("No data", 0))).toBeInTheDocument();
    expect(screen.getByText(copy.security.fixTime.dismissedNone)).toBeInTheDocument();
    expect(screen.queryByText(/bypass push protection/)).not.toBeInTheDocument();
    rerender(<TimeToFix report={{ ...base, pushProtectionBypassedInRange: 2 }} />);
    expect(
      screen.getByText("2 secrets were pushed in this range after the person pushing chose to bypass push protection."),
    ).toBeInTheDocument();
    rerender(<TimeToFix report={{ ...base, pushProtectionBypassedInRange: 1 }} />);
    expect(screen.getByText(/^1 secret was pushed/)).toBeInTheDocument();
  });
});

describe("AlertsTable", () => {
  const route = (search = "") => `/repos/1/security${search}`;
  const show = (report = securityReport(), search = "") =>
    renderRoute(<AlertsTable report={report} />, { path: "/repos/:id/security", route: route(search) });
  const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("lists the open alerts worst first as the API gave them, with where, source, age and the fix-by words", () => {
    show();
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(within(first).getByRole("rowheader")).toHaveTextContent("Critical");
    expect(within(first).getByRole("link", { name: /Prototype pollution in left-pad/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/security/dependabot/1",
    );
    expect(first).toHaveTextContent("left-pad 1.3.0 in package-lock.json");
    expect(first).toHaveTextContent("Dependabot alerts");
    // 240 hours is ten days, which the one formatter writes as 10.0 days.
    expect(first).toHaveTextContent("10.0 days");
    expect(first).toHaveTextContent(copy.security.tags.pastFix);
    expect(rows[1]).toHaveTextContent("src/db/query.ts line 42");
    expect(rows[1]).toHaveTextContent("3.0 days");
    expect(rows[1]).toHaveTextContent(copy.security.tags.withinFix);
  });

  it("tags an alert likely to be exploited soon, with its score out of 10 and the plain name of its weakness", () => {
    show();
    const first = bodyRows()[0]!;
    expect(within(first).getByText(copy.security.tags.likelyExploited)).toBeInTheDocument();
    expect(within(first).getByText("Score 9.8 out of 10")).toBeInTheDocument();
    expect(within(first).getByText("Prototype pollution")).toBeInTheDocument();
    const second = bodyRows()[1]!;
    expect(within(second).queryByText(copy.security.tags.likelyExploited)).not.toBeInTheDocument();
    expect(within(second).queryByText(/Score/)).not.toBeInTheDocument();
    expect(within(second).getByText("SQL injection")).toBeInTheDocument();
  });

  it("says where an alert is without a package name or manifest, never printing null", () => {
    const where = { kind: "package" as const, ecosystem: null, name: null, version: null, manifestPath: null };
    show(securityReport({ openAlerts: [securityAlert({ where })] }));
    expect(within(bodyRows()[0]!).getByText("A package GitHub did not name")).toBeInTheDocument();
    expect(bodyRows()[0]).not.toHaveTextContent("null");
  });

  it("shows a title as plain text when its link is not a web address", () => {
    show(securityReport({ openAlerts: [securityAlert({ url: "javascript:alert(1)", title: "Trap" })] }));
    expect(screen.getByText("Trap")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Trap/ })).not.toBeInTheDocument();
  });

  it("filters by source from the select and keeps the choice in the address", async () => {
    const user = userEvent.setup();
    show();
    const select = screen.getByLabelText(copy.security.alerts.filterLabel);
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Every source", "Dependabot alerts (4)", "Code scanning (2)", "Secret scanning (0)", "OSV.dev lookup (0)"]);
    await user.selectOptions(select, "code_scanning");
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent("Database query built from user-provided value");
    expect(select).toHaveValue("code_scanning");
    await user.selectOptions(select, "");
    expect(bodyRows()).toHaveLength(2);
  });

  it("opens filtered when the address names a source, and says so for the printed copy only", () => {
    show(securityReport(), "?source=code_scanning");
    expect(bodyRows()).toHaveLength(1);
    const note = screen.getByText("Only alerts from Code scanning are listed here.");
    expect(note).toHaveClass("print-only");
    expect(screen.getByLabelText(copy.security.alerts.filterLabel).closest("div")).toHaveClass("screen-only");
  });

  it("shows every alert for a source the address got wrong, with no printed note", () => {
    show(securityReport(), "?source=nonsense");
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText(/are listed here/)).not.toBeInTheDocument();
  });

  it("says no alerts match when the chosen source has none", () => {
    show(securityReport(), "?source=osv");
    expect(screen.getByText(copy.security.alerts.none)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says the chosen source is not among the worst alerts, rather than that it has none, when the list is cut", () => {
    const base = securityReport();
    show(
      securityReport({ openAlertTotal: 140, open: { ...base.open, bySource: { ...base.open.bySource, secret_scanning: 12 } } }),
      "?source=secret_scanning",
    );
    expect(screen.getByRole("option", { name: "Secret scanning (12)" })).toBeInTheDocument();
    expect(screen.getByText("Showing the 2 worst of 140 open alerts.")).toBeInTheDocument();
    expect(screen.getByText(copy.security.alerts.noneInWorst("Secret scanning", 2))).toBeInTheDocument();
    expect(screen.queryByText(copy.security.alerts.none)).not.toBeInTheDocument();
  });

  it("notes when the list is cut to the worst alerts", () => {
    show(securityReport({ openAlertTotal: 140 }));
    expect(screen.getByText("Showing the 2 worst of 140 open alerts.")).toBeInTheDocument();
  });

  it("shows ten rows and offers the rest behind a button", async () => {
    const user = userEvent.setup();
    const alerts = Array.from({ length: 12 }, (_, i) => securityAlert({ key: String(i), title: `Alert ${i}` }));
    show(securityReport({ openAlerts: alerts, openAlertTotal: 12 }));
    expect(bodyRows()).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: copy.space.showAll(12) }));
    expect(bodyRows()).toHaveLength(12);
  });
});

describe("DependencyTable", () => {
  const { dependencyGroups } = securityReport();

  it("lists each package with where it is found, its alerts, worst severity, the fix and the upgrade command", () => {
    render(<DependencyTable groups={dependencyGroups} />);
    const [first, second] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(first!).getByRole("rowheader")).toHaveTextContent("left-pad");
    expect(within(first!).getByRole("rowheader")).toHaveTextContent("npm");
    expect(within(first!).getByRole("rowheader")).toHaveTextContent(copy.security.tags.likelyExploited);
    expect(within(first!).getByRole("rowheader")).toHaveTextContent(copy.security.upgrades.relationship.direct);
    expect(first).toHaveTextContent("package-lock.json");
    expect(first).toHaveTextContent("Locked at 1.3.0");
    expect(first).toHaveTextContent("Critical");
    expect(within(first!).getByText("1.3.1")).toBeInTheDocument();
    expect(within(first!).getByText("npm install left-pad@1.3.1").tagName).toBe("CODE");
    expect(first).toHaveTextContent("None");
    expect(second).toHaveTextContent("is-odd");
    expect(second).toHaveTextContent(copy.security.upgrades.noFix);
    expect(second).toHaveTextContent(copy.security.upgrades.nothingToInstall);
    expect(second).not.toHaveTextContent(copy.security.upgrades.noCommand);
    expect(second).toHaveTextContent("1 past");
  });

  it("asks for a version to be chosen when the alerts name several fixes, and says no command is known only for an unknown package manager", () => {
    const [root] = dependencyGroups;
    render(
      <DependencyTable
        groups={[
          { ...root!, name: "several", upgradeTo: null, patchedVersions: ["1.2.5", "2.0.1"] },
          { ...root!, name: "mystery", ecosystem: "swift", manifestPath: "Package.resolved", upgradeTo: "3.0.0" },
        ]}
      />,
    );
    const [several, mystery] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(several).toHaveTextContent(copy.security.upgrades.chooseVersion);
    expect(mystery).toHaveTextContent(copy.security.upgrades.noCommand);
  });

  it("shows one row for each manifest, with the command run in that manifest's folder", () => {
    const [root] = dependencyGroups;
    render(
      <DependencyTable
        groups={[root!, { ...root!, manifestPath: "apps/web/package-lock.json", lockedVersions: ["1.2.0", "1.3.0"] }]}
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("npm install left-pad@1.3.1");
    expect(rows[0]).not.toHaveTextContent("cd ");
    expect(rows[1]).toHaveTextContent("apps/web/package-lock.json");
    expect(rows[1]).toHaveTextContent("Locked at 1.2.0 and 1.3.0");
    expect(within(rows[1]!).getByText("cd apps/web && npm install left-pad@1.3.1").tagName).toBe("CODE");
  });

  it("does not offer an install for a package that comes in through another, and does not draw the words as a command", () => {
    const [root] = dependencyGroups;
    render(<DependencyTable groups={[{ ...root!, relationship: "transitive" }]} />);
    const [row] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(row).not.toHaveTextContent("npm install");
    const words = within(row!).getByText(/left-pad comes in through another package/);
    expect(words.tagName).toBe("SPAN");
    expect(words.closest("code")).toBeNull();
    expect(within(row!).queryByRole("code")).not.toBeInTheDocument();
    expect(within(row!.querySelector("th")!).getByText(copy.security.upgrades.relationship.transitive)).toBeInTheDocument();
  });

  it("gives words and not a command for a requirements file or a build file", () => {
    const [root] = dependencyGroups;
    render(
      <DependencyTable
        groups={[
          { ...root!, ecosystem: "pip", manifestPath: "requirements.txt" },
          { ...root!, ecosystem: "maven", name: "commons-io", manifestPath: "pom.xml" },
        ]}
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Set left-pad==1.3.1 in requirements.txt");
    expect(rows[1]).toHaveTextContent("Raise commons-io to 1.3.1 in your build file");
    expect(within(rows[0]!).queryByRole("code")).not.toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("code")).not.toBeInTheDocument();
  });

  it("says a package the host did not name was not named, with no ecosystem or file, and offers no command", () => {
    const [root] = dependencyGroups;
    render(<DependencyTable groups={[{ ...root!, name: null, ecosystem: null, manifestPath: null }]} />);
    const [row] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(row!).getByText(copy.security.upgrades.unnamed)).toBeInTheDocument();
    expect(within(row!).getByText(copy.security.upgrades.noManifest)).toBeInTheDocument();
    expect(within(row!).getByText(copy.security.upgrades.noCommandUnnamed)).toBeInTheDocument();
    expect(within(row!).queryByRole("code")).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent("null");
  });

  it("draws two unnamed packages as two rows without a duplicate key", () => {
    const [root] = dependencyGroups;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unnamed = { ...root!, name: null, ecosystem: null, manifestPath: null };
    render(<DependencyTable groups={[unnamed, unnamed]} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("lists the different fixes when no single upgrade covers every alert", () => {
    render(<DependencyTable groups={[{ ...dependencyGroups[1]!, upgradeTo: null, patchedVersions: ["1.2.0", "2.0.1"] }]} />);
    expect(screen.getByText("Different fixes for different alerts, 1.2.0 and 2.0.1")).toBeInTheDocument();
  });

  it("says no package has an open alert", () => {
    render(<DependencyTable groups={[]} />);
    expect(screen.getByText(copy.security.upgrades.none)).toBeInTheDocument();
  });

  it("shows ten packages and offers the rest behind a button", async () => {
    const user = userEvent.setup();
    const groups = Array.from({ length: 11 }, (_, i) => ({ ...dependencyGroups[1]!, name: `pkg-${i}` }));
    render(<DependencyTable groups={groups} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(11);
    await user.click(screen.getByRole("button", { name: copy.space.showAll(11) }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(12);
  });
});
