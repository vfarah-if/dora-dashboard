import type { CodeAnalysis } from "../src/interfaces/code-analyser.js";
import { describe, expect, it } from "vitest";
import { CombinedAnalyser } from "../src/infrastructure/analysis/combined-analyser.js";
import { createCodeAnalyser } from "../src/infrastructure/analysis/create-code-analyser.js";
import { isScriptPath } from "../src/infrastructure/analysis/languages.js";
import { BabelAnalyser, MAX_SOURCE_BYTES } from "../src/infrastructure/babel/babel-analyser.js";
import type { Logger } from "../src/interfaces/logger.js";
import { FakeCodeAnalyser, FakeWorkspaceReader, fn } from "./fakes.js";

const readerWith = (files: Record<string, string>) => {
  const reader = new FakeWorkspaceReader();
  for (const [path, content] of Object.entries(files)) reader.files.set(path, content);
  return reader;
};

const recordingLog = () => {
  const lines: { level: string; context: object; message: string }[] = [];
  const log: Logger = {
    info: (context, message) => void lines.push({ level: "info", context, message }),
    warn: (context, message) => void lines.push({ level: "warn", context, message }),
    error: (context, message) => void lines.push({ level: "error", context, message }),
  };
  return { lines, log };
};

describe("isScriptPath", () => {
  it.each([["src/a.ts"], ["src/a.tsx"], ["src/a.mts"], ["src/a.cts"], ["src/a.js"], ["src/a.jsx"], ["src/a.mjs"], ["src/a.cjs"]])(
    "treats %s as a script",
    (path) => {
      expect(isScriptPath(path)).toBe(true);
    },
  );

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
    // Past the point where spreading them into push overflows the stack. Parsing that many takes seconds on a busy CI
    // runner, so the file's measurement is handed in rather than parsed.
    const reader = readerWith({ "src/table.js": "" });
    const many = Array.from({ length: 150_000 }, (_, i) => fn({ file: "src/table.js", startLine: i + 1 }));

    const result = await new BabelAnalyser(reader, {
      measure: () => ({ functions: many, complete: true, problem: null }),
    }).analyse("/clone");

    expect(result.functions).toHaveLength(150_000);
    expect(result.partlyMeasured).toEqual([]);
  });

  it("reaches everything, since the parser is a dependency rather than a separate tool", async () => {
    expect(await new BabelAnalyser(new FakeWorkspaceReader()).reach()).toBe("full");
  });

  it.each([
    ["src/a.ts", true],
    ["src/a.TSX", true],
    ["src/a.mts", true],
    ["lib/a.cjs", true],
    ["src/types.d.ts", false],
    ["src/types.d.mts", false],
    ["public/app.min.js", false],
    ["public/APP.MIN.MJS", false],
    ["lib/tool.py", false],
    ["README.md", false],
  ])("measures %s: %s", (path, expected) => {
    expect(new BabelAnalyser(new FakeWorkspaceReader()).measures(path)).toBe(expected);
  });

  it("skips every kind of declaration and minified file, whatever its letter case", async () => {
    const reader = readerWith({
      "types/a.d.mts": "",
      "types/b.d.cts": "",
      "public/c.min.mjs": "",
      "public/d.min.cjs": "",
      "public/E.MIN.JS": "",
      "src/ok.ts": "",
    });

    await new BabelAnalyser(reader).analyse("/clone");

    expect(reader.reads).toEqual(["src/ok.ts"]);
  });

  it("stops between files when the ten minutes run out, without reading the next file", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}", "src/b.ts": "function b() {}" });
    // The deadline is set at 0 + 10 minutes. The first file is checked at 1 ms and read; the second at 10 minutes and 1 ms.
    const times = [0, 1, 10 * 60_000 + 1];
    const analyser = new BabelAnalyser(reader, { now: () => times.shift() ?? Infinity });

    await expect(analyser.analyse("/clone")).rejects.toThrow(
      "Measuring JavaScript and TypeScript took longer than 10 minutes and was stopped.",
    );
    expect(reader.reads).toEqual(["src/a.ts"]);
  });

  it("carries on at exactly ten minutes", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}" });
    const times = [0, 10 * 60_000];
    const analyser = new BabelAnalyser(reader, { now: () => times.shift() ?? Infinity });

    expect((await analyser.analyse("/clone")).functions.map((f) => f.name)).toEqual(["a"]);
  });

  it("reads a file of exactly 2 MiB and lists one a byte larger as partly measured", async () => {
    const reader = readerWith({
      "src/exact.ts": "x".repeat(2_097_152),
      "src/over.ts": "x".repeat(2_097_153),
    });
    const measured: string[] = [];
    const measure = (path: string) => {
      measured.push(path);
      return { functions: [], complete: true, problem: null };
    };

    const result = await new BabelAnalyser(reader, { measure }).analyse("/clone");

    expect(measured).toEqual(["src/exact.ts"]);
    expect(result.partlyMeasured).toEqual(["src/over.ts"]);
  });

  it("stops once ten minutes have passed, naming what it was measuring", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}" });
    const times = [0, 10 * 60_000 + 1];
    const analyser = new BabelAnalyser(reader, { now: () => times.shift() ?? Infinity });

    await expect(analyser.analyse("/clone")).rejects.toThrow(
      "Measuring JavaScript and TypeScript took longer than 10 minutes and was stopped.",
    );
    expect(reader.reads).toEqual([]);
  });

  it("logs once, at info, why each partly measured file was only read in part", async () => {
    const reader = readerWith({
      "src/ok.ts": "function ok() {}",
      "src/big.ts": "x".repeat(MAX_SOURCE_BYTES + 1),
      "src/broken.ts": "function first() { let a = 1; let a = 2; return a; }",
    });
    const { lines, log } = recordingLog();

    await new BabelAnalyser(reader, { log }).analyse("/clone");

    expect(lines).toEqual([
      {
        level: "info",
        context: {
          total: 2,
          files: [
            { path: "src/big.ts", problem: "larger than 2 MiB or could not be read" },
            { path: "src/broken.ts", problem: expect.stringContaining("already been declared") },
          ],
        },
        message: expect.stringContaining("only in part"),
      },
    ]);
  });

  it("names at most twenty files in the log line, but counts them all", async () => {
    const reader = readerWith(
      Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, "x".repeat(MAX_SOURCE_BYTES + 1)]),
      ),
    );
    const { lines, log } = recordingLog();

    const result = await new BabelAnalyser(reader, { log }).analyse("/clone");

    expect(result.partlyMeasured).toHaveLength(25);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.context).toMatchObject({
      total: 25,
      files: expect.arrayContaining([{ path: "src/f00.ts", problem: expect.any(String) }]),
    });
    expect((lines[0]!.context as { files: unknown[] }).files).toHaveLength(20);
  });

  it("says why a file is incomplete even when the measurement gives no reason", async () => {
    const reader = readerWith({ "src/a.ts": "" });
    const { lines, log } = recordingLog();

    await new BabelAnalyser(reader, { log, measure: () => ({ functions: [], complete: false, problem: null }) }).analyse(
      "/clone",
    );

    expect(lines[0]!.context).toEqual({ total: 1, files: [{ path: "src/a.ts", problem: "could not be read in full" }] });
  });

  it("logs nothing when every file was read in full", async () => {
    const { lines, log } = recordingLog();

    await new BabelAnalyser(readerWith({ "src/a.ts": "function a() {}" }), { log }).analyse("/clone");

    expect(lines).toEqual([]);
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
    scripts.measuresPath = (path) => /\.tsx?$/.test(path);
    const others = new FakeCodeAnalyser();
    others.measuresPath = (path) => /\.(py|go)$/.test(path);
    const reader = new FakeWorkspaceReader();
    return { scripts, others, reader, combined: new CombinedAnalyser({ scripts, others, reader }) };
  };

  const listing = ["app/main.py", "app/util.go", "src/index.ts", "src/view.tsx", "README.md", "Makefile"];

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

  it("keeps each analyser's results only for the files it owns, whatever it returned", async () => {
    const { scripts, others, combined } = analysers();
    scripts.functions = [fn({ file: "src/a.ts", startLine: 1 }), fn({ file: "lib/stray.py", startLine: 1 })];
    scripts.partlyMeasured = ["src/p.ts", "lib/stray.py"];
    others.functions = [fn({ file: "lib/z.py", startLine: 1 }), fn({ file: "src/doubled.ts", startLine: 1 })];
    others.partlyMeasured = ["lib/y.py", "src/doubled.ts"];

    const result = await combined.analyse("/clone");

    expect(result.functions.map((f) => f.file)).toEqual(["lib/z.py", "src/a.ts"]);
    expect(result.partlyMeasured).toEqual(["lib/y.py", "src/p.ts"]);
  });

  it.each([
    ["full", "full", "full"],
    ["none", "none", "none"],
    ["full", "none", "partial"],
    ["none", "full", "partial"],
    ["partial", "full", "partial"],
    ["full", "partial", "partial"],
    ["partial", "none", "partial"],
    ["partial", "partial", "partial"],
  ] as const)("reaches %s with scripts %s and others %s", async (scriptsReach, othersReach, expected) => {
    const { scripts, others, combined } = analysers();
    scripts.reachIs = scriptsReach;
    others.reachIs = othersReach;

    expect(await combined.reach()).toBe(expected);
  });

  it("rejects when either analyser cannot find out what it reaches", async () => {
    const { others, combined } = analysers();
    others.reachFailWith = new Error("Lizard was found but did not run.");

    await expect(combined.reach()).rejects.toThrow("Lizard was found but did not run.");
  });

  it("analyses without asking either analyser what it reaches, so lizard is started once rather than twice", async () => {
    const { scripts, others, combined } = analysers();
    scripts.reachFailWith = new Error("asked the scripts analyser");
    others.reachFailWith = new Error("asked the other analyser");

    await expect(combined.analyse("/clone")).resolves.toMatchObject({ unmeasuredFiles: 0 });
  });

  it("passes on a real failure alone when the other side's tool is missing", async () => {
    const { scripts, others, combined } = analysers();
    scripts.failWith = new Error("parse failed");
    others.reachIs = "none";

    const failure = await combined.analyse("/clone").catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty("message", "parse failed");
  });

  it("measures a file when either analyser does", () => {
    const { combined } = analysers();

    expect(["src/a.ts", "app/main.py", "README.md"].map((path) => combined.measures(path))).toEqual([true, true, false]);
  });

  it("still measures the scripts when the other analyser's tool is missing, and counts the files it would have read", async () => {
    const { scripts, others, reader, combined } = analysers();
    others.reachIs = "none";
    for (const path of listing) reader.files.set(path, "");

    const result = await combined.analyse("/clone");

    // The other analyser is tried, and finds out its tool is missing when it runs.
    expect(others.analysed).toEqual(["/clone"]);
    expect(result.functions).toEqual(scripts.functions);
    // main.py and util.go: the scripts are measured, and the readme and Makefile are not source code.
    expect(result.unmeasuredFiles).toBe(2);
  });

  it("gives a file both analysers claim to the scripts analyser when counting what is unmeasured", async () => {
    const { others, reader, combined } = analysers();
    others.reachIs = "none";
    // Both claim the file, but the split gives it to the scripts analyser, which is running, so it is not unmeasured.
    others.measuresPath = () => true;
    for (const path of ["src/index.ts", "src/index.test.ts", "app/main.py"]) reader.files.set(path, "");

    expect((await combined.analyse("/clone")).unmeasuredFiles).toBe(1);
  });

  it.each([
    // Counted from the listing, then each side's own count: 2 + 0 + 3, 2 + 4 + 0 and 0 + 4 + 3.
    ["scripts missing", "none", "full", 5],
    ["others missing", "full", "none", 6],
    ["neither missing", "full", "full", 7],
  ] as const)(
    "adds what each analyser could not measure to the files counted as unmeasured, with %s",
    async (_label, scriptsReach, othersReach, total) => {
      const { scripts, others, reader, combined } = analysers();
      scripts.reachIs = scriptsReach;
      others.reachIs = othersReach;
      scripts.unmeasuredFiles = 4;
      others.unmeasuredFiles = 3;
      // The scripts' two files, or the other analyser's two, are counted from the listing when their side is missing.
      for (const path of listing) reader.files.set(path, "");

      expect((await combined.analyse("/clone")).unmeasuredFiles).toBe(total);
    },
  );

  it("counts the scripts as unmeasured, and still measures the rest, when the scripts analyser's tool is missing", async () => {
    const { scripts, others, reader, combined } = analysers();
    scripts.reachIs = "none";
    others.functions = [fn({ file: "app/main.py", startLine: 1 })];
    for (const path of listing) reader.files.set(path, "");

    const result = await combined.analyse("/clone");

    expect(scripts.analysed).toEqual(["/clone"]);
    expect(result.functions.map((f) => f.file)).toEqual(["app/main.py"]);
    // index.ts and view.tsx.
    expect(result.unmeasuredFiles).toBe(2);
  });

  it("counts every file when both tools are missing", async () => {
    const { scripts, others, reader, combined } = analysers();
    scripts.reachIs = "none";
    others.reachIs = "none";
    for (const path of listing) reader.files.set(path, "");

    const result = await combined.analyse("/clone");

    expect(result).toEqual({ functions: [], partlyMeasured: [], unmeasuredFiles: 4 });
  });

  it("lists the directory only when a side is missing", async () => {
    const { reader, combined } = analysers();
    let listed = 0;
    reader.list = async () => {
      listed += 1;
      return [];
    };

    await combined.analyse("/clone");

    expect(listed).toBe(0);
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

  it("reports both messages, and both errors, when both analysers fail", async () => {
    const { scripts, others, combined } = analysers();
    scripts.failWith = new Error("parse failed");
    others.failWith = new Error("lizard stopped");

    const error = await combined.analyse("/clone").then(
      () => null,
      (e: unknown) => e as AggregateError,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toBe("parse failed lizard stopped");
    expect(error?.errors).toEqual([scripts.failWith, others.failWith]);
  });
});

describe("createCodeAnalyser", () => {
  it("leaves lizard every language but the eight script extensions, whatever their letter case", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: "" };
    };
    const analyser = createCodeAnalyser(new FakeWorkspaceReader(), recordingLog().log, exec);

    await analyser.analyse("/clone");

    const lizard = calls.find((c) => c.args[0] === "--csv")!;
    // Each extension "ts" becomes the glob "*.[tT][sS]", so `Legacy.JSX` is not read by lizard as well.
    expect(lizard.args).toEqual([
      "--csv",
      ...[
        "*/node_modules/*",
        "*/vendor/*",
        "*/dist/*",
        "*/build/*",
        "*.min.js",
        "*.[tT][sS]",
        "*.[tT][sS][xX]",
        "*.[mM][tT][sS]",
        "*.[cC][tT][sS]",
        "*.[jJ][sS]",
        "*.[jJ][sS][xX]",
        "*.[mM][jJ][sS]",
        "*.[cC][jJ][sS]",
      ].flatMap((x) => ["-x", x]),
      ".",
    ]);
  });

  it("measures scripts itself and everything else through lizard, and reports lizard's absence as partial", async () => {
    const reader = readerWith({ "src/a.ts": "function a() {}", "app/main.py": "def main(): pass" });
    const analyser = createCodeAnalyser(reader, recordingLog().log, async () => {
      throw Object.assign(new Error("spawn lizard ENOENT"), { code: "ENOENT" });
    });

    expect(await analyser.reach()).toBe("partial");
    const result = await analyser.analyse("/clone");

    expect(result.functions.map((f) => f.name)).toEqual(["a"]);
    expect(result.unmeasuredFiles).toBe(1);
  });

  it("counts the files lizard would have read when it is missing, tests included, but not scripts or declaration files", async () => {
    const reader = readerWith({
      "app/main.py": "",
      "tests/test_main.py": "",
      "src/App.vue": "",
      "src/a.ts": "",
      "lib/types.d.ts": "",
      "README.md": "",
    });
    const analyser = createCodeAnalyser(reader, recordingLog().log, async () => {
      throw Object.assign(new Error("spawn lizard ENOENT"), { code: "ENOENT" });
    });

    // The two Python files and the Vue file.
    expect((await analyser.analyse("/clone")).unmeasuredFiles).toBe(3);
  });
});
