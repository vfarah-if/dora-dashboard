import { SUPPLY_CHAIN_VERSION } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { CloneView } from "../src/services/clone-inspector.js";
import { CodeHealthService, MAX_INSPECTION_ATTEMPTS } from "../src/services/code-health-service.js";
import { SecurityReportService } from "../src/services/security-report-service.js";
import { SupplyChainService } from "../src/services/supply-chain-service.js";
import {
  FakeCodeAnalyser,
  FakeSourceCheckout,
  FakeWorkspaceReader,
  rawDb,
  supplyChainFacts,
  supplyChainRecord,
} from "./fakes.js";

const NOW = new Date("2026-09-29T10:00:00Z");
const MIB = 1024 * 1024;

const WORKFLOW =
  "name: ci\non: push\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n";
const LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "widgets" },
    "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
  },
});

/** A clone's view over a map of files, recording every read with the cap it was asked for. */
function view(files: Record<string, string>, extra: Partial<CloneView> = {}, blobs: Record<string, string> = {}) {
  const reads: { path: string; maxBytes: number }[] = [];
  const blobAsks: string[][] = [];
  const clone: CloneView = {
    repoId: 1,
    commitSha: "abc1234",
    paths: Object.keys(files),
    listingComplete: true,
    async read(path, maxBytes) {
      reads.push({ path, maxBytes });
      const content = files[path];
      return content === undefined || Buffer.byteLength(content) > maxBytes ? null : content;
    },
    async blobIds(paths) {
      blobAsks.push([...paths]);
      return new Map(paths.flatMap((path) => (path in blobs ? [[path, blobs[path]!] as const] : [])));
    },
    ...extra,
  };
  return { clone, reads, blobAsks };
}

describe("the supply chain inspector", () => {
  let store: SqliteRepoStore;
  let repoId: number;
  let service: SupplyChainService;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
    service = new SupplyChainService(store, () => NOW);
  });

  describe("staleness", () => {
    it("is stale when there is no row", () => {
      expect(service.isStale(repoId, "abc1234")).toBe(true);
    });

    it("is fresh for the commit and version it holds", () => {
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "abc1234" }), []);
      expect(service.isStale(repoId, "abc1234")).toBe(false);
    });

    it("is stale when the head has moved", () => {
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "abc1234" }), []);
      expect(service.isStale(repoId, "def5678")).toBe(true);
    });

    it("is stale, and does not throw, when the stored facts cannot be read", () => {
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "abc1234" }), []);
      rawDb(store).exec("UPDATE supply_chain SET facts = 'nope'");

      expect(service.isStale(repoId, "abc1234")).toBe(true);
    });

    it("is stale when the facts are of this version but a key file has no blob, as the interim build stored them", () => {
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "abc1234" }), []);
      expect(service.isStale(repoId, "abc1234")).toBe(false);
      const row = rawDb(store).prepare("SELECT facts FROM supply_chain").get() as unknown as { facts: string };
      const stored = JSON.parse(row.facts);
      stored.keyFiles = [{ path: ".env", strength: "strong" }];
      rawDb(store).prepare("UPDATE supply_chain SET facts = ?").run(JSON.stringify(stored));

      // The store refuses the record as unreadable and answers none, so the next crawl reads the clone again.
      expect(store.supplyChain(repoId)).toBeNull();
      expect(service.isStale(repoId, "abc1234")).toBe(true);
    });

    it("is stale when the facts were read by another version", () => {
      store.saveSupplyChain(
        repoId,
        supplyChainRecord({ commitSha: "abc1234", facts: supplyChainFacts({ version: SUPPLY_CHAIN_VERSION - 1 }) }),
        [],
      );
      expect(service.isStale(repoId, "abc1234")).toBe(true);
    });
  });

  describe("whether the listing was complete", () => {
    it("stores that the listing was complete, or that it was cut, with the facts", async () => {
      await service.inspect({ ...view({}).clone, repoId });
      expect(store.supplyChain(repoId)!.facts.listingComplete).toBe(true);

      await service.inspect({ ...view({}, { listingComplete: false }).clone, repoId });
      expect(store.supplyChain(repoId)!.facts.listingComplete).toBe(false);
    });
  });

  describe("recording a failure", () => {
    it("stores the message with the time beside the record it leaves alone, and a good inspection clears it", async () => {
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "old1234" }), []);

      service.fail(repoId, "The clone could not be read");

      expect(store.supplyChainFailure(repoId)).toEqual({
        message: "The clone could not be read",
        attemptedAt: NOW.toISOString(),
      });
      expect(store.supplyChain(repoId)!.commitSha).toBe("old1234");

      const { clone } = view({});
      await service.inspect({ ...clone, repoId });

      expect(store.supplyChainFailure(repoId)).toBeNull();
    });
  });

  describe("inspecting", () => {
    it("stores the facts, the commit, the time and the public packages of a lockfile it read", async () => {
      const { clone } = view({
        ".github/workflows/ci.yml": WORKFLOW,
        "package.json": '{"name":"widgets"}',
        "package-lock.json": LOCKFILE,
      });

      await service.inspect({ ...clone, repoId });

      const record = store.supplyChain(repoId)!;
      expect(record).toMatchObject({ commitSha: "abc1234", readAt: "2026-09-29T10:00:00.000Z" });
      expect(record.facts).toMatchObject({
        version: SUPPLY_CHAIN_VERSION,
        workflowsRead: 1,
        workflowsUnread: [],
        dockerfilesUnread: [],
        dockerfilesUnreadTotal: 0,
        lockfiles: [{ path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false }],
      });
      expect(store.lockedPackages(repoId)).toEqual([
        { ecosystem: "npm", name: "lodash", version: "4.17.20", lockfile: "package-lock.json" },
      ]);
    });

    it("asks for 256 KiB of a workflow, a Dockerfile or a tooling file and 16 MiB of a lockfile", async () => {
      const { clone, reads } = view({
        ".github/workflows/ci.yml": WORKFLOW,
        Dockerfile: "FROM node:20\n",
        Makefile: "test:\n\tnpm test\n",
        "package-lock.json": LOCKFILE,
      });

      await service.inspect({ ...clone, repoId });

      const cap = (path: string) => reads.find((r) => r.path === path)?.maxBytes;
      expect(cap(".github/workflows/ci.yml")).toBe(256 * 1024);
      expect(cap("Dockerfile")).toBe(256 * 1024);
      expect(cap("Makefile")).toBe(256 * 1024);
      expect(cap("package-lock.json")).toBe(16 * MIB);
    });

    it("lists a workflow that cannot be read as unread, and a lockfile that cannot be read as unreadable, and still stores a row", async () => {
      const { clone } = view(
        {
          ".github/workflows/ci.yml": WORKFLOW,
          ".github/workflows/big.yml": "x".repeat(257 * 1024),
          "package-lock.json": LOCKFILE,
          "Cargo.lock": "x".repeat(17 * MIB),
        },
        {},
      );

      await service.inspect({ ...clone, repoId });

      const { facts } = store.supplyChain(repoId)!;
      expect(facts.workflowsRead).toBe(1);
      expect(facts.workflowsUnread).toEqual([".github/workflows/big.yml"]);
      expect(facts.lockfiles).toEqual([
        { path: "Cargo.lock", read: "unreadable", packages: 0, publicPackages: 0, capped: false },
        { path: "package-lock.json", read: "parsed", packages: 1, publicPackages: 1, capped: false },
      ]);
    });

    it("lists a Dockerfile over the size cap, and one past the count cap, as not read, and still reads the rest", async () => {
      const files: Record<string, string> = { "app/Dockerfile": "FROM node:20\n", "big/Dockerfile": "x".repeat(257 * 1024) };
      for (let i = 0; i < 50; i++) files[`svc${String(i).padStart(2, "0")}/sub/deeper/Dockerfile`] = "FROM node:20\n";
      const { clone } = view(files);

      await service.inspect({ ...clone, repoId });

      const { facts } = store.supplyChain(repoId)!;
      // 52 Dockerfiles are listed and 50 are candidates (the shallowest). big/Dockerfile is one of them and is over the
      // cap, and the two deepest are past the count cap, so three were not read and 49 were.
      expect(facts.dockerfiles).toHaveLength(49);
      expect(facts.dockerfilesUnreadTotal).toBe(3);
      expect(facts.dockerfilesUnread).toContain("big/Dockerfile");
      expect(facts.dockerfilesUnread).toHaveLength(3);
      expect(facts.workflowsUnread).toEqual([]);
    });

    it("never reads a key-like file or a lockfile it cannot parse the registry of, but reports them from the listing", async () => {
      const { clone, reads } = view({
        ".env": "TOKEN=abc",
        "config/server.pem": "-----BEGIN-----",
        id_rsa: "private",
        "deploy/prod.key": "secret",
        "pnpm-lock.yaml": "lockfileVersion: 9",
        "package-lock.json": LOCKFILE,
      });

      await service.inspect({ ...clone, repoId });

      const names = reads.map((r) => r.path);
      expect(names).toEqual(["package-lock.json"]);
      expect(
        store
          .supplyChain(repoId)!
          .facts.keyFiles.map((k) => k.path)
          .sort(),
      ).toEqual([".env", "config/server.pem", "deploy/prod.key", "id_rsa"]);
    });

    it("reads at most 20 lockfiles", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 22; i++) files[`${"d/".repeat(i % 5)}pkg${i}/package-lock.json`] = LOCKFILE;
      const { clone, reads } = view(files);

      await service.inspect({ ...clone, repoId });

      expect(reads).toHaveLength(20);
      const { lockfiles } = store.supplyChain(repoId)!.facts;
      // The two past the cap are still listed, as unreadable, so the report does not understate how many there are.
      expect(lockfiles).toHaveLength(22);
      expect(lockfiles.filter((l) => l.read === "parsed")).toHaveLength(20);
      const unread = lockfiles.filter((l) => l.read === "unreadable").map((l) => l.path);
      expect(unread).toHaveLength(2);
      expect(reads.map((r) => r.path)).not.toEqual(expect.arrayContaining(unread));
    });

    it("parses a lockfile of about 16 MiB and lets the event loop run between lockfiles", async () => {
      const packages: Record<string, unknown> = { "": { name: "widgets" } };
      for (let i = 0; i < 29_000; i++) {
        packages[`node_modules/p${i}`] = {
          version: `1.0.${i}`,
          resolved: `https://registry.npmjs.org/p${i}/-/p${i}-1.0.${i}.tgz`,
          integrity: `sha512-${"a".repeat(88)}`,
          pad: "x".repeat(300),
        };
      }
      const big = JSON.stringify({ lockfileVersion: 3, packages });
      expect(Buffer.byteLength(big)).toBeGreaterThan(14 * MIB);
      expect(Buffer.byteLength(big)).toBeLessThan(16 * MIB);
      const { clone } = view({ "a/package-lock.json": big, "b/package-lock.json": LOCKFILE });
      let ticked = false;
      let tickedBeforeSecondRead = false;
      const timer = setImmediate(() => (ticked = true));
      let reads = 0;

      await service.inspect({
        ...clone,
        repoId,
        async read(path, maxBytes) {
          if (++reads === 2) tickedBeforeSecondRead = ticked;
          return clone.read(path, maxBytes);
        },
      });
      clearImmediate(timer);

      expect(store.supplyChain(repoId)!.facts.lockfiles.map((l) => l.read)).toEqual(["parsed", "parsed"]);
      expect(store.lockedPackages(repoId).length).toBeGreaterThanOrEqual(20_000);
      expect(tickedBeforeSecondRead).toBe(true);
    });

    it("stops reading lockfiles at 64 MiB in all and calls the rest unreadable", async () => {
      const full = "x".repeat(16 * MIB);
      const files: Record<string, string> = {};
      for (let i = 1; i <= 6; i++) files[`p${i}/package-lock.json`] = full;
      const { clone, reads } = view(files);

      await service.inspect({ ...clone, repoId });

      // Four reads of 16 MiB spend the whole budget; the last two are never opened.
      expect(reads.map((r) => r.maxBytes)).toEqual([16 * MIB, 16 * MIB, 16 * MIB, 16 * MIB]);
      const { lockfiles } = store.supplyChain(repoId)!.facts;
      expect(lockfiles.map((l) => l.read)).toEqual([
        "malformed",
        "malformed",
        "malformed",
        "malformed",
        "unreadable",
        "unreadable",
      ]);
    });

    it("lowers the cap of a read to what is left of the total budget", async () => {
      const files: Record<string, string> = {};
      for (let i = 1; i <= 4; i++) files[`p${i}/package-lock.json`] = "x".repeat(15 * MIB);
      files["p5/package-lock.json"] = "x".repeat(10 * MIB);
      const { clone, reads } = view(files);

      await service.inspect({ ...clone, repoId });

      // 4 x 15 MiB leaves 4 MiB, which a 10 MiB file does not fit.
      expect(reads.at(-1)).toEqual({ path: "p5/package-lock.json", maxBytes: 4 * MIB });
      expect(store.supplyChain(repoId)!.facts.lockfiles.at(-1)!.read).toBe("unreadable");
    });

    it("stores nothing when the inspection throws, so the facts stay stale for the next crawl", async () => {
      const { clone } = view(
        { ".github/workflows/ci.yml": WORKFLOW },
        {
          read: async () => {
            throw new Error("disk went away");
          },
        },
      );

      await expect(service.inspect({ ...clone, repoId })).rejects.toThrow("disk went away");

      expect(store.supplyChain(repoId)).toBeNull();
      expect(service.isStale(repoId, "abc1234")).toBe(true);
    });

    describe("blob ids", () => {
      const BLOB = "0123456789abcdef0123456789abcdef01234567";
      const files = {
        ".env.production": "TOKEN=abc",
        "tls/ca.pem": "-----BEGIN-----",
        Dockerfile: "FROM node:20\nUSER app\n",
        "src/index.ts": "export {};",
        ".github/workflows/ci.yml": WORKFLOW,
      };

      it("asks only for the key files and the Dockerfiles, in one request, and attaches what the tree holds", async () => {
        const { clone, blobAsks } = view(files, {}, { ".env.production": BLOB, Dockerfile: BLOB });

        await service.inspect({ ...clone, repoId });

        expect(blobAsks).toEqual([[".env.production", "tls/ca.pem", "Dockerfile"]]);
        const facts = store.supplyChain(repoId)!.facts;
        expect(facts.keyFiles).toEqual([
          { path: ".env.production", blob: BLOB, strength: "strong" },
          { path: "tls/ca.pem", blob: null, strength: "weak" },
        ]);
        expect(facts.dockerfiles.map((d) => [d.path, d.blob])).toEqual([["Dockerfile", BLOB]]);
      });

      it("still never opens a key file to learn its blob id", async () => {
        const { clone, reads } = view(files, {}, { ".env.production": BLOB });

        await service.inspect({ ...clone, repoId });

        expect(reads.map((r) => r.path)).not.toContain(".env.production");
        expect(reads.map((r) => r.path)).not.toContain("tls/ca.pem");
      });

      it("asks nothing when there is no key file or Dockerfile", async () => {
        const { clone, blobAsks } = view({ ".github/workflows/ci.yml": WORKFLOW });
        await service.inspect({ ...clone, repoId });
        expect(blobAsks).toEqual([]);
      });

      it("saves the facts with null blobs, and logs why, when the tree cannot be read", async () => {
        const warned: Record<string, unknown>[] = [];
        const logged = new SupplyChainService(store, () => NOW, {
          info: () => undefined,
          error: () => undefined,
          warn: (context: object) => void warned.push(context as never),
        });
        const { clone } = view(files, {
          blobIds: async () => {
            throw new UpstreamError("git failed: not a tree object", 502);
          },
        });

        const outcome = await logged.inspect({ ...clone, repoId });

        expect(outcome).toBe("partial");
        const facts = store.supplyChain(repoId)!.facts;
        expect(facts.keyFiles.map((k) => k.blob)).toEqual([null, null]);
        expect(facts.dockerfiles.map((d) => d.blob)).toEqual([null]);
        expect(facts.workflowsRead).toBe(1);
        expect(warned).toHaveLength(1);
        // Three paths were asked about: two key files and a Dockerfile.
        expect(warned[0]).toMatchObject({ repoId, paths: 3 });
        expect(facts.blobsRead).toBe(false);
      });

      it("answers complete when the lookup worked, and when nothing needed one", async () => {
        expect(await service.inspect({ ...view(files, {}, { Dockerfile: BLOB }).clone, repoId })).toBe("complete");
        expect(await service.inspect({ ...view({}).clone, repoId })).toBe("complete");
      });

      it("raises an error that is not an AppError, and saves no facts, so code health logs it as unexpected", async () => {
        const { clone } = view(files, {
          blobIds: async () => {
            throw new TypeError("blobs is not iterable");
          },
        });

        await expect(service.inspect({ ...clone, repoId })).rejects.toThrow("blobs is not iterable");

        expect(store.supplyChain(repoId)).toBeNull();
      });

      it("is stale at the same head after a failed lookup, so the next crawl reads the blob ids again", async () => {
        const failing = view(files, {
          blobIds: async () => {
            throw new UpstreamError("git failed: not a tree object", 502);
          },
        });
        await service.inspect({ ...failing.clone, repoId });
        expect(service.isStale(repoId, "abc1234")).toBe(true);

        const working = view(files, {}, { ".env.production": BLOB, Dockerfile: BLOB });
        await service.inspect({ ...working.clone, repoId });

        expect(store.supplyChain(repoId)!.facts.blobsRead).toBe(true);
        expect(service.isStale(repoId, "abc1234")).toBe(false);
      });

      it("is not stale for a key file with no blob of its own, such as a symlink, once the lookup worked", async () => {
        const { clone } = view(files, {}, { ".env.production": BLOB, Dockerfile: BLOB });
        await service.inspect({ ...clone, repoId });

        const facts = store.supplyChain(repoId)!.facts;
        expect(facts.keyFiles.map((k) => k.blob)).toEqual([BLOB, null]);
        expect(facts.blobsRead).toBe(true);
        expect(service.isStale(repoId, "abc1234")).toBe(false);
      });

      it("counts the lookup as read when nothing needed one", async () => {
        const { clone } = view({ ".github/workflows/ci.yml": WORKFLOW });
        await service.inspect({ ...clone, repoId });
        expect(store.supplyChain(repoId)!.facts.blobsRead).toBe(true);
        expect(service.isStale(repoId, "abc1234")).toBe(false);
      });

      it("reads the blob ids from the one clone the analysis makes", async () => {
        const checkout = new FakeSourceCheckout();
        checkout.blobs.set(".env.production", BLOB);
        const reader = new FakeWorkspaceReader();
        reader.files.set(".github/workflows/ci.yml", WORKFLOW);
        reader.files.set(".env.production", "TOKEN=abc");
        const code = new CodeHealthService(store, checkout, new FakeCodeAnalyser(), () => NOW, undefined, reader, service);

        await code.analyse("t", repoId);

        expect(checkout.blobRequests).toEqual([[".env.production"]]);
        expect(store.supplyChain(repoId)!.facts.keyFiles).toEqual([{ path: ".env.production", blob: BLOB, strength: "strong" }]);
        expect(reader.reads).not.toContain(".env.production");
      });
    });

    it("works with the default clock", async () => {
      const { clone } = view({});
      await new SupplyChainService(store).inspect({ ...clone, repoId });
      expect(store.supplyChain(repoId)!.facts.workflowsRead).toBe(0);
    });
  });

  describe("inside code health", () => {
    let checkout: FakeSourceCheckout;
    let analyser: FakeCodeAnalyser;
    let reader: FakeWorkspaceReader;
    let code: CodeHealthService;

    beforeEach(() => {
      checkout = new FakeSourceCheckout();
      analyser = new FakeCodeAnalyser();
      reader = new FakeWorkspaceReader();
      reader.files.set(".github/workflows/ci.yml", WORKFLOW);
      reader.files.set("package.json", '{"name":"widgets"}');
      code = new CodeHealthService(store, checkout, analyser, () => NOW, undefined, reader, service);
    });

    it("reads the facts from the one clone the analysis makes", async () => {
      await code.analyse("t", repoId);

      expect(checkout.requests).toHaveLength(1);
      expect(store.supplyChain(repoId)).toMatchObject({ commitSha: "abc1234", facts: { workflowsRead: 1 } });
    });

    it("does not clone again when the code and the facts are both fresh", async () => {
      await code.analyse("t", repoId);
      await code.analyse("t", repoId);

      expect(checkout.requests).toHaveLength(1);
      expect(analyser.analysed).toHaveLength(1);
    });

    it("clones once more, without analysing, when only the facts are stale", async () => {
      await code.analyse("t", repoId);
      const record = store.supplyChain(repoId)!;
      store.saveSupplyChain(repoId, { ...record, facts: { ...record.facts, version: 0, workflowsRead: 0 } }, []);

      await code.analyse("t", repoId);

      expect(checkout.requests).toHaveLength(2);
      expect(analyser.analysed).toHaveLength(1);
      expect(checkout.disposed).toHaveLength(2);
      expect(store.supplyChain(repoId)!.facts).toMatchObject({ version: SUPPLY_CHAIN_VERSION, workflowsRead: 1 });
    });

    it("stops cloning at the limit of attempts when the blob lookup keeps failing, and stores no failure", async () => {
      reader.files.set(".env.production", "TOKEN=abc");
      checkout.blobFailWith = new UpstreamError("git failed: not a tree object", 502);

      for (let crawl = 0; crawl < 4; crawl++) await code.analyse("t", repoId);

      expect(checkout.requests.length).toBeLessThanOrEqual(MAX_INSPECTION_ATTEMPTS);
      expect(checkout.requests).toHaveLength(MAX_INSPECTION_ATTEMPTS);
      expect(store.supplyChain(repoId)!.facts).toMatchObject({ blobsRead: false, workflowsRead: 1 });
      expect(store.supplyChainFailure(repoId)).toBeNull();
    });

    it("leaves the overview's failed flag and the report's failure unset after a partial read", async () => {
      reader.files.set(".env.production", "TOKEN=abc");
      checkout.blobFailWith = new UpstreamError("git failed: not a tree object", 502);
      store.setSourceState(repoId, "dependabot", {
        status: "ok",
        readAt: NOW.toISOString(),
        attemptedAt: NOW.toISOString(),
        truncated: false,
        skipped: 0,
      });

      for (let crawl = 0; crawl < 3; crawl++) await code.analyse("t", repoId);

      const reports = new SecurityReportService(
        store,
        store,
        { codeAnalysis: true, scorecardLookup: false, settingsUrl: () => "", fileUrl: () => null },
        () => NOW,
      );
      expect(reports.report(repoId).supplyChainFailure).toBeNull();
      expect(reports.summaries([repoId])[0]!.failed).toBe(false);
    });
  });
});
