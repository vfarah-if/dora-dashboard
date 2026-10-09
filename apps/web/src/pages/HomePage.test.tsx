import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoute } from "../test/render";
import { copy } from "../copy";
import { HomePage } from "./HomePage";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("gives one line for every band of every measure, each beside its band name", () => {
    renderRoute(<HomePage />);
    const heading = screen.getByRole("heading", { level: 3, name: copy.dora.explain.meaningTitle });
    const section = heading.closest("section")!;
    for (const measure of ["deploymentFrequency", "leadTime", "changeFailure", "timeToRestore"] as const) {
      const card = within(section).getByRole("heading", { level: 4, name: copy.dora[measure] }).closest("li")!;
      for (const band of ["elite", "high", "medium", "low"] as const) {
        const term = within(card).getByText(copy.dora.band[band]).closest("div")!;
        expect(term).toHaveTextContent(copy.dora.explain.meaning[measure][band]);
      }
    }
  });

  it("explains how teams move up with practice links and says the measures describe a system", () => {
    renderRoute(<HomePage />);
    expect(screen.getByRole("heading", { level: 3, name: copy.dora.explain.moveUp.title })).toBeInTheDocument();
    expect(screen.getByText(copy.dora.explain.moveUp.body)).toBeInTheDocument();
    const lead = screen.getByText(copy.dora.explain.moveUp.linksLead, { exact: false });
    expect(within(lead).getByRole("link", { name: /Working in small batches/ })).toHaveAttribute(
      "href",
      "https://dora.dev/capabilities/working-in-small-batches/",
    );
    expect(within(lead).getByRole("link", { name: /Continuous delivery/ })).toHaveAttribute("target", "_blank");
    expect(within(lead).getByRole("link", { name: /Test automation/ })).toBeInTheDocument();
    expect(lead).toHaveTextContent(/Continuous delivery \(opens in a new tab\) and Test automation/);
    const quote = screen.getByText(copy.dora.explain.system.quote);
    expect(
      within(quote.closest("blockquote")!).getByRole("link", { name: new RegExp(copy.dora.explain.system.label) }),
    ).toHaveAttribute("href", "https://dora.dev/guides/how-to-empower-software-delivery-teams/");
  });

  it("names the profile and cites the 2023 report, with the corrected deployment frequency row", () => {
    renderRoute(<HomePage />);
    expect(screen.getByRole("table", { name: /DORA 2023 profile/ })).toBeInTheDocument();
    const bands = screen.getByRole("region", { name: copy.home.bandsTitle });
    const source = within(bands).getByRole("link", { name: new RegExp(copy.home.bandsSource) });
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

  it("offers the page as a PDF after the other buttons, saved under a name for the page", async () => {
    const user = userEvent.setup();
    const titles: string[] = [];
    vi.spyOn(window, "print").mockImplementation(() => {
      titles.push(document.title);
      window.dispatchEvent(new Event("afterprint"));
    });
    renderRoute(<HomePage />);

    const hero = screen.getByRole("region", { name: copy.home.title });
    const actions = [...hero.querySelectorAll("a, button")].map((el) => el.textContent);
    expect(actions).toEqual([copy.home.toRepos, copy.home.toKeys, copy.report.download]);

    await user.click(within(hero).getByRole("button", { name: copy.report.download }));
    await waitFor(() => expect(titles).toHaveLength(1));
    expect(titles[0]).toMatch(/^delivery-metrics-why-it-matters-\d{4}-\d{2}-\d{2}$/);
  });

  it("lists every outside link on the page once, as a link showing its full address, for the printed copy", () => {
    renderRoute(<HomePage />);
    const list = screen.getByRole("region", { name: copy.home.linksTitle });
    const inText = [...document.querySelectorAll('a[href^="http"]')].filter((a) => !list.contains(a));
    const listed = within(list).getAllByRole("link");

    expect(listed.map((a) => a.getAttribute("href"))).toEqual([...new Set(inText.map((a) => a.getAttribute("href")))]);
    for (const link of listed) expect(link).toHaveTextContent(link.getAttribute("href")!);
    expect(within(list).getByRole("link", { name: new RegExp(copy.home.beckSource) })).toHaveAttribute(
      "href",
      "https://martinfowler.com/bliki/BeckDesignRules.html",
    );
  });
});
