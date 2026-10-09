import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IssueWeekRow } from "@dora-dashboard/core";
import { ClosedByKindChart, OpenAtEndChart, OpenByKindChart, OpenByPriorityChart, OpenedClosedChart } from "./IssueCharts";
import { issueReport } from "../test/fixtures";
import { copy } from "../copy";

const card = (title: string) => screen.getByRole("region", { name: title });

async function tableOf(title: string) {
  const user = userEvent.setup();
  const chart = card(title);
  await user.click(within(chart).getByText(copy.common.viewAsTable));
  return within(chart).getByRole("table");
}

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);
const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

/** 27 whole weeks from Monday 7 July 2025, one more than the 26 a weekly chart shows before it offers a zoom. */
function weeks(count: number): IssueWeekRow[] {
  const start = Date.UTC(2025, 6, 7);
  return Array.from({ length: count }, (_, i) => ({
    week: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
    opened: 2,
    closed: 1,
    notPlanned: 0,
    closedByKind: { bug: 1, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 },
    openAtEnd: 10 + i,
    partial: false,
  }));
}

describe("open by kind", () => {
  it("tables every kind in the fixed order, with zero for a kind with none open", async () => {
    render(<OpenByKindChart openByKind={issueReport().openByKind} />);
    const table = await tableOf(copy.issue.open.byKind.title);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([copy.issue.open.byKind.kind, copy.issue.open.byKind.series]);
    // Bug 2, feature 2, maintenance 1, incident 0, security 1, other 0, as the report states.
    expect(bodyRows(table).map((row) => [within(row).getByRole("rowheader").textContent, ...cells(row)])).toEqual([
      ["Bug", "2"],
      ["Feature", "2"],
      ["Maintenance", "1"],
      ["Incident", "0"],
      ["Security", "1"],
      ["Other", "0"],
    ]);
  });

  it("says there is no data when nothing is open", () => {
    render(<OpenByKindChart openByKind={{ bug: 0, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 }} />);
    expect(within(card(copy.issue.open.byKind.title)).getByText(copy.charts.noData)).toBeInTheDocument();
  });
});

describe("open by priority", () => {
  it("tables every priority from P0 to none, in order", async () => {
    render(<OpenByPriorityChart openByPriority={issueReport().openByPriority} />);
    const table = await tableOf(copy.issue.open.byPriority.title);
    expect(bodyRows(table).map((row) => [within(row).getByRole("rowheader").textContent, ...cells(row)])).toEqual([
      ["P0", "1"],
      ["P1", "1"],
      ["P2", "2"],
      ["P3", "0"],
      ["P4", "0"],
      ["No priority", "2"],
    ]);
  });
});

describe("issues open at the end of each week", () => {
  it("tables the open count for each week the report holds", async () => {
    render(<OpenAtEndChart weekly={issueReport().weekly} part={null} />);
    const table = await tableOf(copy.issue.flow.openAtEnd.title);
    // The fixture walks 5, 5, then 5 + 4 - 3 = 6.
    expect(bodyRows(table).map((row) => [within(row).getByRole("rowheader").textContent, ...cells(row)])).toEqual([
      ["5 Jan", "5"],
      ["12 Jan", "5"],
      ["19 Jan", "6"],
    ]);
  });

  it("says there is no data when the report holds no weeks", () => {
    render(<OpenAtEndChart weekly={[]} part={null} />);
    expect(within(card(copy.issue.flow.openAtEnd.title)).getByText(copy.charts.noData)).toBeInTheDocument();
  });
});

describe("weekly charts over a long range", () => {
  const long = weeks(27);

  it.each([
    [
      "issues opened and closed",
      copy.issue.flow.openedClosed.title,
      (w: IssueWeekRow[]) => <OpenedClosedChart weekly={w} part={null} />,
    ],
    ["closed by kind", copy.issue.flow.closedByKind.title, (w: IssueWeekRow[]) => <ClosedByKindChart weekly={w} part={null} />],
    ["open at the end", copy.issue.flow.openAtEnd.title, (w: IssueWeekRow[]) => <OpenAtEndChart weekly={w} part={null} />],
  ])("offers a zoom slider on %s and lists all 27 weeks in its table", async (_name, title, chart) => {
    render(chart(long));
    // The slider has a handle at each end of the window.
    expect(within(card(title)).getAllByRole("slider", { name: copy.charts.zoomLabel })).toHaveLength(2);
    const table = await tableOf(title);
    expect(bodyRows(table)).toHaveLength(27);
    expect(within(bodyRows(table)[0]!).getByRole("rowheader")).toHaveTextContent("7 Jul");
    expect(within(bodyRows(table)[26]!).getByRole("rowheader")).toHaveTextContent("5 Jan");
  });

  it.each([
    [
      "issues opened and closed",
      copy.issue.flow.openedClosed.title,
      (w: IssueWeekRow[]) => <OpenedClosedChart weekly={w} part={null} />,
    ],
    ["closed by kind", copy.issue.flow.closedByKind.title, (w: IssueWeekRow[]) => <ClosedByKindChart weekly={w} part={null} />],
    ["open at the end", copy.issue.flow.openAtEnd.title, (w: IssueWeekRow[]) => <OpenAtEndChart weekly={w} part={null} />],
  ])("offers no zoom slider on %s for 26 weeks", (_name, title, chart) => {
    render(chart(long.slice(0, 26)));
    expect(within(card(title)).queryByRole("slider")).not.toBeInTheDocument();
  });
});
