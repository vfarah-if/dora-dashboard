import { XMLParser } from "fast-xml-parser";
import type { CoverageCount, CoverageFileReport } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

type Node = { [key: string]: unknown };

/** Tags that may appear once or many times, so the parser always gives a list. */
const LISTS = new Set(["package", "class", "method", "line", "source"]);

/** Entities are never expanded and a document type declaration is refused before parsing (billion laughs, XXE). */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => LISTS.has(name),
});

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
const attr = (node: Node, name: string): string | undefined => {
  const value = node[`@_${name}`];
  return typeof value === "string" ? value : undefined;
};
const whole = (text: string | undefined): number | null => {
  const value = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? Math.trunc(value) : null;
};
const linesOf = (holder: unknown): Node[] => (isNode(holder) ? listOf(holder.line).filter(isNode) : []);

/** `condition-coverage="50% (1/2)"` as covered and total, or null when the line is not a branch or says nothing. */
function conditions(line: Node): CoverageCount | null {
  const match = /\((\d+)\s*\/\s*(\d+)\)/.exec(attr(line, "condition-coverage") ?? "");
  return match ? { covered: Number(match[1]), total: Number(match[2]) } : null;
}

interface Merged {
  hits: Map<number, number>;
  branches: Map<number, CoverageCount>;
  functions: CoverageCount;
}

export interface CoberturaReport {
  files: CoverageFileReport[];
  /** The `<source>` roots that relative file names are relative to. */
  sourceRoots: string[];
}

/**
 * Reads a Cobertura XML report. Classes that share a file name (inner classes, one class per file split in two) are
 * merged into one file, taking the highest hit count per line. Branches come from `condition-coverage` on each line
 * and functions from the `<method>` elements, where a method ran when any of its lines did.
 */
export async function parseCobertura(text: string): Promise<CoberturaReport> {
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) {
    throw new UpstreamError("A coverage file in the artefact has a document type declaration, which is not read", 502);
  }
  let root: unknown;
  try {
    root = (parser.parse(text) as Node).coverage;
  } catch {
    throw new UpstreamError("A coverage file in the artefact is not valid XML", 502);
  }
  if (!isNode(root)) throw new UpstreamError("A coverage file in the artefact is not a Cobertura report", 502);

  const sourceRoots = isNode(root.sources)
    ? listOf(root.sources.source)
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
    : [];

  const merged = new Map<string, Merged>();
  let seen = 0;
  const packages = isNode(root.packages) ? listOf(root.packages.package).filter(isNode) : [];
  for (const pack of packages) {
    const classes = isNode(pack.classes) ? listOf(pack.classes.class).filter(isNode) : [];
    for (const cls of classes) {
      const filename = attr(cls, "filename");
      if (!filename) continue;
      const path = filename.trim().replace(/\\/g, "/");
      let file = merged.get(path);
      if (!file) merged.set(path, (file = { hits: new Map(), branches: new Map(), functions: { covered: 0, total: 0 } }));

      for (const line of linesOf(cls.lines)) {
        const number = whole(attr(line, "number"));
        const hits = whole(attr(line, "hits"));
        if (number === null || hits === null) continue;
        addHit(file.hits, number, hits);
        const branch = conditions(line);
        const before = file.branches.get(number);
        if (branch && (!before || branch.covered > before.covered)) file.branches.set(number, branch);
      }
      const methods = isNode(cls.methods) ? listOf(cls.methods.method).filter(isNode) : [];
      for (const method of methods) {
        file.functions.total++;
        if (linesOf(method.lines).some((line) => (whole(attr(line, "hits")) ?? 0) > 0)) file.functions.covered++;
      }
      if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
    }
  }

  const files: CoverageFileReport[] = [];
  for (const [path, file] of merged) {
    const ranges = lineRanges(file.hits);
    const report: CoverageFileReport = {
      path,
      lines: ranges.lines,
      covered: ranges.covered,
      uncovered: ranges.uncovered,
    };
    if (file.functions.total > 0) report.functions = file.functions;
    const branches = [...file.branches.values()].reduce(
      (sum, b) => ({ covered: sum.covered + b.covered, total: sum.total + b.total }),
      { covered: 0, total: 0 },
    );
    if (branches.total > 0) report.branches = branches;
    files.push(report);
  }
  return { files, sourceRoots };
}
