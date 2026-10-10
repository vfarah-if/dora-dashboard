import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { CodeSnapshot, PullRequest } from "@dora-dashboard/core";
import { CODE_SNAPSHOT_VERSION } from "@dora-dashboard/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ValidationError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { FsWorkspaceReader } from "../src/infrastructure/fs/fs-workspace-reader.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { CodeHealthService } from "../src/services/code-health-service.js";
import { config, FakeCli, FakeCodeAnalyser, FakeProvider, FakeSourceCheckout, FakeWorkspaceReader, fn, pr } from "./fakes.js";

describe("FsWorkspaceReader", () => {
  let root: string;
  let outside: string;
  const reader = new FsWorkspaceReader();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dora-reader-"));
    outside = mkdtempSync(join(tmpdir(), "dora-outside-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"acme"}');
    writeFileSync(join(root, "src", "index.ts"), "export {};");
    writeFileSync(join(root, ".git", "config"), "[core]");
    writeFileSync(join(root, "node_modules", "dep", "package.json"), "{}");
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: CI");
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "linked-file.txt"));
    symlinkSync(outside, join(root, "linked-dir"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lists regular files with relative paths, skipping symlinks and vendored directories", async () => {
    expect(await reader.list(root)).toEqual([".github/workflows/ci.yml", "package.json", "src/index.ts"]);
  });

  it("does not read through a symlink to a directory that stays inside the clone", async () => {
    symlinkSync(join(root, "src"), join(root, "alias"));

    expect(await reader.read(root, "alias/index.ts", 1000)).toBeNull();
    expect(await reader.list(root)).not.toContain("alias/index.ts");
  });

  it("reads a file inside the clone", async () => {
    expect(await reader.read(root, "package.json", 1000)).toBe('{"name":"acme"}');
    expect(await reader.read(root, "src/index.ts", 1000)).toBe("export {};");
  });

  it("returns null for a missing file, a directory and a file over the size cap", async () => {
    expect(await reader.read(root, "nope.json", 1000)).toBeNull();
    expect(await reader.read(root, "src", 1000)).toBeNull();
    expect(await reader.read(root, "package.json", 5)).toBeNull();
  });

  it("does not follow a symlinked file, even one pointing outside the clone", async () => {
    expect(await reader.read(root, "linked-file.txt", 1000)).toBeNull();
  });

  it("does not read through a symlinked directory", async () => {
    expect(await reader.read(root, "linked-dir/secret.txt", 1000)).toBeNull();
  });

  it.each(["../secret.txt", "src/../../secret.txt", "/etc/hosts", "a\0b"])("refuses the path %j", async (path) => {
    await expect(reader.read(root, path, 1000)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("FsWorkspaceReader file names with a backslash", () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "dora-backslash-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // On POSIX a backslash is an ordinary character in a file name, so this file is legal and sits inside the clone.
  it.skipIf(sep === "\\")("lists and reads a file literally named ..\\evil.ts without refusing the analysis", async () => {
    writeFileSync(join(root, "..\\evil.ts"), "export const a = 1;");
    const reader = new FsWorkspaceReader();

    expect(await reader.list(root)).toEqual(["..\\evil.ts"]);
    expect(await reader.read(root, "..\\evil.ts", 1000)).toBe("export const a = 1;");
  });

  it.skipIf(sep === "\\")("still refuses a real parent segment next to a backslash name", async () => {
    await expect(new FsWorkspaceReader().read(root, "a\\b/../../x", 1000)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("FsWorkspaceReader limits", () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "dora-limits-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stops after the entry cap, counting directories as well as files", async () => {
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    for (const name of ["a/1", "a/2", "b/1", "b/2", "z1", "z2"]) writeFileSync(join(root, name), "x");

    const all = await new FsWorkspaceReader({ maxEntries: 100, maxDepth: 5 }).list(root);
    const capped = await new FsWorkspaceReader({ maxEntries: 3, maxDepth: 5 }).list(root);

    expect(all).toHaveLength(6);
    expect(capped.length).toBeLessThan(3); // two directories and one file used the three visits
  });

  it("warns once, naming the limit, when the entry cap cuts the listing short", async () => {
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, name), "x");
    const warnings: { context: object; message: string }[] = [];
    const log = {
      info: () => undefined,
      error: () => undefined,
      warn: (context: object, message: string) => void warnings.push({ context, message }),
    };

    const listed = await new FsWorkspaceReader({ maxEntries: 2, maxDepth: 5 }, log).list(root);

    expect(listed).toHaveLength(2);
    expect(warnings).toEqual([
      { context: { dir: root, limit: "2 entries", listed: 2 }, message: expect.stringContaining("left out") },
    ]);
  });

  it("warns once, naming the limit, when the depth cap cuts the listing short", async () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "deep"), "x");
    writeFileSync(join(root, "top"), "x");
    const warnings: { context: object }[] = [];
    const log = { info: () => undefined, error: () => undefined, warn: (context: object) => void warnings.push({ context }) };

    await new FsWorkspaceReader({ maxEntries: 100, maxDepth: 1 }, log).list(root);

    expect(warnings).toEqual([{ context: { dir: root, limit: "depth of 1 directories", listed: 1 } }]);
  });

  it("warns once for a directory one analysis lists several times, and again for the next directory", async () => {
    const other = join(root, "other");
    mkdirSync(other);
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(root, name), "x");
      writeFileSync(join(other, name), "x");
    }
    const warned: string[] = [];
    const log = {
      info: () => undefined,
      error: () => undefined,
      warn: (context: object) => void warned.push((context as { dir: string }).dir),
    };
    const reader = new FsWorkspaceReader({ maxEntries: 2, maxDepth: 5 }, log);

    await reader.list(root);
    await reader.list(root);
    await reader.list(other);

    expect(warned).toEqual([root, other]);
  });

  it("does not warn when the listing is complete", async () => {
    writeFileSync(join(root, "a"), "x");
    const warnings: object[] = [];
    const log = { info: () => undefined, error: () => undefined, warn: (context: object) => void warnings.push(context) };

    await new FsWorkspaceReader({ maxEntries: 1, maxDepth: 1 }, log).list(root);

    expect(warnings).toEqual([]);
  });

  it("does not descend past the depth cap", async () => {
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    for (const name of ["top", "a/one", "a/b/two", "a/b/c/three"]) writeFileSync(join(root, name), "x");

    expect(await new FsWorkspaceReader({ maxEntries: 100, maxDepth: 1 }).list(root)).toEqual(["a/one", "top"]);
  });

  it("skips vendored directories by name at any depth", async () => {
    mkdirSync(join(root, "pkg", "node_modules"), { recursive: true });
    mkdirSync(join(root, "pkg", "src", "vendor"), { recursive: true });
    for (const name of ["pkg/node_modules/x", "pkg/src/vendor/y", "pkg/src/z"]) writeFileSync(join(root, name), "x");

    expect(await new FsWorkspaceReader().list(root)).toEqual(["pkg/src/z"]);
  });

  it("carries on past a directory it cannot read", async () => {
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "locked", "hidden"), "x");
    writeFileSync(join(root, "open"), "x");
    chmodSync(join(root, "locked"), 0o000);
    try {
      expect(await new FsWorkspaceReader().list(root)).toEqual(["open"]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});

describe("tooling in the code health service", () => {
  let store: SqliteRepoStore;
  let checkout: FakeSourceCheckout;
  let reader: FakeWorkspaceReader;
  let logged: string[];
  let service: CodeHealthService;
  let repoId: number;
  let tick: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    checkout = new FakeSourceCheckout();
    reader = new FakeWorkspaceReader();
    logged = [];
    tick = Date.parse("2026-09-01T00:00:00Z");
    service = new CodeHealthService(
      store,
      checkout,
      new FakeCodeAnalyser(),
      () => new Date((tick += 60_000)),
      { info: () => undefined, warn: (_c, message) => void logged.push(message), error: () => undefined },
      reader,
    );
    repoId = store.addRepo("acme", "widgets", [], "main").id;
    reader.files.set(".prettierrc.json", "{}");
    reader.files.set("src/index.ts", "export {};");
    reader.files.set(".github/workflows/ci.yml", "steps:\n  - run: npx prettier --check .\n  - run: npx vitest run\n");
  });

  it("stores tooling facts and the snapshot version, reading only candidate files", async () => {
    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.snapshotVersion).toBe(CODE_SNAPSHOT_VERSION);
    expect(snapshot.tooling).toMatchObject({
      formatters: ["prettier"],
      ciFormatChecks: ["prettier"],
      ciRunsTests: true,
      linters: [],
    });
    expect(reader.reads.sort()).toEqual([".github/workflows/ci.yml", ".prettierrc.json"]);
    expect(store.latestCodeSnapshot(repoId)!.tooling).toEqual(snapshot.tooling);
  });

  it("re-analyses a snapshot of an older version even when the head has not moved", async () => {
    const old: CodeSnapshot = { commitSha: "abc1234", analysedAt: "2026-08-01T00:00:00Z", functions: [fn()], error: null };
    store.saveCodeSnapshot(repoId, old);

    const fresh = await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
    expect(fresh.snapshotVersion).toBe(CODE_SNAPSHOT_VERSION);
    expect(fresh.tooling).not.toBeNull();
  });

  it("skips the clone once the snapshot is current and the head is unchanged", async () => {
    await service.analyse("t", repoId);
    await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
  });

  it("keeps the complexity figures and logs when the files cannot be read", async () => {
    reader.listFailWith = new Error("EIO");

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.error).toBeNull();
    expect(snapshot.functions).toHaveLength(1);
    expect(snapshot.tooling).toBeNull();
    expect(logged).toEqual(["could not read the repository's tooling files"]);
  });

  it("lists the clone once and stores its code files and manifests, sorted, tests included", async () => {
    reader.files.set("packages/core/package.json", "{}");
    reader.files.set("packages/core/src/a.ts", "export {};");
    reader.files.set("packages/core/test/a.test.ts", "export {};");
    reader.files.set("README.md", "# Widgets");
    let lists = 0;
    const list = reader.list.bind(reader);
    reader.list = async () => (lists++, list());

    const snapshot = await service.analyse("t", repoId);

    expect(lists).toBe(1);
    expect(snapshot.files).toEqual(["packages/core/src/a.ts", "packages/core/test/a.test.ts", "src/index.ts"]);
    expect(snapshot.layout).toEqual({ manifests: ["packages/core/package.json"], workspaces: null });
    expect(store.latestCodeSnapshot(repoId)).toMatchObject({ files: snapshot.files, layout: snapshot.layout });
  });

  it("reads the root files that declare workspaces, and only those that exist", async () => {
    reader.files.set("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    reader.files.set("pnpm-workspace.yaml", "packages:\n  - 'libs/*'\n");
    reader.files.set("apps/web/package.json", JSON.stringify({ workspaces: ["ignored/*"] }));

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.layout?.workspaces).toEqual(["apps/*", "libs/*"]);
    expect(snapshot.layout?.manifests).toEqual(["apps/web/package.json", "package.json"]);
    expect(reader.reads).not.toContain("lerna.json");
    expect(reader.reads.filter((p) => p === "package.json")).toHaveLength(1);
  });

  it("stores no files or layout when the listing fails, and keeps the complexity figures", async () => {
    reader.listFailWith = new Error("EIO");

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot).not.toHaveProperty("files");
    expect(snapshot).not.toHaveProperty("layout");
    expect(snapshot.tooling).toBeNull();
    expect(snapshot.functions).toHaveLength(1);
  });

  it("keeps the files and the tooling when a workspace file cannot be read", async () => {
    reader.files.set("package.json", "{}");
    const read = reader.read.bind(reader);
    reader.read = async (dir, path, max) => {
      if (path === "package.json") throw new Error("EIO");
      return read(dir, path, max);
    };

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.files).toContain("src/index.ts");
    expect(snapshot.layout).toEqual({ manifests: ["package.json"], workspaces: null });
    expect(logged).toContain("could not read the repository's workspace declaration files");
  });

  it("keeps the files and the layout when a tooling file cannot be read", async () => {
    const read = reader.read.bind(reader);
    reader.read = async (dir, path, max) => {
      if (path === ".prettierrc.json") throw new Error("EIO");
      return read(dir, path, max);
    };

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.tooling).toBeNull();
    expect(snapshot.files).toEqual(["src/index.ts"]);
    expect(snapshot.layout).toEqual({ manifests: [], workspaces: null });
  });

  it("stores no files or layout when there is no reader", async () => {
    const bare = new CodeHealthService(store, checkout, new FakeCodeAnalyser(), () => new Date(), undefined, null);

    const snapshot = await bare.analyse("t", repoId);

    expect(snapshot).not.toHaveProperty("files");
    expect(snapshot).not.toHaveProperty("layout");
  });

  it("records no tooling when there is no reader", async () => {
    const bare = new CodeHealthService(store, checkout, new FakeCodeAnalyser(), () => new Date(), undefined, null);

    expect((await bare.analyse("t", repoId)).tooling).toBeNull();
  });

  it("reports a grade that uses the pull requests in the requested range", async () => {
    store.upsertPullRequests(repoId, [
      pr({ number: 1, mergedAt: "2026-09-05T10:00:00Z", files: ["src/a.ts", "src/a.test.ts"] }),
      pr({ number: 2, mergedAt: "2026-09-06T10:00:00Z", files: ["src/b.ts"] }),
      pr({ number: 3, mergedAt: "2026-07-06T10:00:00Z", files: ["src/c.ts"] }),
      pr({ number: 4, mergedAt: "2026-09-07T10:00:00Z" } as Partial<PullRequest> & { number: number }),
    ]);
    await service.analyse("t", repoId);

    const inRange = service.report(repoId, { from: "2026-09-01", to: "2026-09-30" });
    const everything = service.report(repoId);

    expect(inRange).toMatchObject({ testing: { prsWithTests: { share: 0.5, withTests: 1, total: 2 } } });
    expect(everything).toMatchObject({ testing: { prsWithTests: { withTests: 1, total: 3 } } });
    expect(inRange).toHaveProperty("grade.hygiene.band", "medium"); // formatter and check, no linter
  });

  it("rejects a malformed or inverted range", () => {
    expect(() => service.report(repoId, { from: "yesterday" })).toThrow("from must be a date");
    expect(() => service.report(repoId, { from: "2026-09-30", to: "2026-09-01" })).toThrow("from must not be after to");
  });
});

describe("code health route range", () => {
  let app: FastifyInstance;
  let store: SqliteRepoStore;

  beforeEach(async () => {
    store = new SqliteRepoStore(":memory:");
    const reader = new FakeWorkspaceReader();
    reader.files.set(".prettierrc.json", "{}");
    ({ app } = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
      checkout: new FakeSourceCheckout(),
      analyser: new FakeCodeAnalyser(),
      reader,
    }));
  });
  afterEach(() => app.close());

  it("passes from and to through to prsWithTests", async () => {
    const id = store.addRepo("acme", "widgets", [], "main").id;
    store.saveCodeSnapshot(id, {
      commitSha: "abc",
      analysedAt: "2026-09-10T00:00:00Z",
      functions: [fn()],
      snapshotVersion: CODE_SNAPSHOT_VERSION,
      tooling: {
        linters: [],
        formatters: [],
        weakFormatters: [],
        ciLinters: [],
        ciFormatChecks: [],
        ciRunsTests: false,
        coverageFloor: null,
      },
    });
    store.upsertPullRequests(id, [
      pr({ number: 1, mergedAt: "2026-09-05T10:00:00Z", files: ["src/a.ts", "src/a.test.ts"] }),
      pr({ number: 2, mergedAt: "2026-08-05T10:00:00Z", files: ["src/b.ts"] }),
    ]);

    const inRange = (await app.inject(`/api/repos/${id}/code-health?from=2026-09-01&to=2026-09-30`)).json();
    const all = (await app.inject(`/api/repos/${id}/code-health`)).json();

    expect(inRange.testing.prsWithTests).toEqual({ share: 1, withTests: 1, total: 1 });
    expect(all.testing.prsWithTests).toEqual({ share: 0.5, withTests: 1, total: 2 });
    expect(all.grade.overall.band).toBe("low");
  });

  it("answers 400 for a bad date and for an inverted range", async () => {
    const id = store.addRepo("acme", "widgets", [], "main").id;

    expect((await app.inject(`/api/repos/${id}/code-health?from=nope`)).statusCode).toBe(400);
    expect((await app.inject(`/api/repos/${id}/code-health?from=2026-09-30&to=2026-09-01`)).statusCode).toBe(400);
  });
});
