import type { CodeSnapshot } from "@dora-dashboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { CodeDetailService } from "../src/services/code-detail-service.js";
import { coverageSnapshot, fn } from "./fakes.js";

const snapshot = (overrides: Partial<CodeSnapshot> = {}): CodeSnapshot => ({
  commitSha: "abc1234",
  analysedAt: "2026-09-29T10:00:00.000Z",
  functions: [fn({ file: "apps/api/src/a.ts", ccn: 14, startLine: 1, endLine: 10 }), fn({ file: "packages/core/src/c.ts" })],
  partlyMeasured: [],
  unmeasuredFiles: 0,
  error: null,
  tooling: null,
  snapshotVersion: 6,
  files: ["apps/api/src/a.ts", "packages/core/src/c.ts"],
  layout: { manifests: ["apps/api/package.json", "packages/core/package.json"], workspaces: null },
  ...overrides,
});

describe("code detail memo", () => {
  let store: SqliteRepoStore;
  let service: CodeDetailService;
  let id: number;
  let reads: { code: ReturnType<typeof vi.spyOn>; good: ReturnType<typeof vi.spyOn>; cover: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    service = new CodeDetailService(store);
    id = store.addRepo("acme", "widgets", [], "main").id;
    store.saveCodeSnapshot(id, snapshot());
    store.saveCoverageSnapshot(id, coverageSnapshot());
    reads = {
      code: vi.spyOn(store, "latestCodeSnapshot"),
      good: vi.spyOn(store, "latestSuccessfulCodeSnapshot"),
      cover: vi.spyOn(store, "latestSuccessfulCoverageSnapshot"),
    };
  });

  const loads = () => reads.code.mock.calls.length + reads.good.mock.calls.length + reads.cover.mock.calls.length;

  it("reads each snapshot once, however many areas are then asked for", () => {
    service.detail(id, null);
    const first = loads();

    const api = service.detail(id, "apps/api");
    const core = service.detail(id, "packages/core");
    service.detail(id, null);

    expect(loads()).toBe(first);
    expect(api).toMatchObject({ status: "ok", area: "apps/api" });
    expect(core).toMatchObject({ status: "ok", area: "packages/core" });
  });

  it("reads the newest snapshot once when it is also the newest successful one", () => {
    service.detail(id, null);

    expect(reads.good).toHaveBeenCalledTimes(1);
    expect(reads.code).not.toHaveBeenCalled();
    expect(reads.cover).toHaveBeenCalledTimes(1);
  });

  it("still applies the area to the prepared result", () => {
    service.detail(id, "apps/api");

    const body = service.detail(id, "packages/core");

    expect(body).toMatchObject({ area: "packages/core" });
    expect(body.status === "ok" && body.functions.total).toBe(1);
  });

  it("rebuilds after a new code snapshot", () => {
    service.detail(id, null);
    store.saveCodeSnapshot(id, snapshot({ analysedAt: "2026-09-30T10:00:00.000Z", commitSha: "def5678" }));

    const body = service.detail(id, null);

    expect(reads.good).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ commitSha: "def5678" });
  });

  it("rebuilds after a new coverage read", () => {
    service.detail(id, null);
    store.saveCoverageSnapshot(id, coverageSnapshot({ fetchedAt: "2026-09-30T10:00:00.000Z", commitSha: "def5678" }));

    const body = service.detail(id, null);

    expect(reads.cover).toHaveBeenCalledTimes(2);
    expect(body.status === "ok" && body.coverage.status === "ok" && body.coverage.source.fetchedAt).toBe(
      "2026-09-30T10:00:00.000Z",
    );
  });

  it("rebuilds when a failed attempt arrives, and then reports it as lastError", () => {
    service.detail(id, null);
    store.saveCodeSnapshot(
      id,
      snapshot({ analysedAt: "2026-09-30T10:00:00.000Z", commitSha: "", error: "clone failed", functions: [] }),
    );

    const body = service.detail(id, null);

    expect(body).toMatchObject({ commitSha: "abc1234", lastError: { message: "clone failed", reason: "failed" } });
    expect(reads.code).toHaveBeenCalledTimes(1);
  });

  it("reads a newer failed coverage read separately from the last good one", () => {
    store.saveCoverageSnapshot(
      id,
      coverageSnapshot({ fetchedAt: "2026-09-30T10:00:00.000Z", error: "Artefact expired", reports: [], artefacts: [] }),
    );
    const latest = vi.spyOn(store, "latestCoverageSnapshot");

    const body = service.detail(id, null);

    expect(latest).toHaveBeenCalledTimes(1);
    expect(body.status === "ok" && body.coverage).toMatchObject({ status: "ok", lastError: { message: "Artefact expired" } });
  });

  it("answers none and error without keeping anything", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    expect(service.detail(other)).toEqual({ status: "none" });

    store.saveCodeSnapshot(other, snapshot({ commitSha: "", error: "clone failed", functions: [] }));
    expect(service.detail(other)).toMatchObject({ status: "error", message: "clone failed", reason: "failed" });
  });

  it("answers 404 for an unknown repository", () => {
    expect(() => service.detail(99)).toThrow(NotFoundError);
  });

  it("keeps only the most recently used repositories", () => {
    const small = new CodeDetailService(store, 1);
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.saveCodeSnapshot(other, snapshot());

    small.detail(id);
    small.detail(other);
    const before = reads.good.mock.calls.length;
    small.detail(id);

    expect(reads.good.mock.calls.length).toBe(before + 1);
  });
});

describe("snapshot keys in the store", () => {
  it("are null before any snapshot", () => {
    const store = new SqliteRepoStore(":memory:");
    const id = store.addRepo("acme", "widgets", [], "main").id;
    expect(store.codeSnapshotKeys(id)).toEqual({ latest: null, good: null });
    expect(store.coverageSnapshotKeys(id)).toEqual({ latest: null, good: null });
  });

  it("tell the newest from the newest successful, without a failed one standing in for it", () => {
    const store = new SqliteRepoStore(":memory:");
    const id = store.addRepo("acme", "widgets", [], "main").id;
    store.saveCodeSnapshot(id, snapshot());
    store.saveCodeSnapshot(id, snapshot({ analysedAt: "2026-09-30T10:00:00.000Z", error: "clone failed", functions: [] }));
    store.saveCoverageSnapshot(id, coverageSnapshot({ fetchedAt: "2026-09-28T10:00:00.000Z" }));
    store.saveCoverageSnapshot(id, coverageSnapshot({ fetchedAt: "2026-09-30T10:00:00.000Z", error: "gone", reports: [] }));

    expect(store.codeSnapshotKeys(id)).toEqual({ latest: "2026-09-30T10:00:00.000Z", good: "2026-09-29T10:00:00.000Z" });
    expect(store.coverageSnapshotKeys(id)).toEqual({ latest: "2026-09-30T10:00:00.000Z", good: "2026-09-28T10:00:00.000Z" });
  });
});
