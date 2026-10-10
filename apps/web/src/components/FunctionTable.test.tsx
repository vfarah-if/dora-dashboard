import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FunctionTable } from "./FunctionTable";
import { copy } from "../copy";

const row = { file: "apps/api/src/run.ts", name: "run", startLine: 7, ccn: 14, nloc: 40 };

describe("FunctionTable", () => {
  it("shows the five columns of the hotspots table by default, with advice", () => {
    render(<FunctionTable rows={[{ ...row, shape: "long", onPath: true }]} caption="Functions" />);
    const table = screen.getByRole("table", { name: "Functions" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      copy.codeHealth.hotspots.function,
      copy.codeHealth.hotspots.location,
      copy.codeHealth.hotspots.ccn,
      copy.codeHealth.hotspots.nloc,
      copy.codeHealth.hotspots.advice,
    ]);
    const body = within(table).getAllByRole("row")[1]!;
    expect(body).toHaveTextContent("apps/api/src/run.ts:7");
    expect(body).toHaveTextContent(copy.codeHealth.hotspots.startHere);
    expect(body).toHaveTextContent(copy.codeHealth.hotspots.adviceFor.long);
  });

  it("adds an area column and a coverage share, and says when coverage is not known", () => {
    render(
      <FunctionTable
        rows={[
          { ...row, area: "apps/api", coverage: 0.25 },
          { ...row, name: "other", area: ".", coverage: null },
        ]}
        caption="Functions"
        areaLabel={(area) => (area === "." ? "Root files" : (area ?? ""))}
        showCoverage
        showAdvice={false}
      />,
    );
    const table = screen.getByRole("table", { name: "Functions" });
    expect(within(table).getByRole("columnheader", { name: copy.codeAnalysis.functions.area })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: copy.codeHealth.hotspots.advice })).not.toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /^run / })).toHaveTextContent("apps/api");
    expect(within(table).getByRole("row", { name: /^run / })).toHaveTextContent("25%");
    expect(within(table).getByRole("row", { name: /^other / })).toHaveTextContent("Root files");
    expect(within(table).getByRole("row", { name: /^other / })).toHaveTextContent(copy.codeAnalysis.functions.coverageUnknown);
  });

  it("says so when there are no rows, using the given words when there are some", () => {
    const { rerender } = render(<FunctionTable rows={[]} caption="Functions" />);
    expect(screen.getByText(copy.codeHealth.hotspots.empty)).toBeInTheDocument();
    rerender(<FunctionTable rows={[]} caption="Functions" empty="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});
