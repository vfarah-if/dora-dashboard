import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeSnapshot } from "@dora-dashboard/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { GitCheckout, type Exec as GitExec, type ExecOptions as GitExecOptions } from "../src/infrastructure/git/git-checkout.js";
import { languageOf } from "../src/infrastructure/analysis/languages.js";
import {
  LIZARD_EXTENSIONS,
  LizardAnalyser,
  parseLizardCsv,
  type ExecOptions as LizardExecOptions,
} from "../src/infrastructure/lizard/lizard-analyser.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { AnalyserMissingError } from "../src/interfaces/code-analyser.js";
import { RepoService } from "../src/services/repo-service.js";
import { isSafeBranch, parseRepoRef } from "../src/services/repo-ref.js";
import { ANALYSER_MISSING, ANALYSIS_OFF, CodeHealthService } from "../src/services/code-health-service.js";
import { CrawlService } from "../src/services/crawl-service.js";
import { config, FakeCli, FakeCodeAnalyser, FakeProvider, FakeSourceCheckout, fn, pr, run, settled } from "./fakes.js";

const NOW = new Date("2026-09-29T10:00:00Z");

describe("code health during a crawl", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let checkout: FakeSourceCheckout;
  let analyser: FakeCodeAnalyser;
  let service: CodeHealthService;
  let crawler: CrawlService;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    checkout = new FakeSourceCheckout();
    analyser = new FakeCodeAnalyser();
    service = new CodeHealthService(store, checkout, analyser, () => NOW);
    crawler = new CrawlService(store, provider, service);
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })] });
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "release").id;
  });

  it("saves a snapshot of the deploy branch and disposes of the clone", async () => {
    analyser.functions = [fn({ name: "a", ccn: 4 }), fn({ name: "b", ccn: 12 })];

    await crawler.crawl("secret-token", repoId);

    expect(checkout.requests).toEqual([{ token: "secret-token", owner: "acme", name: "widgets", branch: "release" }]);
    expect(store.latestCodeSnapshot(repoId)).toMatchObject({
      commitSha: "abc1234",
      analysedAt: "2026-09-29T10:00:00.000Z",
      error: null,
      functions: [expect.objectContaining({ name: "a" }), expect.objectContaining({ name: "b" })],
    });
    expect(checkout.disposed).toEqual(["/fake/checkout-1"]);
    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlProgress: null });
  });

  it("stores the files the analyser reports as partly measured on the snapshot", async () => {
    analyser.partlyMeasured = ["src/Tile.tsx"];

    const snapshot = await service.analyse("token", repoId);

    expect(snapshot.partlyMeasured).toEqual(["src/Tile.tsx"]);
    expect(store.latestCodeSnapshot(repoId)!.partlyMeasured).toEqual(["src/Tile.tsx"]);
    expect(service.report(repoId)).toMatchObject({ partlyMeasured: ["src/Tile.tsx"] });
  });

  it("stores how many source files no installed tool could read", async () => {
    analyser.unmeasuredFiles = 3;

    const snapshot = await service.analyse("token", repoId);

    expect(snapshot.unmeasuredFiles).toBe(3);
    expect(service.report(repoId)).toMatchObject({ unmeasuredFiles: 3 });
  });

  it("shows the progress message while analysing", async () => {
    const seen: (string | null)[] = [];
    analyser.analyse = async () => {
      seen.push(store.getRepo(repoId)!.crawlProgress);
      return { functions: [], partlyMeasured: [], unmeasuredFiles: 0 };
    };

    await crawler.crawl("token", repoId);

    expect(seen).toEqual(["Analysing code"]);
  });

  it("leaves the crawl idle, stores the error and still disposes when the analyser fails", async () => {
    analyser.failWith = new Error("lizard crashed");

    await crawler.crawl("token", repoId);

    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlError: null });
    expect(store.counts(repoId).pullRequests).toBe(1);
    expect(store.latestCodeSnapshot(repoId)).toMatchObject({ error: "lizard crashed", functions: [] });
    expect(checkout.disposed).toHaveLength(1);
  });

  it("stores the error when the clone fails, with nothing to dispose", async () => {
    checkout.failWith = new NotFoundError("no such branch");

    await crawler.crawl("token", repoId);

    expect(store.latestCodeSnapshot(repoId)).toMatchObject({ error: "no such branch" });
    expect(analyser.analysed).toEqual([]);
    expect(store.getRepo(repoId)!.crawlStatus).toBe("idle");
  });

  it("explains that lizard is missing without cloning", async () => {
    analyser.reachIs = "none";

    await crawler.crawl("token", repoId);

    expect(store.latestCodeSnapshot(repoId)!.error).toBe(ANALYSER_MISSING);
    expect(checkout.requests).toEqual([]);
  });

  it("does not fail the crawl when the store cannot keep the snapshot", async () => {
    store.saveCodeSnapshot = () => {
      throw new Error("disk full");
    };

    await expect(crawler.crawl("token", repoId)).resolves.toBeUndefined();

    expect(store.getRepo(repoId)!.crawlStatus).toBe("idle");
  });

  it("does nothing when the crawler has no code health service", async () => {
    await new CrawlService(store, provider).crawl("token", repoId);

    expect(store.latestCodeSnapshot(repoId)).toBeNull();
    expect(checkout.requests).toEqual([]);
  });
});

describe("CodeHealthService.report", () => {
  let store: SqliteRepoStore;
  let service: CodeHealthService;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    service = new CodeHealthService(store, new FakeSourceCheckout(), new FakeCodeAnalyser(), () => NOW);
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("says there is nothing yet before any analysis", () => {
    expect(service.report(repoId)).toEqual({ status: "none" });
  });

  it("summarises the latest snapshot", () => {
    store.saveCodeSnapshot(repoId, { commitSha: "old", analysedAt: "2026-09-01T00:00:00Z", functions: [fn({ ccn: 1 })] });
    store.saveCodeSnapshot(repoId, {
      commitSha: "new",
      analysedAt: "2026-09-02T00:00:00Z",
      functions: [fn({ ccn: 4 }), fn({ ccn: 12 })],
    });

    expect(service.report(repoId)).toMatchObject({ status: "ok", commitSha: "new", functions: 2, ccn: { max: 12 } });
  });

  it("reports a stored error with its time", () => {
    store.saveCodeSnapshot(repoId, { commitSha: "", analysedAt: "2026-09-03T00:00:00Z", functions: [], error: "nope" });

    expect(service.report(repoId)).toEqual({
      status: "error",
      message: "nope",
      analysedAt: "2026-09-03T00:00:00Z",
      reason: "failed",
    });
  });

  it("refuses an unknown repository", async () => {
    expect(() => service.report(99)).toThrow(NotFoundError);
    await expect(service.analyse("t", 99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records that analysis is off when no adapters were given", async () => {
    const off = new CodeHealthService(store, null, null, () => NOW);

    expect((await off.analyse("t", repoId)).error).toBe(ANALYSIS_OFF);
  });
});

describe("code snapshot store", () => {
  it("round trips, keeps history and is removed with the repository", () => {
    const store = new SqliteRepoStore(":memory:");
    const id = store.addRepo("acme", "widgets", [], "main").id;
    const first: CodeSnapshot = { commitSha: "a", analysedAt: "2026-09-01T00:00:00Z", functions: [fn()] };
    const second: CodeSnapshot = { commitSha: "b", analysedAt: "2026-09-02T00:00:00Z", functions: [], error: "x" };
    expect(store.latestCodeSnapshot(id)).toBeNull();

    store.saveCodeSnapshot(id, second);
    store.saveCodeSnapshot(id, first);

    expect(store.latestCodeSnapshot(id)).toEqual(second);
    store.deleteRepo(id);
    expect(store.latestCodeSnapshot(id)).toBeNull();
  });
});

describe("code health route", () => {
  let app: FastifyInstance;
  let store: SqliteRepoStore;
  let crawler: CrawlService;
  let checkout: FakeSourceCheckout;
  let analyser: FakeCodeAnalyser;

  beforeEach(() => {
    analyser = new FakeCodeAnalyser();
  });

  const build = async (codeAnalysis: boolean) => {
    const provider = new FakeProvider();
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })], workflows: ["deploy.yml"] });
    checkout = new FakeSourceCheckout();
    store = new SqliteRepoStore(":memory:");
    ({ app, crawler } = await buildApp({
      config: config({ codeAnalysis }),
      store,
      provider,
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
      checkout,
      analyser,
    }));
  };

  afterEach(() => app.close());

  it("returns none, then the report once a crawl has analysed the code", async () => {
    await build(true);
    const created = await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "acme/widgets" } });
    const { id } = created.json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    const res = await app.inject(`/api/repos/${id}/code-health`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", functions: 1, nloc: 12, commitSha: "abc1234" });
  });

  it("includes the partly measured files in the response", async () => {
    analyser.partlyMeasured = ["src/Tile.tsx"];
    await build(true);
    const created = await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "acme/widgets" } });
    const { id } = created.json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    const res = await app.inject(`/api/repos/${id}/code-health`);

    expect(res.json()).toMatchObject({ status: "ok", partlyMeasured: ["src/Tile.tsx"] });
  });

  it("returns none before any analysis", async () => {
    await build(true);
    const id = store.addRepo("acme", "widgets", [], "main").id;

    expect((await app.inject(`/api/repos/${id}/code-health`)).json()).toEqual({ status: "none" });
  });

  it("does not clone when analysis is off", async () => {
    await build(false);
    const created = await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "acme/widgets" } });
    const { id } = created.json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    expect(checkout.requests).toEqual([]);
    expect((await app.inject(`/api/repos/${id}/code-health`)).json()).toEqual({ status: "none" });
  });

  it("answers 404 for an unknown repository and 400 for a bad id", async () => {
    await build(true);

    expect((await app.inject("/api/repos/99/code-health")).statusCode).toBe(404);
    expect((await app.inject("/api/repos/abc/code-health")).statusCode).toBe(400);
  });
});

describe("CODE_ANALYSIS config", () => {
  it.each([
    [{}, true],
    [{ CODE_ANALYSIS: "on" }, true],
    [{ CODE_ANALYSIS: "off" }, false],
    [{ CODE_ANALYSIS: "OFF" }, false],
  ])("%j gives %s", (env, expected) => {
    expect(loadConfig(env).codeAnalysis).toBe(expected);
  });
});

describe("parseLizardCsv", () => {
  // Columns: nloc, ccn, token, param, length, location, file, function, long_name, start, end
  const csv = [
    '5,2,30,1,6,"add@10-15@./src/math.ts","./src/math.ts","add","add( a , b )",10,15',
    '12,9,80,3,14,"say@3-16@/work/clone/app/main.py","/work/clone/app/main.py","say","say( self , a , b )",3,16',
    '4,1,20,0,4,"a,b@1-4@./x.go","./x.go","weird, name","weird, name( )",1,4',
    '3,1,10,0,3,"q@1-3@./y.rb","./y.rb","say "hi"","say "hi", x( )",1,3',
    "",
    "not a row",
    'x,1,2,3,4,"l","./bad.ts","f","f()",1,2',
  ].join("\n");

  it("reads columns in lizard's order with paths relative to the clone", () => {
    const parsed = parseLizardCsv(csv, "/work/clone");

    expect(parsed[0]).toEqual({
      file: "src/math.ts",
      language: "TypeScript",
      name: "add",
      startLine: 10,
      ccn: 2,
      nloc: 5,
      params: 1,
    });
    expect(parsed[1]).toEqual({
      file: "app/main.py",
      language: "Python",
      name: "say",
      startLine: 3,
      ccn: 9,
      nloc: 12,
      params: 3,
    });
  });

  it("tolerates commas and the unescaped quotes lizard emits inside quoted fields", () => {
    const parsed = parseLizardCsv(csv, "/work/clone");

    expect(parsed[2]).toMatchObject({ name: "weird, name", language: "Go" });
    expect(parsed[3]).toMatchObject({ name: 'say "hi"', language: "Ruby" });
  });

  it("skips blank and malformed rows", () => {
    expect(parseLizardCsv(csv, "/work/clone")).toHaveLength(4);
    expect(parseLizardCsv("", "/x")).toEqual([]);
  });

  it.each([
    ["a.TSX", "TypeScript"],
    ["lib/b.cpp", "C++"],
    ["c.zzz", "ZZZ"],
    ["Makefile", "Other"],
    ["lib.d/Makefile", "Other"],
  ])("infers the language of %s as %s", (file, language) => {
    expect(languageOf(file)).toBe(language);
  });
});

describe("LizardAnalyser", () => {
  it("runs lizard inside the clone with the exclusions and parses its output", async () => {
    const calls: { file: string; args: string[]; cwd?: string }[] = [];
    const analyser = new LizardAnalyser([], async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return { stdout: '5,2,30,1,6,"add@1-6@./a.ts","./a.ts","add","add( a )",1,6\n' };
    });

    expect((await analyser.analyse("/work/clone")).functions).toEqual([
      { file: "a.ts", language: "TypeScript", name: "add", startLine: 1, ccn: 2, nloc: 5, params: 1 },
    ]);
    expect(calls[0]).toEqual({
      file: "lizard",
      cwd: "/work/clone",
      args: ["--csv", "-x", "*/node_modules/*", "-x", "*/vendor/*", "-x", "*/dist/*", "-x", "*/build/*", "-x", "*.min.js", "."],
    });
  });

  it("leaves the extensions it is told to skip to another analyser, and reports nothing as partly measured", async () => {
    const calls: string[][] = [];
    const analyser = new LizardAnalyser(["ts", "tsx"], async (_file, args) => {
      calls.push(args);
      return { stdout: "" };
    });

    expect(await analyser.analyse("/work/clone")).toEqual({ functions: [], partlyMeasured: [], unmeasuredFiles: 0 });
    expect(calls[0]).toEqual([
      "--csv",
      ...["*/node_modules/*", "*/vendor/*", "*/dist/*", "*/build/*", "*.min.js", "*.[tT][sS]", "*.[tT][sS][xX]"].flatMap((x) => [
        "-x",
        x,
      ]),
      ".",
    ]);
  });

  it("turns an output overflow into a clear error that does not quote the buffer", async () => {
    const overflow = new LizardAnalyser([], async () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    });

    await expect(overflow.analyse("/work/clone")).rejects.toThrow("This repository is too large to analyse.");
  });

  it("stops after ten minutes, with SIGKILL and a 64 MiB buffer, and says so", async () => {
    let options: LizardExecOptions | undefined;
    const hung = new LizardAnalyser([], async (_f, _a, o) => {
      options = o;
      throw Object.assign(new Error("timed out"), { killed: true });
    });

    await expect(hung.analyse("/work/clone")).rejects.toThrow("Lizard took longer than 10 minutes and was stopped.");
    expect(options).toMatchObject({ timeout: 600_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  });

  it("passes other failures through", async () => {
    const broken = new LizardAnalyser([], async () => {
      throw new Error("lizard exploded");
    });

    await expect(broken.analyse("/work/clone")).rejects.toThrow("lizard exploded");
  });

  it("reaches everything when `lizard --version` succeeds", async () => {
    const calls: string[][] = [];
    const analyser = new LizardAnalyser([], async (_file, args) => {
      calls.push(args);
      return { stdout: "1.24.0" };
    });

    expect(await analyser.reach()).toBe("full");
    expect(calls).toEqual([["--version"]]);
  });

  it("reaches nothing when lizard cannot be found", async () => {
    const missing = new LizardAnalyser([], async () => {
      throw Object.assign(new Error("spawn lizard ENOENT"), { code: "ENOENT" });
    });

    expect(await missing.reach()).toBe("none");
  });

  it("says its tool is missing, rather than failing, when lizard cannot be found as it runs", async () => {
    const cause = Object.assign(new Error("spawn lizard ENOENT"), { code: "ENOENT" });
    const missing = new LizardAnalyser([], async () => {
      throw cause;
    });

    const error = await missing.analyse("/clone").then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(AnalyserMissingError);
    expect(error?.message).toBe("Lizard was not found on the API's PATH.");
    expect(error?.cause).toBe(cause);
  });

  it.each([
    ["a non-zero exit", Object.assign(new Error("Command failed"), { code: 1 })],
    ["the thirty second timeout", Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL" })],
    ["a spawn that is refused", Object.assign(new Error("spawn lizard EACCES"), { code: "EACCES" })],
    ["a spawn that runs out of processes", Object.assign(new Error("spawn lizard EAGAIN"), { code: "EAGAIN" })],
  ])("rejects, keeping the cause, when lizard was found but failed with %s", async (_label, failure) => {
    const broken = new LizardAnalyser([], async () => {
      throw failure;
    });

    const error = await broken.reach().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toBe(
      "Lizard was found but did not run. Check that `lizard --version` works on the machine that runs the API.",
    );
    expect(error?.cause).toBe(failure);
  });

  it("measures the extensions lizard reads, except the ones it is told to skip and minified files", () => {
    const analyser = new LizardAnalyser(["ts", "js"]);

    expect(analyser.measures("app/main.py")).toBe(true);
    expect(analyser.measures("app/Main.PY")).toBe(true);
    expect(analyser.measures("src/view.vue")).toBe(true);
    expect(analyser.measures("src/a.ts")).toBe(false);
    expect(analyser.measures("src/Legacy.JS")).toBe(false);
    expect(analyser.measures("src/b.tsx")).toBe(true);
    expect(analyser.measures("public/app.min.js")).toBe(false);
    expect(new LizardAnalyser().measures("public/app.min.js")).toBe(false);
    expect(new LizardAnalyser().measures("src/a.js")).toBe(true);
    expect(analyser.measures("README.md")).toBe(false);
    expect(analyser.measures("Makefile")).toBe(false);
    expect(analyser.measures("notes.dart")).toBe(false);
  });

  it("knows exactly the extensions of lizard 1.24.0", () => {
    expect(LIZARD_EXTENSIONS.size).toBe(55);
    expect([...LIZARD_EXTENSIONS].filter((e) => ["ts", "tsx", "jsx", "mjs", "cjs", "js"].includes(e)).sort()).toEqual([
      "cjs",
      "js",
      "jsx",
      "mjs",
      "ts",
      "tsx",
    ]);
    // Lizard does not read .mts or .cts, so no analyser measures them but the Babel one.
    expect(LIZARD_EXTENSIONS.has("mts")).toBe(false);
  });
});

describe("GitCheckout", () => {
  const TOKEN = "tok-123";
  const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  const calls: { args: string[]; options: GitExecOptions }[] = [];
  const exec: GitExec = async (_file, args, options) => {
    calls.push({ args, options });
    if (args.includes("rev-parse")) return { stdout: "deadbeef\n", stderr: "" };
    if (args.includes("ls-remote")) return { stdout: "cafe01\trefs/heads/main\nbeef02\trefs/heads/other\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const roots: string[] = [];
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "dora-test-"));
    roots.push(root);
    return root;
  };
  beforeEach(() => void (calls.length = 0));
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

  it("clones shallowly with the token only in the child's environment, and disposes of the directory", async () => {
    const result = await new GitCheckout("https://github.com", exec, tempRoot()).checkout(TOKEN, "acme", "widgets", "main");

    expect(result.commitSha).toBe("deadbeef");
    const clone = calls[0]!;
    expect(clone.args).toEqual([
      "-c",
      "protocol.file.allow=never",
      "-c",
      "http.followRedirects=false",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--branch",
      "main",
      "--",
      "https://github.com/acme/widgets.git",
      result.dir,
    ]);
    for (const call of calls) {
      expect(call.args.filter((a) => a.includes(TOKEN) || a.includes(BASIC))).toEqual([]);
    }
    expect(clone.options.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(clone.options.timeout).toBe(300_000);
    expect(calls[1]!.args).toEqual(["-C", result.dir, "rev-parse", "HEAD"]);
    expect(calls[1]!.options.env.GIT_CONFIG_VALUE_0).toBeUndefined();

    const root = dirname(result.dir);
    expect(existsSync(root)).toBe(true);
    await result.dispose();
    expect(existsSync(root)).toBe(false);
    await expect(result.dispose()).resolves.toBeUndefined();
  });

  it("reads a branch head with ls-remote, using the same header and a timeout", async () => {
    const sha = await new GitCheckout("https://github.com", exec, tempRoot()).headSha(TOKEN, "acme", "widgets", "main");

    expect(sha).toBe("cafe01");
    expect(calls[0]!.args).toEqual([
      "-c",
      "protocol.file.allow=never",
      "-c",
      "http.followRedirects=false",
      "ls-remote",
      "--",
      "https://github.com/acme/widgets.git",
      "refs/heads/main",
    ]);
    expect(calls[0]!.args.filter((a) => a.includes(TOKEN) || a.includes(BASIC))).toEqual([]);
    expect(calls[0]!.options.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${BASIC}`);
    expect(calls[0]!.options.timeout).toBe(60_000);
  });

  it("raises NotFoundError when ls-remote lists no such branch", async () => {
    const empty: GitExec = async () => ({ stdout: "", stderr: "" });

    await expect(
      new GitCheckout("https://github.com", empty, tempRoot()).headSha(TOKEN, "acme", "widgets", "gone"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removes the directory and scrubs the token from the error when the clone fails", async () => {
    let dir = "";
    const failing: GitExec = async (_f, args) => {
      dir = args.at(-1)!;
      throw Object.assign(new Error(`Command failed: git ${BASIC}`), { stderr: `fatal: bad credentials ${BASIC} ${TOKEN}` });
    };

    const error = await new GitCheckout("https://github.com", failing, tempRoot())
      .checkout(TOKEN, "acme", "widgets", "main")
      .catch((e) => e);

    expect(error.message).toContain("bad credentials *** ***");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(BASIC);
    expect(existsSync(dirname(dir))).toBe(false);
  });

  it("turns a timeout into an upstream error, cleans up, and stores it as an analysis error", async () => {
    const hung: GitExec = async () => {
      throw Object.assign(new Error(`Command failed: git ${BASIC}`), { killed: true, signal: "SIGKILL" });
    };
    const root = tempRoot();
    const store = new SqliteRepoStore(":memory:");
    const id = store.addRepo("acme", "widgets", [], "main").id;
    const service = new CodeHealthService(
      store,
      new GitCheckout("https://github.com", hung, root),
      new FakeCodeAnalyser(),
      () => NOW,
    );

    const snapshot = await service.analyse(TOKEN, id);

    expect(snapshot.error).toBe("git was stopped after 5 minute(s) without finishing");
    expect(store.latestCodeSnapshot(id)!.error).toBe(snapshot.error);
    expect(readdirSync(root)).toEqual([]);
  });

  it("maps a missing branch to NotFoundError", async () => {
    const missing: GitExec = async () => {
      throw Object.assign(new Error("x"), { stderr: "fatal: Remote branch nope not found in upstream origin" });
    };

    await expect(
      new GitCheckout("https://github.com", missing, tempRoot()).checkout(TOKEN, "acme", "widgets", "nope"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("explains when git cannot be run at all", async () => {
    const broken: GitExec = async () => {
      throw new Error("spawn git ENOENT");
    };

    await expect(
      new GitCheckout("https://github.com", broken, tempRoot()).checkout(TOKEN, "acme", "widgets", "main"),
    ).rejects.toThrow("git could not be run");
  });

  it("sweeps stale checkout directories and nothing else", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "dora-checkout-abc", "repo"), { recursive: true });
    mkdirSync(join(root, "dora-checkout-def"));
    mkdirSync(join(root, "unrelated"));

    expect(await new GitCheckout("https://github.com", exec, root).sweepStale()).toBe(2);

    expect(readdirSync(root)).toEqual(["unrelated"]);
  });
});

describe("hardening of the code health service", () => {
  let store: SqliteRepoStore;
  let checkout: FakeSourceCheckout;
  let analyser: FakeCodeAnalyser;
  let logged: { context: object; message: string }[];
  let service: CodeHealthService;
  let repoId: number;
  let clock: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    checkout = new FakeSourceCheckout();
    analyser = new FakeCodeAnalyser();
    logged = [];
    clock = Date.parse("2026-09-01T00:00:00Z");
    // Each call to now() is a minute later, so every snapshot has its own timestamp.
    const now = () => new Date((clock += 60_000));
    service = new CodeHealthService(store, checkout, analyser, now, {
      warn: (context, message) => void logged.push({ context, message }),
      info: () => undefined,
      error: () => undefined,
    });
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("serves the last good figures with lastError after a newer failure", async () => {
    await service.analyse("t", repoId);
    analyser.failWith = new Error("lizard crashed");
    checkout.head = "def5678";
    await service.analyse("t", repoId);

    const report = service.report(repoId);

    expect(report).toMatchObject({ status: "ok", commitSha: "abc1234", functions: 1 });
    expect(report).toHaveProperty("lastError", {
      message: "lizard crashed",
      analysedAt: expect.any(String),
      reason: "failed",
    });
  });

  it("says lizard is missing as a reason, so the page can show how to install it", async () => {
    analyser.reachIs = "none";
    await service.analyse("t", repoId);

    expect(service.report(repoId)).toMatchObject({ status: "error", message: ANALYSER_MISSING, reason: "analyser-missing" });
  });

  it("stores a failure, and keeps serving the last good figures, when finding out what can be measured fails", async () => {
    await service.analyse("t", repoId);
    analyser.reachFailWith = new Error("Lizard was found but did not run.");
    checkout.head = "def5678";

    await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
    expect(service.report(repoId)).toMatchObject({
      status: "ok",
      commitSha: "abc1234",
      functions: 1,
      lastError: { message: "Lizard was found but did not run.", reason: "failed" },
    });
    expect(logged.map((l) => l.message)).toEqual(["code analysis failed"]);
  });

  it("analyses the same head again when files were left unmeasured and every tool is now found", async () => {
    analyser.reachIs = "partial";
    analyser.unmeasuredFiles = 3;
    await service.analyse("t", repoId);
    expect(checkout.requests).toHaveLength(1);

    analyser.reachIs = "full";
    analyser.unmeasuredFiles = 0;
    const again = await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(2);
    expect(again.unmeasuredFiles).toBe(0);
    expect(service.report(repoId)).toMatchObject({ status: "ok", unmeasuredFiles: 0 });
  });

  it("does not analyse the same head again while a tool is still missing", async () => {
    analyser.reachIs = "partial";
    analyser.unmeasuredFiles = 3;
    await service.analyse("t", repoId);

    await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
    expect(analyser.analysed).toHaveLength(1);
  });

  it("does not analyse the same head again when nothing was left unmeasured, even with every tool found", async () => {
    await service.analyse("t", repoId);
    await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
  });

  it("warns, with the repository and the count, when a new analysis leaves files unmeasured", async () => {
    analyser.reachIs = "partial";
    analyser.unmeasuredFiles = 4;

    await service.analyse("t", repoId);

    expect(logged).toEqual([{ context: { repoId, unmeasuredFiles: 4 }, message: expect.stringContaining("left unmeasured") }]);
  });

  it("keeps the missing-lizard reason on lastError when older figures are served", async () => {
    await service.analyse("t", repoId);
    analyser.reachIs = "none";
    checkout.head = "def5678";
    await service.analyse("t", repoId);

    expect(service.report(repoId)).toMatchObject({ status: "ok", lastError: { reason: "analyser-missing" } });
  });

  it("gives switching analysis off its own reason", async () => {
    const off = new CodeHealthService(store, null, null, () => new Date("2026-09-02T00:00:00Z"));
    await off.analyse("t", repoId);

    expect(off.report(repoId)).toMatchObject({ status: "error", message: ANALYSIS_OFF, reason: "analysis-off" });
  });

  it("omits lastError once a later analysis succeeds", async () => {
    analyser.failWith = new Error("boom");
    await service.analyse("t", repoId);
    expect(service.report(repoId)).toMatchObject({ status: "error", message: "boom" });
    analyser.failWith = null;
    await service.analyse("t", repoId);

    expect("lastError" in service.report(repoId)).toBe(false);
  });

  it("logs analysis failures instead of swallowing them", async () => {
    analyser.failWith = new Error("lizard crashed");

    await service.analyse("t", repoId);

    expect(logged).toEqual([{ context: expect.objectContaining({ repoId }), message: "code analysis failed" }]);
  });

  it("keeps a finished analysis when the clone cannot be removed, and logs it", async () => {
    checkout.disposeFailWith = new Error("EBUSY");

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.error).toBeNull();
    expect(snapshot.functions).toHaveLength(1);
    expect(logged.map((l) => l.message)).toEqual(["could not remove the checkout"]);
  });

  it("skips the clone when the branch head is the commit already analysed", async () => {
    await service.analyse("t", repoId);
    const again = await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
    expect(checkout.headChecks).toBe(1);
    expect(again.commitSha).toBe("abc1234");
  });

  it("clones again when the head moved, when forced, or when the last attempt failed", async () => {
    await service.analyse("t", repoId);
    checkout.head = "def5678";
    await service.analyse("t", repoId);
    expect(checkout.requests).toHaveLength(2);

    await service.analyse("t", repoId, true);
    expect(checkout.requests).toHaveLength(3);

    analyser.failWith = new Error("boom");
    await service.analyse("t", repoId, true);
    analyser.failWith = null;
    const headChecks = checkout.headChecks;
    await service.analyse("t", repoId);
    expect(checkout.requests).toHaveLength(5);
    expect(checkout.headChecks).toBe(headChecks);
  });

  it("analyses anyway, and logs, when the head cannot be read", async () => {
    await service.analyse("t", repoId);
    checkout.headFailWith = new Error("network down");

    await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(2);
    expect(logged.map((l) => l.message)).toEqual(["could not read the branch head; analysing anyway"]);
  });

  it("re-analyses on a full crawl even when the head is unchanged", async () => {
    const provider = new FakeProvider();
    provider.seed("acme/widgets", {});
    const crawler = new CrawlService(store, provider, service);
    await crawler.crawl("t", repoId);
    await crawler.crawl("t", repoId);
    expect(checkout.requests).toHaveLength(1);

    await crawler.crawl("t", repoId, true);

    expect(checkout.requests).toHaveLength(2);
  });

  it("logs when the code health step itself fails during a crawl", async () => {
    const provider = new FakeProvider();
    provider.seed("acme/widgets", {});
    store.saveCodeSnapshot = () => {
      throw new Error("disk full");
    };
    const crawler = new CrawlService(store, provider, service, {
      warn: (context, message) => void logged.push({ context, message }),
      info: () => undefined,
      error: () => undefined,
    });

    await crawler.crawl("t", repoId);

    expect(logged.map((l) => l.message)).toEqual(["code health step failed"]);
  });
});

describe("snapshot pruning", () => {
  const db = (store: SqliteRepoStore) => (store as unknown as { db: DatabaseSync }).db;
  const count = (store: SqliteRepoStore, id: number) =>
    (db(store).prepare("SELECT count(*) AS n FROM code_snapshots WHERE repo_id = ?").get(id) as { n: number }).n;
  const at = (n: number) => new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString();

  it("keeps only the newest ten per repository", () => {
    const store = new SqliteRepoStore(":memory:");
    const a = store.addRepo("acme", "widgets", [], "main").id;
    const b = store.addRepo("acme", "gadgets", [], "main").id;
    store.saveCodeSnapshot(b, { commitSha: "b", analysedAt: at(0), functions: [] });
    for (let i = 0; i < 15; i++) store.saveCodeSnapshot(a, { commitSha: `c${i}`, analysedAt: at(i), functions: [] });

    expect(count(store, a)).toBe(10);
    expect(store.latestCodeSnapshot(a)!.commitSha).toBe("c14");
    expect(count(store, b)).toBe(1);
  });

  it("never prunes the newest successful snapshot, even under a run of failures", () => {
    const store = new SqliteRepoStore(":memory:");
    const id = store.addRepo("acme", "widgets", [], "main").id;
    store.saveCodeSnapshot(id, { commitSha: "good", analysedAt: at(0), functions: [] });
    for (let i = 1; i <= 12; i++) {
      store.saveCodeSnapshot(id, { commitSha: "", analysedAt: at(i), functions: [], error: "boom" });
    }

    expect(count(store, id)).toBe(11);
    expect(store.latestSuccessfulCodeSnapshot(id)!.commitSha).toBe("good");
    expect(store.latestCodeSnapshot(id)!.error).toBe("boom");
  });
});

describe("branch and repository validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildApp({
      config: config(),
      store: new SqliteRepoStore(":memory:"),
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
    }));
  });
  afterEach(() => app.close());

  it.each(["--upload-pack=x", "-x", "has space", "tab\there", "line\nbreak"])("rejects the branch %j", async (deployBranch) => {
    const res = await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "acme/widgets", deployBranch } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unsafe branch on configure too", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/1",
      payload: { deployWorkflows: [], deployBranch: "--upload-pack=x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(["release/1.2", "main", "feature_x-y"])("accepts the branch %s", (branch) => {
    expect(isSafeBranch(branch)).toBe(true);
  });

  it("refuses an unsafe branch reaching the service directly", () => {
    const repos = new RepoService(new SqliteRepoStore(":memory:"), new FakeProvider());
    expect(() => repos.configure(1, [], "--upload-pack=x")).toThrow();
  });

  it.each(["../widgets", "acme/..", "./widgets"])("rejects %s as a repository", (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });
});
