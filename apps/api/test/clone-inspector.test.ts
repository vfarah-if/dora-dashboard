import type { CodeSnapshot } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import type { CloneInspector, CloneView } from "../src/services/clone-inspector.js";
import {
  ANALYSER_MISSING,
  CLONE_FAILURE,
  CodeHealthService,
  INSPECTION_FAILURE,
  LISTING_FAILURE,
} from "../src/services/code-health-service.js";
import { CrawlService } from "../src/services/crawl-service.js";
import { FakeCodeAnalyser, FakeProvider, FakeSourceCheckout, FakeWorkspaceReader, pr, run } from "./fakes.js";

/** Records what it was shown, and says its facts are stale until told otherwise. */
class FakeInspector implements CloneInspector {
  stale = true;
  failWith: Error | null = null;
  readonly asked: { repoId: number; head: string }[] = [];
  readonly views: CloneView[] = [];
  /** What `view.read` returned for the file it was last asked to read. */
  readResults: (string | null)[] = [];
  readFile: { path: string; maxBytes: number } | null = null;

  isStale(repoId: number, head: string): boolean {
    this.asked.push({ repoId, head });
    return this.stale;
  }

  /** Every failure the service recorded beside the facts, in order. */
  readonly failures: { repoId: number; message: string }[] = [];

  fail(repoId: number, message: string): void {
    this.failures.push({ repoId, message });
  }

  async inspect(view: CloneView): Promise<void> {
    this.views.push(view);
    if (this.readFile) this.readResults.push(await view.read(this.readFile.path, this.readFile.maxBytes));
    if (this.failWith) throw this.failWith;
  }
}

function recordingLog() {
  const warnings: { context: Record<string, unknown>; message: string }[] = [];
  const log: Logger = {
    info: () => undefined,
    error: () => undefined,
    warn: (context, message) => void warnings.push({ context: context as Record<string, unknown>, message }),
  };
  return { log, warnings };
}

const NOW = new Date("2026-09-29T10:00:00Z");

describe("the clone inspector during code health", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let checkout: FakeSourceCheckout;
  let analyser: FakeCodeAnalyser;
  let reader: FakeWorkspaceReader;
  let inspector: FakeInspector;
  let logged: ReturnType<typeof recordingLog>;
  let clock: Date;
  let service: CodeHealthService;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    checkout = new FakeSourceCheckout();
    analyser = new FakeCodeAnalyser();
    reader = new FakeWorkspaceReader();
    reader.files.set("package.json", '{"name":"widgets"}');
    reader.files.set("src/index.ts", "export {};");
    inspector = new FakeInspector();
    logged = recordingLog();
    clock = NOW;
    service = new CodeHealthService(store, checkout, analyser, () => clock, logged.log, reader, inspector);
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })] });
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
  });

  it("shows the inspector the clone's commit and listing, and reads files through the reader with the cap it asks for", async () => {
    inspector.readFile = { path: "package.json", maxBytes: 5 };

    await service.analyse("t", repoId);

    expect(inspector.views).toHaveLength(1);
    expect(inspector.views[0]).toMatchObject({ repoId, commitSha: "abc1234", paths: ["package.json", "src/index.ts"] });
    // Over five bytes, so the reader answers null, as a file over the cap does on disk.
    expect(inspector.readResults).toEqual([null]);
    expect(reader.reads).toContain("package.json");
  });

  it("lists the clone once, whoever uses the listing", async () => {
    await service.analyse("t", repoId);

    expect(reader.lists).toBe(1);
    // Code health still read its tooling from that listing.
    expect(store.latestCodeSnapshot(repoId)!.files).toEqual(["src/index.ts"]);
  });

  it("lists the clone once without an inspector too, and only after the analysis", async () => {
    const plain = new CodeHealthService(store, checkout, analyser, () => clock, logged.log, reader);
    const order: string[] = [];
    analyser.analyse = async () => {
      order.push(`analyse after ${reader.lists} lists`);
      return { functions: [], partlyMeasured: [], unmeasuredFiles: 0 };
    };

    await plain.analyse("t", repoId);

    expect(order).toEqual(["analyse after 0 lists"]);
    expect(reader.lists).toBe(1);
  });

  it("inspects before it analyses", async () => {
    const order: string[] = [];
    inspector.inspect = async () => void order.push("inspect");
    analyser.analyse = async () => {
      order.push("analyse");
      return { functions: [], partlyMeasured: [], unmeasuredFiles: 0 };
    };

    await service.analyse("t", repoId);

    expect(order).toEqual(["inspect", "analyse"]);
  });

  it("inspects during a full crawl, once, even when the head is unchanged and the facts are fresh", async () => {
    const crawler = new CrawlService(store, provider, { codeHealth: service });
    await crawler.crawl("t", repoId);
    inspector.stale = false;

    await crawler.crawl("t", repoId, true);

    expect(inspector.views).toHaveLength(2);
    expect(checkout.requests).toHaveLength(2);
    expect(analyser.analysed).toHaveLength(2);
  });

  it("reads the facts again, and records no failed analysis, when the inspector cannot tell whether they are stale", async () => {
    await service.analyse("t", repoId);
    inspector.isStale = () => {
      throw new Error("Stored supply chain facts of repository 1 are not readable");
    };

    const snapshot = await service.analyse("t", repoId);

    // The code was not measured again, and the snapshot is the earlier good one with no error.
    expect(snapshot.error).toBeNull();
    expect(analyser.analysed).toHaveLength(1);
    // The inspector was shown the clone, so its row can be written again.
    expect(inspector.views).toHaveLength(2);
    expect(checkout.requests).toHaveLength(2);
    expect(logged.warnings.map((w) => w.message)).toContain(
      "could not tell whether the supply chain facts are stale; reading them again",
    );
    expect(logged.warnings.map((w) => w.message)).not.toContain("code analysis failed");
  });

  it("clones nothing for an unchanged head whose facts are fresh, and asks the inspector with the head", async () => {
    await service.analyse("t", repoId);
    inspector.stale = false;

    const snapshot = await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(1);
    expect(inspector.views).toHaveLength(1);
    expect(inspector.asked).toEqual([{ repoId, head: "abc1234" }]);
    expect(snapshot.commitSha).toBe("abc1234");
  });

  it("clones once to inspect an unchanged head whose facts are stale, without analysing or saving a code snapshot", async () => {
    const first = await service.analyse("t", repoId);
    clock = new Date("2026-09-30T10:00:00Z");
    inspector.stale = true;

    const second = await service.analyse("t", repoId);

    expect(checkout.requests).toHaveLength(2);
    expect(inspector.views).toHaveLength(2);
    expect(inspector.views[1]).toMatchObject({ commitSha: "abc1234", paths: ["package.json", "src/index.ts"] });
    // The analyser ran for the first clone only.
    expect(analyser.analysed).toHaveLength(1);
    expect(checkout.disposed).toHaveLength(2);
    // The snapshot is the one already held: no new one was saved, and none carries the later time.
    expect(second).toEqual(first);
    expect(store.latestCodeSnapshot(repoId)!.analysedAt).toBe("2026-09-29T10:00:00.000Z");
    expect(store.codeSnapshotKeys(repoId)).toEqual({ latest: "2026-09-29T10:00:00.000Z", good: "2026-09-29T10:00:00.000Z" });
  });

  it("clones for the new head, and inspects in that one clone, when the branch has moved", async () => {
    await service.analyse("t", repoId);
    checkout.head = "def5678";

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.commitSha).toBe("def5678");
    expect(checkout.requests).toHaveLength(2);
    expect(inspector.views.map((v) => v.commitSha)).toEqual(["abc1234", "def5678"]);
    // The inspector was not asked whether to clone, because the analysis needed the clone anyway.
    expect(inspector.asked).toEqual([]);
  });

  it("does not ask the inspector when there is no snapshot to be unchanged", async () => {
    await service.analyse("t", repoId);

    expect(inspector.asked).toEqual([]);
  });

  it("logs an inspector that throws, and still saves the snapshot as it would have been", async () => {
    inspector.failWith = new Error("lockfile exploded");

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.error).toBeNull();
    expect(store.latestCodeSnapshot(repoId)).toEqual(snapshot);
    expect(analyser.analysed).toHaveLength(1);
    expect(logged.warnings).toEqual([
      { context: { err: new Error("lockfile exploded"), repoId }, message: "could not inspect the clone" },
    ]);
    expect(checkout.disposed).toHaveLength(1);
  });

  it("logs a failed inspection of an unchanged head, disposes of the clone and saves no failed snapshot", async () => {
    await service.analyse("t", repoId);
    inspector.failWith = new Error("lockfile exploded");

    const snapshot = await service.analyse("t", repoId);

    expect(snapshot.error).toBeNull();
    expect(analyser.analysed).toHaveLength(1);
    expect(checkout.disposed).toHaveLength(2);
    expect(store.codeSnapshotKeys(repoId).latest).toBe(store.codeSnapshotKeys(repoId).good);
    expect(logged.warnings.map((w) => w.message)).toEqual(["could not inspect the clone"]);
  });

  it("logs a clone that fails for an unchanged head and keeps the stored snapshot", async () => {
    const first = await service.analyse("t", repoId);
    checkout.failWith = new Error("network down");

    const second = await service.analyse("t", repoId);

    expect(second).toEqual(first);
    expect(logged.warnings.map((w) => w.message)).toEqual(["could not clone the branch to inspect it"]);
    expect(store.latestCodeSnapshot(repoId)!.error).toBeNull();
  });

  it("logs a checkout that cannot be removed after an inspection of an unchanged head", async () => {
    await service.analyse("t", repoId);
    checkout.disposeFailWith = new Error("busy");

    await service.analyse("t", repoId);

    expect(logged.warnings.map((w) => w.message)).toEqual(["could not remove the checkout"]);
  });

  it("does not inspect, and logs once, when the clone cannot be listed", async () => {
    reader.listFailWith = new Error("too deep");

    const snapshot = await service.analyse("t", repoId);

    expect(inspector.views).toEqual([]);
    expect(snapshot.error).toBeNull();
    expect(snapshot.tooling).toBeNull();
    expect(logged.warnings.map((w) => w.message)).toEqual(["could not read the repository's tooling files"]);
    expect(reader.lists).toBe(1);
  });

  describe("when the analyser is missing", () => {
    beforeEach(() => {
      analyser.reachIs = "none";
    });

    it("still inspects the clone, since supply chain facts need no analyser, and analyses nothing", async () => {
      const snapshot = await service.analyse("t", repoId);

      expect(snapshot.error).toBe(ANALYSER_MISSING);
      expect(inspector.views).toHaveLength(1);
      expect(inspector.views[0]).toMatchObject({ repoId, commitSha: "abc1234" });
      expect(analyser.analysed).toEqual([]);
      expect(checkout.disposed).toHaveLength(1);
    });

    it("clones nothing when the inspector's facts for the head are fresh", async () => {
      inspector.stale = false;

      await service.analyse("t", repoId);

      expect(inspector.asked).toEqual([{ repoId, head: "abc1234" }]);
      expect(checkout.requests).toEqual([]);
    });

    it("does not clone when the head cannot be read, and logs it", async () => {
      checkout.headFailWith = new Error("no route");

      const snapshot = await service.analyse("t", repoId);

      expect(snapshot.error).toBe(ANALYSER_MISSING);
      expect(checkout.requests).toEqual([]);
      expect(logged.warnings.map((w) => w.message)).toEqual(["could not read the branch head to inspect it"]);
    });

    it("never inspects without a reader", async () => {
      const readerless = new CodeHealthService(store, checkout, analyser, () => clock, logged.log, null, inspector);

      await readerless.analyse("t", repoId);

      expect(checkout.requests).toEqual([]);
    });
  });

  it("shows the inspector whether the listing was complete", async () => {
    await service.analyse("t", repoId);
    expect(inspector.views[0]!.listingComplete).toBe(true);

    reader.listingComplete = false;
    await service.analyse("t", repoId, true);
    expect(inspector.views[1]!.listingComplete).toBe(false);
  });

  describe("recording a failed inspection beside the facts", () => {
    it("records nothing when the inspection succeeds", async () => {
      await service.analyse("t", repoId);
      expect(inspector.failures).toEqual([]);
    });

    it("records a neutral message, which carries nothing from the cause, when the inspector throws", async () => {
      inspector.failWith = new Error("lockfile exploded at /tmp/clone-x with ghp_secret");

      await service.analyse("t", repoId);

      expect(inspector.failures).toEqual([{ repoId, message: INSPECTION_FAILURE }]);
      expect(JSON.stringify(inspector.failures)).not.toMatch(/ghp_secret|clone-x|exploded/);
    });

    it("records a failure to clone an unchanged head for the inspection alone", async () => {
      await service.analyse("t", repoId);
      checkout.failWith = new Error("network down");

      await service.analyse("t", repoId);

      expect(inspector.failures).toEqual([{ repoId, message: CLONE_FAILURE }]);
    });

    it("records a clone that cannot be listed, though the analysis goes on", async () => {
      reader.listFailWith = new Error("too deep");

      const snapshot = await service.analyse("t", repoId);

      expect(snapshot.error).toBeNull();
      expect(inspector.failures).toEqual([{ repoId, message: LISTING_FAILURE }]);
    });

    it("logs, and goes on, when the failure cannot be recorded", async () => {
      inspector.failWith = new Error("lockfile exploded");
      inspector.fail = () => {
        throw new Error("database is locked");
      };

      const snapshot = await service.analyse("t", repoId);

      expect(snapshot.error).toBeNull();
      expect(logged.warnings.map((w) => w.message)).toContain("could not record the failed inspection");
    });

    it("records each failed attempt, so the message and time are those of the latest", async () => {
      inspector.failWith = new Error("lockfile exploded");
      await service.analyse("t", repoId);
      await service.analyse("t", repoId);

      expect(inspector.failures).toHaveLength(2);
    });
  });

  describe("an inspection that keeps failing", () => {
    beforeEach(async () => {
      inspector.failWith = new Error("lockfile exploded");
      // The first crawl analyses and inspects in one clone, and the inspection fails: one attempt.
      await service.analyse("t", repoId);
    });

    it("is retried once for the same head and then left alone, so the repository is not cloned on every crawl", async () => {
      await service.analyse("t", repoId);
      expect(checkout.requests).toHaveLength(2);

      await service.analyse("t", repoId);
      await service.analyse("t", repoId);

      expect(checkout.requests).toHaveLength(2);
      expect(inspector.views).toHaveLength(2);
    });

    it("is tried again once the head moves", async () => {
      await service.analyse("t", repoId);
      await service.analyse("t", repoId);
      checkout.head = "def5678";

      await service.analyse("t", repoId);

      expect(inspector.views.map((v) => v.commitSha)).toEqual(["abc1234", "abc1234", "def5678"]);
    });

    it("is tried again after a success clears the record", async () => {
      await service.analyse("t", repoId);
      inspector.failWith = null;
      checkout.head = "def5678";
      await service.analyse("t", repoId);
      inspector.failWith = new Error("again");
      checkout.head = "abc1234";

      // The record was cleared by the success, so this head gets its attempts afresh.
      await service.analyse("t", repoId);
      await service.analyse("t", repoId);
      await service.analyse("t", repoId);

      expect(inspector.views.filter((v) => v.commitSha === "abc1234")).toHaveLength(2 + 2);
    });

    it("counts a clone that fails, and a listing that fails, as attempts too", async () => {
      inspector.failWith = null;
      checkout.failWith = new Error("network down");
      await service.analyse("t", repoId);
      await service.analyse("t", repoId);
      checkout.failWith = null;

      await service.analyse("t", repoId);

      // One failed inspection, one failed clone, then the limit: no third clone.
      expect(checkout.requests).toHaveLength(1);
    });

    it("counts a clone that cannot be listed as a failed attempt", async () => {
      inspector.failWith = null;
      reader.listFailWith = new Error("too deep");
      await service.analyse("t", repoId);
      reader.listFailWith = null;

      await service.analyse("t", repoId);

      expect(checkout.requests).toHaveLength(2);
    });
  });

  it("never calls an inspector it has no reader for", async () => {
    const readerless = new CodeHealthService(store, checkout, analyser, () => clock, logged.log, null, inspector);

    await readerless.analyse("t", repoId);
    await readerless.analyse("t", repoId);

    expect(inspector.views).toEqual([]);
    expect(inspector.asked).toEqual([]);
  });

  it("saves exactly the snapshot it saved before there was an inspector", async () => {
    const withoutStore = new SqliteRepoStore(":memory:");
    const id = withoutStore.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
    const plain = new CodeHealthService(
      withoutStore,
      new FakeSourceCheckout(),
      new FakeCodeAnalyser(),
      () => NOW,
      logged.log,
      reader,
    );

    await plain.analyse("t", id);
    await service.analyse("t", repoId);

    const bare: CodeSnapshot = withoutStore.latestCodeSnapshot(id)!;
    expect(JSON.stringify(store.latestCodeSnapshot(repoId))).toBe(JSON.stringify(bare));
    expect(Object.keys(bare)).not.toContain("inspected");
  });
});
