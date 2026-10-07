import { VISITOR_KEYS } from "@babel/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureSource } from "../src/infrastructure/babel/measure-source.js";

// Stands in for what the parser does that real source cannot provoke: failing for a reason other than the file, and
// producing tokens or nodes this module has never seen.
const hooks = vi.hoisted(() => ({ throwing: null as Error | null, extraToken: null as string | null }));

vi.mock("@babel/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babel/parser")>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      if (hooks.throwing) throw hooks.throwing;
      const file = actual.parse(...args);
      if (hooks.extraToken) {
        file.tokens!.push({ type: hooks.extraToken, start: 0, end: 1, loc: { start: { line: 1 }, end: { line: 1 } } });
      }
      return file;
    },
  };
});

afterEach(() => {
  hooks.throwing = null;
  hooks.extraToken = null;
});

describe("measureSource: faults that are not the file's", () => {
  it("lets a fault in the parser's set-up through, since it is not caused by what the file holds", () => {
    hooks.throwing = new Error("Cannot use the decorators and decorators-legacy plugin together");

    expect(() => measureSource("src/a.ts", "function a() {}")).toThrow("plugin together");
  });

  it("calls a file incomplete, naming the token, when the parser produces one it cannot count", () => {
    hooks.extraToken = "Mystery";

    const result = measureSource("src/a.ts", "function a() {}");

    expect(result).toMatchObject({
      complete: false,
      problem: "The parser produced a token of type Mystery that this module does not know how to count.",
      functions: [{ name: "a" }],
    });
  });

  it("calls a file incomplete, naming the node type, when the walk meets one it has no keys for", () => {
    const keys = VISITOR_KEYS as Record<string, string[] | undefined>;
    const saved = keys.IfStatement;
    delete keys.IfStatement;
    try {
      const result = measureSource("src/a.ts", "function a(x) { if (x) return 1; }");

      expect(result).toMatchObject({
        complete: false,
        problem: "The parser produced a node of type IfStatement that this module does not know how to read.",
        functions: [{ name: "a" }],
      });
    } finally {
      keys.IfStatement = saved;
    }
  });
});
