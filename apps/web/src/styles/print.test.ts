import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { screen, within } from "@testing-library/react";
import { AcceptedFindings } from "../components/AcceptedFindings";
import { FindingRow } from "../components/FindingRow";
import { acceptanceView, chainItem, securityReport } from "../test/fixtures";
import { renderRoute } from "../test/render";

const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

/** The rules inside the last print block that mentions the given selector, so a rule cannot be deleted unnoticed. */
function printRule(selector: string): string {
  const blocks = css.split("@media print").slice(1);
  for (const block of blocks.reverse()) {
    const at = block.indexOf(selector);
    if (at === -1) continue;
    const open = block.indexOf("{", at);
    return block.slice(open + 1, block.indexOf("}", open));
  }
  throw new Error(`No print rule for ${selector}`);
}

describe("the printed security report", () => {
  it("lets a code block break between lines, keeping four lines together, instead of leaving a gap before it", () => {
    const rule = printRule(".copy-snippet-code {\n    break-inside");
    expect(rule).toMatch(/break-inside:\s*auto/);
    expect(rule).toMatch(/orphans:\s*4/);
    expect(rule).toMatch(/widows:\s*4/);
  });

  it("keeps a block's label with the first lines of its code", () => {
    expect(printRule(".action-heading,\n  .copy-snippet-head")).toMatch(/break-after:\s*avoid/);
  });

  it("keeps a closed explanation whole but lets an opened one run over a page", () => {
    expect(printRule(".action-item:not(:has(.action-details[open]))")).toMatch(/break-inside:\s*avoid/);
  });

  it("prints a finding's unopened explanation as its summary only, on purpose, as it appears on screen", () => {
    const { container } = renderRoute(
      createElement(FindingRow, {
        repoId: 1,
        line: { check: "prHeadCheckout", met: false, graded: true, items: [], total: 1, accepted: 0, absence: null },
        item: chainItem(".github/workflows/ci.yml", 12, "github.event.workflow_run.head_sha"),
      }),
    );
    const details = container.querySelector("details.finding-details")!;
    // A closed disclosure prints as a closed one, so nothing forces it open and only the summary is printed.
    expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("summary")).not.toBeNull();
    const printed = css
      .split("@media print")
      .slice(1)
      .map((block) => block.slice(0, block.indexOf("\n}\n") + 3))
      .join("\n");
    expect(printed).not.toMatch(/details[^{}]*\{[^{}]*display:\s*(block|flex)/);
    expect(printed).not.toMatch(/finding-(details|facts)[^{}]*\{[^{}]*display:\s*(block|flex)/);
    expect(printed).not.toMatch(/content-visibility/);
  });

  it("leaves a closed glossary out, since only the word to press would print", () => {
    expect(printRule("#security-glossary:has(")).toMatch(/display:\s*none/);
  });
});

describe("the printed accepted findings", () => {
  const printed = css
    .split("@media print")
    .slice(1)
    .map((block) => block.slice(0, block.indexOf("\n}\n") + 3))
    .join("\n");

  it("leaves out whatever is marked as screen only", () => {
    expect(printRule(".screen-only")).toMatch(/display:\s*none\s*!important/);
  });

  it("leaves the section out only when nothing is accepted, since it then holds one line saying so", () => {
    expect(printRule("#security-accepted:has(.accepted-empty)")).toMatch(/display:\s*none/);
  });

  it("never hides the section when it holds an acceptance", () => {
    // Each innermost rule, so a rule inside a print block is read on its own.
    const hidden = [...printed.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => /display:\s*none/.test(match[2]!))
      .map((match) => match[1]!);
    expect(hidden.length).toBeGreaterThan(3);
    for (const selector of hidden) {
      expect(selector).not.toMatch(/accepted-(entry|list|facts|note|place|status)/);
      expect(selector.replace(/\s+/g, " ")).not.toMatch(/#security-accepted(?!:has\(\.accepted-empty\))/);
    }
  });

  it("keeps one acceptance whole on a page", () => {
    expect(printRule(".accepted-entry {")).toMatch(/break-inside:\s*avoid/);
  });

  it("marks every button of the section as screen only, and none of what it prints", () => {
    renderRoute(
      createElement(AcceptedFindings, {
        report: securityReport({
          acceptances: [acceptanceView(), acceptanceView({ status: "gone", covers: 0, items: [], acceptance: { id: 6 } })],
        }),
      }),
    );
    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("screen-only");
    const section = document.getElementById("security-accepted")!;
    expect(section.closest(".screen-only")).toBeNull();
    for (const entry of within(section).getAllByRole("listitem")) {
      expect(entry).not.toHaveClass("screen-only");
      expect(within(entry).getByText("Only reached for pushes.").closest(".screen-only")).toBeNull();
    }
  });
});
