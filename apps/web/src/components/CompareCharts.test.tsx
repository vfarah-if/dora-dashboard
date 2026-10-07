import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareCharts, type ChartSwitches } from "./CompareCharts";
import { copy } from "../copy";
import type { CompareWeekly } from "../lib/compare";
import { seriesFor } from "../lib/series";
import { report } from "../test/fixtures";

const reports = [report({ id: 1, name: "widgets" }), report({ id: 2, name: "gadgets" })];
const series = seriesFor(reports, [1, 2]);

// The series keys are r1 and r2. Neither repository deployed, and gadgets merged its pull requests in no time at all.
const weekly: CompareWeekly = {
  cumulative: [{ x: "2026-01-05", r1: 2, r2: 3 }],
  throughput: [{ x: "2026-01-05", r1: 2, r2: 3 }],
  openToMerge: [{ x: "2026-01-05", r1: 5, r2: 0 }],
  deploys: [{ x: "2026-01-05", r1: 0, r2: 0 }],
  clippedTo: null,
};

function renderCharts(switches: Partial<ChartSwitches> = {}) {
  const setLog = vi.fn();
  render(
    <CompareCharts
      reports={reports}
      series={series}
      weekly={weekly}
      switches={{ aligned: false, perContributor: false, log: false, setLog, ...switches }}
    />,
  );
  return { setLog };
}

const card = (title: string) => screen.getByRole("region", { name: title });

describe("CompareCharts", () => {
  it("titles throughput per active author when per contributor is on", () => {
    renderCharts({ perContributor: true });
    expect(card(copy.compare.throughput.titlePerContributor)).toHaveTextContent(copy.compare.throughput.subtitlePerContributor);
    expect(screen.queryByRole("region", { name: copy.compare.throughput.title })).not.toBeInTheDocument();
  });

  it("says there is no data when no repository deployed, rather than drawing a flat line", () => {
    renderCharts();
    expect(within(card(copy.compare.deploys.title)).getByText(copy.charts.noData)).toBeInTheDocument();
    expect(within(card(copy.compare.cumulative.title)).queryByText(copy.charts.noData)).not.toBeInTheDocument();
  });

  it("asks for the log scale from the open to merge chart, and only then notes the weeks it leaves out", async () => {
    const user = userEvent.setup();
    const { setLog } = renderCharts();
    const openToMerge = card(copy.compare.openToMerge.title);
    expect(within(openToMerge).queryByText(copy.compare.openToMerge.logNote)).not.toBeInTheDocument();
    await user.click(within(openToMerge).getByRole("switch", { name: copy.compare.logScale }));
    expect(setLog).toHaveBeenCalledWith(true);
  });

  it("notes the weeks a log scale leaves out while it is on", () => {
    renderCharts({ log: true });
    expect(within(card(copy.compare.openToMerge.title)).getByText(copy.compare.openToMerge.logNote)).toBeInTheDocument();
  });
});
