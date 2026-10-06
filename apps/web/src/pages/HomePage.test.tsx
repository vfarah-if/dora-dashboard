import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderRoute } from "../test/render";
import { copy } from "../copy";
import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("explains all four keys under throughput and stability", () => {
    renderRoute(<HomePage />);
    const throughput = screen.getByRole("region", { name: copy.home.groups.throughput.title });
    const stability = screen.getByRole("region", { name: copy.home.groups.stability.title });
    expect(within(throughput).getByRole("heading", { name: "Deployment frequency" })).toBeInTheDocument();
    expect(within(throughput).getByRole("heading", { name: "Lead time for changes" })).toBeInTheDocument();
    expect(within(stability).getByRole("heading", { name: "Change failure rate" })).toBeInTheDocument();
    expect(within(stability).getByRole("heading", { name: "Time to restore" })).toBeInTheDocument();
  });

  it("names every band in words beside its thresholds", () => {
    renderRoute(<HomePage />);
    const table = screen.getByRole("table", { name: copy.home.bandsCaption });
    for (const band of Object.values(copy.dora.band)) {
      expect(within(table).getByRole("columnheader", { name: band })).toBeInTheDocument();
    }
    const row = within(table).getByRole("row", { name: /Change failure rate/ });
    expect(within(row).getByText("5% or less")).toBeInTheDocument();
  });

  it("names the profile and cites the 2023 report, with the corrected deployment frequency row", () => {
    renderRoute(<HomePage />);
    expect(screen.getByRole("table", { name: /DORA 2023 profile/ })).toBeInTheDocument();
    const source = screen.getByRole("link", { name: new RegExp(copy.home.bandsSource) });
    expect(source).toHaveAttribute("href", copy.home.bandsSourceHref);
    expect(source).toHaveAttribute("target", "_blank");
    const table = screen.getByRole("table", { name: copy.home.bandsCaption });
    const row = within(table).getByRole("row", { name: /Deployment frequency/ });
    expect(within(row).getByText("1 or more every four weeks")).toBeInTheDocument();
    expect(within(row).queryByText("1 or more a month")).not.toBeInTheDocument();
  });

  it("lists Beck's four rules in priority order and links to the source in a new tab", () => {
    renderRoute(<HomePage />);
    const section = screen.getByRole("region", { name: copy.home.beckTitle });
    const names = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(names).toEqual(["Passes the tests", "Reveals intention", "No duplication", "Fewest elements"]);
    const source = within(section).getByRole("link", { name: new RegExp(copy.home.beckSource) });
    expect(source).toHaveAttribute("href", "https://martinfowler.com/bliki/BeckDesignRules.html");
    expect(source).toHaveAttribute("target", "_blank");
  });

  it("gives the diagrams a text alternative and writes each lead time stage out", () => {
    renderRoute(<HomePage />);
    expect(screen.getByRole("img", { name: copy.home.heroDiagram })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: copy.home.flowDiagram })).toBeInTheDocument();
    for (const stage of copy.home.stages) expect(screen.getByText(stage.name)).toBeInTheDocument();
  });

  it("sends the reader on to the repositories", () => {
    renderRoute(<HomePage />);
    const links = screen.getAllByRole("link", { name: copy.home.toRepos });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", "/repos");
  });

  it("explains delivery from Jira with a line for each measure and says people are hidden", () => {
    renderRoute(<HomePage />);
    const section = screen.getByRole("region", { name: copy.home.jira.title });
    const names = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(names).toEqual([
      "Issue cycle time",
      "Issue lead time",
      "Throughput",
      "Work in progress and ageing work",
      "Time per column",
      "Flow efficiency",
      "Issue to first pull request and to production",
      "Hygiene checks",
    ]);
    expect(within(section).getByText(/prompts to tidy rather than a score/)).toBeInTheDocument();
    expect(within(section).getByText(copy.home.jira.people)).toBeInTheDocument();
  });
});
