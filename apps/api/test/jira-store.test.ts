import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

  describe("a failed write", () => {
    it("rolls back linking spaces to a repository that does not exist, and the store still works", () => {
      expect(() => store.linkSpaces(9999, "cloud-1", [wid])).toThrow();
      // The space inserted before the link failed went with the rollback.
      expect(store.listSpaces()).toEqual([]);

      expect(store.linkSpaces(repoId, "cloud-1", [wid]).map((s) => s.key)).toEqual(["WID"]);
    });

    it("rolls back a batch of work items that fails part way, and the store still works", () => {
      const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
      const bad = { ...workItem({ key: "WID-2" }), updatedAt: undefined as unknown as string };

      expect(() => store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" }), bad])).toThrow();
      expect(store.workItemCount(space!.id)).toBe(0);

      store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);
      expect(store.workItemCount(space!.id)).toBe(1);
    });

    it("rolls back removing work items when a delete fails, and the store still works", () => {
      const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
      store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" }), workItem({ key: "WID-2" }), workItem({ key: "WID-3" })]);
      const db = (store as unknown as { db: DatabaseSync }).db;
      // Refuses the second delete only, so the first has to be undone.
      db.exec(
        "CREATE TRIGGER refuse_wid3 BEFORE DELETE ON work_items WHEN OLD.key = 'WID-3' BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );

      expect(() => store.removeWorkItemsExcept(space!.id, new Set(["WID-1"]))).toThrow("refused");
      expect(store.workItemCount(space!.id)).toBe(3);

      db.exec("DROP TRIGGER refuse_wid3");
      expect(store.removeWorkItemsExcept(space!.id, new Set(["WID-1"]))).toBe(2);
      expect(store.workItems(space!.id).map((i) => i.key)).toEqual(["WID-1"]);
    });
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

  it("marks a space stuck at crawling as failed, saying why, and keeps what was stored", () => {
    const path = join(dir, "dora.sqlite");
    const first = new SqliteRepoStore(path);
    const repoId = first.addRepo("acme", "widgets", [], "main").id;
    const [space] = first.linkSpaces(repoId, "cloud-1", [wid]);
    first.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);
    first.setSpaceCrawlState(space!.id, "crawling", "Read 1 work items");

    const second = new SqliteRepoStore(path);

    expect(second.getSpace(space!.id)).toMatchObject({
      crawlStatus: "failed",
      crawlProgress: null,
      crawlError: "The API restarted during this crawl. Crawl again.",
    });
    expect(second.workItemCount(space!.id)).toBe(1);
  });
});

describe("space people, listing and linked repositories", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("reads a space without people until names are saved, then returns them", () => {
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    expect("people" in store.getSpace(space!.id)!).toBe(false);

    store.setSpacePeople(space!.id, { "acct-1": "Someone" });
    expect(store.getSpace(space!.id)!.people).toEqual({ "acct-1": "Someone" });
    expect(store.spacesFor(repoId)[0]!.people).toEqual({ "acct-1": "Someone" });

    // Saving replaces the map, and an empty map reads back as empty rather than absent.
    store.setSpacePeople(space!.id, {});
    expect(store.getSpace(space!.id)!.people).toEqual({});
  });

  it("lists every space across repositories, ordered by site then key", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const ops = { siteId: "cloud-0", siteUrl: "https://other.example.test", key: "OPS", name: "Operations" };
    store.linkSpaces(repoId, "cloud-1", [wid]);
    store.linkSpaces(other, "cloud-1", [gad]);
    store.linkSpaces(other, "cloud-0", [ops]);

    expect(store.listSpaces().map((s) => [s.siteId, s.key])).toEqual([
      ["cloud-0", "OPS"],
      ["cloud-1", "GAD"],
      ["cloud-1", "WID"],
    ]);
  });

  it("lists no spaces when none are tracked", () => {
    expect(store.listSpaces()).toEqual([]);
  });

  it("returns the repositories a space is linked to, ordered by owner then name", () => {
    const gadgets = store.addRepo("acme", "gadgets", [], "main").id;
    const [space] = store.linkSpaces(repoId, "cloud-1", [wid]);
    store.linkSpaces(gadgets, "cloud-1", [wid]);
    store.addRepo("acme", "unlinked", [], "main");

    expect(store.reposForSpace(space!.id).map((r) => `${r.owner}/${r.name}`)).toEqual(["acme/gadgets", "acme/widgets"]);
    expect(store.reposForSpace(9999)).toEqual([]);
  });
});

describe("migrating a database made before spaces held people", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The tracker_spaces table as the first Jira release created it, with no people column. */
  function oldDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE tracker_spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      site_url TEXT NOT NULL,
      space_key TEXT NOT NULL,
      name TEXT NOT NULL,
      statuses TEXT NOT NULL DEFAULT '[]',
      columns TEXT NOT NULL DEFAULT '[]',
      last_crawled_at TEXT,
      crawl_status TEXT NOT NULL DEFAULT 'idle',
      crawl_error TEXT,
      crawl_progress TEXT,
      crawl_cursor TEXT,
      UNIQUE (site_id, space_key)
    )`);
    db.prepare("INSERT INTO tracker_spaces (site_id, site_url, space_key, name) VALUES (?, ?, ?, ?)").run(
      "cloud-1",
      "https://acme.example.test",
      "WID",
      "Widgets",
    );
    db.close();
  }

  it("adds the column, keeps the existing space and lets names be saved", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);

    const store = new SqliteRepoStore(path);
    const [space] = store.listSpaces();
    expect(space).toMatchObject({ key: "WID", name: "Widgets" });
    expect("people" in space!).toBe(false);

    store.setSpacePeople(space!.id, { "acct-1": "Someone" });
    expect(store.getSpace(space!.id)!.people).toEqual({ "acct-1": "Someone" });
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON that is not a map of names", "[1, 2]"],
    ["a JSON null", "null"],
  ])("reads a space whose saved names are %s as having no names, rather than failing", (_, saved) => {
    const path = join(dir, "corrupt.db");
    const first = new SqliteRepoStore(path);
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, "cloud-1", [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run(saved, id);
    db.close();

    const store = new SqliteRepoStore(path);

    expect(store.getSpace(id)).toMatchObject({ key: "WID", name: "Widgets" });
    expect("people" in store.getSpace(id)!).toBe(false);
    expect("people" in store.listSpaces()[0]!).toBe(false);
  });

  it("opens the same database again without trying to add the column twice", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    const first = new SqliteRepoStore(path);
    first.setSpacePeople(first.listSpaces()[0]!.id, { "acct-1": "Someone" });

    const second = new SqliteRepoStore(path);

    expect(second.listSpaces()[0]!.people).toEqual({ "acct-1": "Someone" });
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
    (original as { accessToken: string }).accessToken = "changed";
    expect(store.get("alice")!.accessToken).toBe("a");
  });
});
