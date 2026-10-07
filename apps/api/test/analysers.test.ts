import type { CodeAnalysis } from "../src/interfaces/code-analyser.js";
import { describe, expect, it } from "vitest";
import { CombinedAnalyser } from "../src/infrastructure/analysis/combined-analyser.js";
import { isScriptPath, SCRIPT_EXTENSIONS } from "../src/infrastructure/analysis/languages.js";
import { BabelAnalyser, MAX_SOURCE_BYTES } from "../src/infrastructure/babel/babel-analyser.js";
import { FakeCodeAnalyser, FakeWorkspaceReader, fn } from "./fakes.js";

const readerWith = (files: Record<string, string>) => {
  const reader = new FakeWorkspaceReader();
  for (const [path, content] of Object.entries(files)) reader.files.set(path, content);
  return reader;
};

describe("isScriptPath", () => {
  it.each(SCRIPT_EXTENSIONS.map((ext) => [`src/a.${ext}`]))("treats %s as a script", (path) => {
    expect(isScriptPath(path)).toBe(true);
  });

  it.each([["src/a.TSX"], ["lib/b.MJS"]])("ignores letter case in %s", (path) => {
    expect(isScriptPath(path)).toBe(true);
  });

  it.each([["app/main.py"], ["src/view.vue"], ["Makefile"], ["src.ts/readme"]])("does not treat %s as a script", (path) => {
    expect(isScriptPath(path)).toBe(false);
  });
});

describe("BabelAnalyser", () => {
  it("measures JavaScript and TypeScript only, skipping declaration and minified files", async () => {
    const reader = readerWith({
      "src/b.ts": "export function b() { return 1; }",
      "src/a.tsx": "export function A() {\n  return <div />;\n}\nexport function a2() {}",
      "src/types.d.ts": "export declare function t(): void;",
      "public/app.min.js": "function m(){}",
      "lib/tool.py": "def tool():\n    pass",
      "README.md": "# Widgets",
    });

    const result = await new BabelAnalyser(reader).analyse("/clone");

    expect(result.functions.map((f) => [f.file, f.name, f.startLine])).toEqual([
      ["src/a.tsx", "A", 1],
      ["src/a.tsx", "a2", 4],
      ["src/b.ts", "b", 1],
    ]);
    expect([...reader.reads].sort()).toEqual(["src/a.tsx", "src/b.ts"]);
    expect(result).toMatchObject({ partlyMeasured: [], unmeasuredFiles: 0 });
  });

  it("lists a file too large to read and a file the parser had to recover as partly measured", async () => {
    const reader = readerWith({
      "src/ok.ts": "function ok() {}",
      "src/big.ts": "x".repeat(MAX_SOURCE_BYTES + 1),
      "src/broken.ts": "function first() { let a = 1; let a = 2; return a; }",
    });

    const result = await new BabelAnalyser(reader).analyse("/clone");

    expect(result.partlyMeasured).toEqual(["src/big.ts", "src/broken.ts"]);
    // The recovered file still yields what the parser could read.
    expect(result.functions.map((f) => f.name)).toEqual(["first", "ok"]);
  });

  it("collects more functions from one file than a call can take as arguments", async () => {
    // 150,000 arrow functions in under 1 MiB, past the point where spreading them into push overflows the stack.
    const reader = readerWith({ "src/table.js": `export const table = [${"() => 0,".repeat(150_000)}];` });

    const result = await new BabelAnalyser(reader).analyse("/clone");

    expect(result.functions).toHaveLength(150_000);
  });

  it("is always available, since the parser is a dependency rather than a separate tool", async () => {
    expect(await new BabelAnalyser(new FakeWorkspaceReader()).available()).toBe(true);
  });

  it("stops once ten minutes have passed", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}" });
    const times = [0, 10 * 60_000 + 1];
    const analyser = new BabelAnalyser(reader, () => times.shift() ?? Infinity);

    await expect(analyser.analyse("/clone")).rejects.toThrow("Code analysis took longer than 10 minutes and was stopped.");
    expect(reader.reads).toEqual([]);
  });

  it("gives queued work a turn between files", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}" });
    let ranBeforeRead = false;
    const read = reader.read.bind(reader);
    let queuedRan = false;
    reader.read = async (dir, path, maxBytes) => {
      ranBeforeRead = queuedRan;
      return read(dir, path, maxBytes);
    };
    const pending = new BabelAnalyser(reader).analyse("/clone");
    setImmediate(() => (queuedRan = true));

    await pending;

    expect(ranBeforeRead).toBe(true);
  });
});

describe("CombinedAnalyser", () => {
  const analysers = () => {
    const scripts = new FakeCodeAnalyser();
    const others = new FakeCodeAnalyser();
    const reader = new FakeWorkspaceReader();
    return { scripts, others, reader, combined: new CombinedAnalyser(scripts, others, reader) };
  };

  it("merges both analysers' functions in file and line order, and their partly measured files", async () => {
    const { scripts, others, combined } = analysers();
    scripts.functions = [
      fn({ file: "src/b.ts", startLine: 5 }),
      fn({ file: "src/a.ts", startLine: 9 }),
      fn({ file: "src/a.ts", startLine: 2 }),
    ];
    scripts.partlyMeasured = ["src/x.tsx"];
    others.functions = [fn({ file: "lib/z.py", startLine: 1, language: "Python" })];
    others.partlyMeasured = ["lib/y.py"];

    const result = await combined.analyse("/clone");

    expect(result.functions.map((f) => `${f.file}:${f.startLine}`)).toEqual([
      "lib/z.py:1",
      "src/a.ts:2",
      "src/a.ts:9",
      "src/b.ts:5",
    ]);
    expect(result.partlyMeasured).toEqual(["lib/y.py", "src/x.tsx"]);
    expect(result.unmeasuredFiles).toBe(0);
    expect(scripts.analysed).toEqual(["/clone"]);
    expect(others.analysed).toEqual(["/clone"]);
  });

  it("is available whenever the script analyser is, with or without the other", async () => {
    const { scripts, others, combined } = analysers();
    others.isAvailable = false;
    expect(await combined.available()).toBe(true);
    scripts.isAvailable = false;
    expect(await combined.available()).toBe(false);
  });

  it("still measures the scripts without the other analyser, and counts the source files it would have read", async () => {
    const { scripts, others, reader, combined } = analysers();
    others.isAvailable = false;
    for (const path of ["app/main.py", "app/util.go", "src/index.ts", "src/view.tsx", "README.md", "Makefile"]) {
      reader.files.set(path, "");
    }

    const result = await combined.analyse("/clone");

    expect(others.analysed).toEqual([]);
    expect(result.functions).toEqual(scripts.functions);
    // main.py and util.go: the scripts are measured, and the readme and Makefile are not source code.
    expect(result.unmeasuredFiles).toBe(2);
  });

  it("waits for the other analyser to finish before passing on the script analyser's failure", async () => {
    const { scripts, others, combined } = analysers();
    scripts.failWith = new Error("parse failed");
    let release = () => {};
    others.analyse = () =>
      new Promise<CodeAnalysis>((resolve) => {
        release = () => resolve({ functions: [], partlyMeasured: [], unmeasuredFiles: 0 });
      });
    let failed = false;
    const result = combined.analyse("/clone").catch((error: Error) => {
      failed = true;
      throw error;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(failed).toBe(false);
    release();

    await expect(result).rejects.toThrow("parse failed");
  });

  it("passes on the other analyser's failure", async () => {
    const { others, combined } = analysers();
    others.failWith = new Error("lizard stopped");

    await expect(combined.analyse("/clone")).rejects.toThrow("lizard stopped");
  });
});
