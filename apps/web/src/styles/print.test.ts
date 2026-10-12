import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

  it("leaves a closed glossary out, since only the word to press would print", () => {
    expect(printRule("#security-glossary:has(")).toMatch(/display:\s*none/);
  });
});
