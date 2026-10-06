import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryTrackerGrantStore } from "../src/infrastructure/auth/memory-tracker-grant-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { grant, workItem } from "./fakes.js";

const site = { siteId: "cloud-1", siteUrl: "https://acme.example.test" };
const wid = { ...site, key: "WID", name: "Widgets" };
const gad = { ...site, key: "GAD", name: "Gadgets" };

describe("tracker spaces in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("links spaces to a repository and reads them back with idle defaults", () => {
    const linked = store.linkSpaces(repoId, "cloud-1", [wid, gad]);

    expect(linked.map((s) => s.key)).toEqual(["WID", "GAD"]);
    expect(linked[0]).toEqual({
      id: linked[0]!.id,
      siteId: "cloud-1",
      siteUrl: "https://acme.example.test",
      key: "WID",
      name: "Widgets",
      statuses: [],
      columns: [],
      lastCrawledAt: null,
      crawlStatus: "idle",
      crawlError: null,
      crawlProgress: null,
    });
    // Listed by site then key, not in the order given.
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["GAD", "WID"]);
  });

  it("replaces the repository's links, keeping a space that is linked again and dropping one that is not", () => {
    const [first] = store.linkSpaces(repoId, "cloud-1", [wid, gad]);
    const relinked = store.linkSpaces(repoId, "cloud-1", [{ ...wid, name: "Widgets renamed" }]);

    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.id).toBe(first!.id);
    expect(relinked[0]!.name).toBe("Widgets renamed");
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID"]);
  });

  it("replaces only the links on the given site and keeps the others", () => {
    const ops = { siteId: "cloud-2", siteUrl: "https://other.example.test", key: "OPS", name: "Operations" };
    store.linkSpaces(repoId, "cloud-1", [wid, gad]);
    store.linkSpaces(repoId, "cloud-2", [ops]);

    store.linkSpaces(repoId, "cloud-1", [wid]);

    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID", "OPS"]);
    store.linkSpaces(repoId, "cloud-2", []);
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID"]);
  });

  it("removes the work items not in the set it is given, and reports how many went", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" }), workItem({ key: "WID-2" }), workItem({ key: "WID-3" })]);

    expect(store.removeWorkItemsExcept(space!.id, new Set(["WID-2"]))).toBe(2);

    expect(store.workItems(space!.id).map((i) => i.key)).toEqual(["WID-2"]);
  });

  it("removes work items only from the space it is asked about", () => {
    const [a, b] = store.linkSpaces(repoId, "cloud-1", [wid, gad]);
    store.upsertWorkItems(a!.id, [workItem({ key: "WID-1" })]);
    store.upsertWorkItems(b!.id, [workItem({ key: "GAD-1" })]);

    store.removeWorkItemsExcept(a!.id, new Set());

    expect(store.workItemCount(a!.id)).toBe(0);
    expect(store.workItemCount(b!.id)).toBe(1);
  });

  it("removes a space no repository links to any more, with its work items", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);

    store.linkSpaces(repoId, "cloud-1", []);

    expect(store.getSpace(space!.id)).toBeNull();
    expect(store.workItemCount(space!.id)).toBe(0);
  });

  it("keeps a space another repository still links to", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.linkSpaces(other, "cloud-1", [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);

    store.linkSpaces(repoId, "cloud-1", []);

    expect(store.getSpace(space!.id)).not.toBeNull();
    expect(store.workItemCount(space!.id)).toBe(1);
    expect(store.spacesFor(other).map((s) => s.id)).toEqual([space!.id]);
  });

  it("links a space once however many times it is listed", () => {
    expect(store.linkSpaces(repoId, "cloud-1", [wid, wid])).toHaveLength(1);
  });

  it("removes links, orphaned spaces and work items when the repository is deleted, but not a shared space", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const [alone, shared] = store.linkSpaces(repoId, "cloud-1", [gad, wid]);
    store.linkSpaces(other, "cloud-1", [wid]);
    store.upsertWorkItems(alone!.id, [workItem({ key: "GAD-1", spaceKey: "GAD" })]);

    store.deleteRepo(repoId);

    expect(store.spacesFor(repoId)).toEqual([]);
    expect(store.getSpace(alone!.id)).toBeNull();
    expect(store.workItemCount(alone!.id)).toBe(0);
    expect(store.getSpace(shared!.id)).not.toBeNull();
  });

  it("stores statuses and board columns on the space", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    const statuses = [{ id: "1", name: "To Do", category: "todo" as const }];
    const columns = [{ name: "Backlog", statusIds: ["1"] }];

    store.setSpaceDetails(space!.id, statuses, columns);

    expect(store.getSpace(space!.id)).toMatchObject({ statuses, columns });
  });

  it("records crawl state, then clears progress and error and stamps the time on finish", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.setSpaceCrawlState(space!.id, "crawling", "Read 2 work items");
    expect(store.getSpace(space!.id)).toMatchObject({ crawlStatus: "crawling", crawlProgress: "Read 2 work items" });

    store.setSpaceCrawlState(space!.id, "failed", null, "Jira said no");
    expect(store.getSpace(space!.id)).toMatchObject({ crawlStatus: "failed", crawlError: "Jira said no", crawlProgress: null });

    store.finishSpaceCrawl(space!.id, "2026-09-02T00:00:00Z");
    const done = store.getSpace(space!.id)!;
    expect(done).toMatchObject({ crawlStatus: "idle", crawlError: null, crawlProgress: null });
    expect(done.lastCrawledAt).not.toBeNull();
  });

  it("keeps the crawl cursor when a crawl finishes without one, and clears it on reset", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    expect(store.spaceCrawlCursor(space!.id)).toBeNull();

    store.finishSpaceCrawl(space!.id, "2026-09-02T00:00:00Z");
    store.finishSpaceCrawl(space!.id, null);
    expect(store.spaceCrawlCursor(space!.id)).toBe("2026-09-02T00:00:00Z");

    store.resetSpaceCrawlCursor(space!.id);
    expect(store.spaceCrawlCursor(space!.id)).toBeNull();
    expect(store.spaceCrawlCursor(9999)).toBeNull();
  });

  it("upserts work items by key, so a changed item replaces its earlier copy", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1", status: "To Do" }), workItem({ key: "WID-2" })]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1", status: "Done" })]);

    expect(store.workItemCount(space!.id)).toBe(2);
    expect(store.workItems(space!.id).find((i) => i.key === "WID-1")!.status).toBe("Done");
  });

  it("keeps work items apart by space", () => {
    const [a, b] = store.linkSpaces(repoId, "cloud-1", [wid, gad]);
    store.upsertWorkItems(a!.id, [workItem({ key: "WID-1" })]);

    expect(store.workItemCount(a!.id)).toBe(1);
    expect(store.workItemCount(b!.id)).toBe(0);
    expect(store.workItems(b!.id)).toEqual([]);
  });

  it("returns null for a space that does not exist", () => {
    expect(store.getSpace(42)).toBeNull();
  });
});

describe("a store reopened after an interrupted crawl", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-spaces-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resets a space stuck at crawling to idle and keeps what was stored", () => {
    const path = join(dir, "dora.sqlite");
    const first = new SqliteRepoStore(path);
    const repoId = first.addRepo("acme", "widgets", [], "main").id;
    const [space] = first.linkSpaces(repoId, "cloud-1", [wid]);
    first.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);
    first.setSpaceCrawlState(space!.id, "crawling", "Read 1 work items");

    const second = new SqliteRepoStore(path);

    expect(second.getSpace(space!.id)).toMatchObject({ crawlStatus: "idle", crawlProgress: null });
    expect(second.workItemCount(space!.id)).toBe(1);
  });
});

describe("MemoryTrackerGrantStore", () => {
  it("keeps a grant per login and forgets it on delete", () => {
    const store = new MemoryTrackerGrantStore();
    expect(store.get("alice")).toBeNull();

    store.set("alice", grant({ accessToken: "a" }));
    store.set("bob", grant({ accessToken: "b" }));
    expect(store.get("alice")!.accessToken).toBe("a");
    expect(store.get("bob")!.accessToken).toBe("b");

    store.delete("alice");
    expect(store.get("alice")).toBeNull();
    expect(store.get("bob")).not.toBeNull();
  });

  it("holds a copy, so changing the original does not change what is stored", () => {
    const store = new MemoryTrackerGrantStore();
    const original = grant({ accessToken: "a" });
    store.set("alice", original);
    original.accessToken = "changed";
    expect(store.get("alice")!.accessToken).toBe("a");
  });
});
