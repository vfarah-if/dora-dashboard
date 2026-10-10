import { XMLParser, XMLValidator } from "fast-xml-parser";
import { coverageCount, type CoverageCount, type CoverageFileReport } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

type Node = { [key: string]: unknown };

/** Tags that may appear once or many times, so the parser always gives a list. */
const LISTS = new Set(["package", "class", "method", "line", "source"]);

/**
 * Entities are never expanded (`processEntities: false`) and nothing here fetches a DTD, so a document type declaration
 * that only names an external identifier cannot do anything. Istanbul, Jest, Vitest and nyc, and Java Cobertura, all
 * write one, so it is accepted. A declaration with an internal subset, and any entity declaration, is refused before
 * parsing as a precaution (billion laughs, XXE).
 */
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
  return match ? coverageCount(Number(match[1]), Number(match[2])) : null;
}

const QUOTED = `(?:"[^"]*"|'[^']*')`;
/** A document type declaration with no internal subset: a name and at most a SYSTEM or PUBLIC external identifier. */
const EXTERNAL_DOCTYPE = new RegExp(
  `<!DOCTYPE\\s+[^\\s>\\[]+(?:\\s+(?:SYSTEM\\s+${QUOTED}|PUBLIC\\s+${QUOTED}\\s+${QUOTED}))?\\s*>`,
  "gi",
);

/** The text without its XML comments, found by index so that the cost is linear. An unclosed comment runs to the end. */
function withoutComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

/** True when the text holds an entity declaration or a document type declaration other than a plain external one. */
const hasUnsafeDeclaration = (text: string): boolean => {
  const code = withoutComments(text);
  return /<!ENTITY/i.test(code) || /<!DOCTYPE/i.test(code.replace(EXTERNAL_DOCTYPE, ""));
};

interface Merged {
  hits: Map<number, number>;
  branches: Map<number, CoverageCount>;
  /** Each method of the file once, by name, signature and first line; true when any copy of it ran. */
  methods: Map<string, boolean>;
}

export interface CoberturaReport {
  files: CoverageFileReport[];
  /** The `<source>` roots that relative file names are relative to. */
  sourceRoots: string[];
}

/**
 * Reads a Cobertura XML report. Classes that share a file name (inner classes, one class per file split in two) are
 * merged into one file, taking the highest hit count per line. Branches come from `condition-coverage` on each line
 * and functions from the `<method>` elements, where a method ran when any of its lines did. A method is told apart by
 * its name, signature and first line, so a class listed under two packages counts its methods once.
 */
export async function parseCobertura(text: string): Promise<CoberturaReport> {
  if (hasUnsafeDeclaration(text)) {
    throw new UpstreamError(
      "A coverage file in the artefact has an entity or internal document type declaration, which is not read",
      502,
    );
  }
  const notXml = (cause?: unknown) => new UpstreamError("A coverage file in the artefact is not valid XML", 502, { cause });
  // fast-xml-parser does not validate, so a truncated report would otherwise parse as a shorter one.
  const validity = XMLValidator.validate(text);
  if (validity !== true) throw notXml(validity);
  let root: unknown;
  try {
    // One synchronous call that cannot yield, so the yields below only help between classes. How long it can block is
    // bounded by the size caps in `read-coverage-archive.ts` (32 MiB of XML for one file), not by this function.
    root = (parser.parse(text) as Node).coverage;
  } catch (error) {
    throw notXml(error);
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
      if (!file) merged.set(path, (file = { hits: new Map(), branches: new Map(), methods: new Map() }));

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
        const methodLines = linesOf(method.lines);
        const key = [
          attr(method, "name") ?? "",
          attr(method, "signature") ?? "",
          attr(methodLines[0] ?? {}, "number") ?? "",
        ].join("\u0000");
        const ran = methodLines.some((line) => (whole(attr(line, "hits")) ?? 0) > 0);
        file.methods.set(key, (file.methods.get(key) ?? false) || ran);
      }
      if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
    }
  }

  const files: CoverageFileReport[] = [];
  for (const [path, file] of merged) {
    const ranges = lineRanges(file.hits);
    const report: CoverageFileReport = { path, lines: ranges.lines };
    if (ranges.ranges) report.ranges = ranges.ranges;
    if (file.methods.size > 0) {
      report.functions = { covered: [...file.methods.values()].filter(Boolean).length, total: file.methods.size };
    }
    const branches = [...file.branches.values()].reduce(
      (sum, b) => ({ covered: sum.covered + b.covered, total: sum.total + b.total }),
      { covered: 0, total: 0 },
    );
    if (branches.total > 0) report.branches = branches;
    files.push(report);
  }
  return { files, sourceRoots };
}
