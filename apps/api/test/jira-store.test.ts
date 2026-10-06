import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAPSE_MEMORY_MS, MemoryTrackerGrantStore } from "../src/infrastructure/auth/memory-tracker-grant-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { grant, workItem } from "./fakes.js";

const site = { id: "cloud-1", url: "https://acme.example.test" };
const other = { id: "cloud-2", url: "https://other.example.test" };
const wid = { key: "WID", name: "Widgets" };
const gad = { key: "GAD", name: "Gadgets" };

describe("tracker spaces in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("links spaces to a repository and reads them back with idle defaults, the board not yet read", () => {
    const linked = store.linkSpaces(repoId, site, [wid, gad]);

    expect(linked.map((s) => s.key)).toEqual(["WID", "GAD"]);
    expect(linked[0]).toEqual({
      id: linked[0]!.id,
      siteId: "cloud-1",
      siteUrl: "https://acme.example.test",
      key: "WID",
      name: "Widgets",
      statuses: [],
      columns: [],
      board: null,
      lastCrawledAt: null,
      crawlStatus: "idle",
      crawlError: null,
      crawlProgress: null,
    });
    // Listed by site then key, not in the order given.
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["GAD", "WID"]);
  });

  it("replaces the repository's links, keeping a space that is linked again and dropping one that is not", () => {
    const [first] = store.linkSpaces(repoId, site, [wid, gad]);
    const relinked = store.linkSpaces(repoId, site, [{ ...wid, name: "Widgets renamed" }]);

    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.id).toBe(first!.id);
    expect(relinked[0]!.name).toBe("Widgets renamed");
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID"]);
  });

  it("replaces only the links on the given site and keeps the others", () => {
    const ops = { key: "OPS", name: "Operations" };
    store.linkSpaces(repoId, site, [wid, gad]);
    store.linkSpaces(repoId, other, [ops]);

    store.linkSpaces(repoId, site, [wid]);

    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID", "OPS"]);
    store.linkSpaces(repoId, other, []);
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID"]);
  });

  it("removes the work items not in the set it is given, and reports how many went", () => {
    const [space] = store.linkSpaces(repoId, site, [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" }), workItem({ key: "WID-2" }), workItem({ key: "WID-3" })]);

    expect(store.removeWorkItemsExcept(space!.id, new Set(["WID-2"]))).toBe(2);

    expect(store.workItems(space!.id).map((i) => i.key)).toEqual(["WID-2"]);
  });

  it("removes work items only from the space it is asked about", () => {
    const [a, b] = store.linkSpaces(repoId, site, [wid, gad]);
    store.upsertWorkItems(a!.id, [workItem({ key: "WID-1" })]);
    store.upsertWorkItems(b!.id, [workItem({ key: "GAD-1" })]);

    store.removeWorkItemsExcept(a!.id, new Set());

    expect(store.workItemCount(a!.id)).toBe(0);
    expect(store.workItemCount(b!.id)).toBe(1);
  });

  it("removes a space no repository links to any more, with its work items", () => {
    const [space] = store.linkSpaces(repoId, site, [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);

    store.linkSpaces(repoId, site, []);

    expect(store.getSpace(space!.id)).toBeNull();
    expect(store.workItemCount(space!.id)).toBe(0);
  });

  it("keeps a space another repository still links to", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const [space] = store.linkSpaces(repoId, site, [wid]);
    store.linkSpaces(other, site, [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);

    store.linkSpaces(repoId, site, []);

    expect(store.getSpace(space!.id)).not.toBeNull();
    expect(store.workItemCount(space!.id)).toBe(1);
    expect(store.spacesFor(other).map((s) => s.id)).toEqual([space!.id]);
  });

  it("links a space once however many times it is listed", () => {
    expect(store.linkSpaces(repoId, site, [wid, wid])).toHaveLength(1);
  });

  it("removes links, orphaned spaces and work items when the repository is deleted, but not a shared space", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const [alone, shared] = store.linkSpaces(repoId, site, [gad, wid]);
    store.linkSpaces(other, site, [wid]);
    store.upsertWorkItems(alone!.id, [workItem({ key: "GAD-1", spaceKey: "GAD" })]);

    store.deleteRepo(repoId);

    expect(store.spacesFor(repoId)).toEqual([]);
    expect(store.getSpace(alone!.id)).toBeNull();
    expect(store.workItemCount(alone!.id)).toBe(0);
    expect(store.getSpace(shared!.id)).not.toBeNull();
  });

  it("stores statuses and board columns on the space", () => {
    const [space] = store.linkSpaces(repoId, site, [wid]);
    const statuses = [{ id: "1", name: "To Do", category: "todo" as const }];
    const columns = [{ name: "Backlog", statusIds: ["1"] }];

    store.setSpaceDetails(space!.id, statuses, columns, "read");

    expect(store.getSpace(space!.id)).toMatchObject({ statuses, columns, board: "read" });
  });

  it.each(["none", "forbidden"] as const)("keeps %s as how the board was read, with no columns", (board) => {
    const [space] = store.linkSpaces(repoId, site, [wid]);

    store.setSpaceDetails(space!.id, [], [], board);

    expect(store.getSpace(space!.id)).toMatchObject({ columns: [], board });
    expect(store.listSpaces()[0]!.board).toBe(board);
  });

  it("refreshes the site URL of a space linked again, and creates every space on the site it is given", () => {
    store.linkSpaces(repoId, site, [wid]);

    const [moved] = store.linkSpaces(repoId, { id: "cloud-1", url: "https://renamed.example.test" }, [wid]);

    expect(moved).toMatchObject({ siteId: "cloud-1", siteUrl: "https://renamed.example.test" });
    expect(store.listSpaces()).toHaveLength(1);
  });

  it("records crawl state, then clears progress and error and stamps the time on finish", () => {
    const [space] = store.linkSpaces(repoId, site, [wid]);
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
    const [space] = store.linkSpaces(repoId, site, [wid]);
    expect(store.spaceCrawlCursor(space!.id)).toBeNull();

    store.finishSpaceCrawl(space!.id, "2026-09-02T00:00:00Z");
    store.finishSpaceCrawl(space!.id, null);
    expect(store.spaceCrawlCursor(space!.id)).toBe("2026-09-02T00:00:00Z");

    store.resetSpaceCrawlCursor(space!.id);
    expect(store.spaceCrawlCursor(space!.id)).toBeNull();
    expect(store.spaceCrawlCursor(9999)).toBeNull();
  });

  it("upserts work items by key, so a changed item replaces its earlier copy", () => {
    const [space] = store.linkSpaces(repoId, site, [wid]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1", status: "To Do" }), workItem({ key: "WID-2" })]);
    store.upsertWorkItems(space!.id, [workItem({ key: "WID-1", status: "Done" })]);

    expect(store.workItemCount(space!.id)).toBe(2);
    expect(store.workItems(space!.id).find((i) => i.key === "WID-1")!.status).toBe("Done");
  });

  it("keeps work items apart by space", () => {
    const [a, b] = store.linkSpaces(repoId, site, [wid, gad]);
    store.upsertWorkItems(a!.id, [workItem({ key: "WID-1" })]);

    expect(store.workItemCount(a!.id)).toBe(1);
    expect(store.workItemCount(b!.id)).toBe(0);
    expect(store.workItems(b!.id)).toEqual([]);
  });

  describe("a failed write", () => {
    it("rolls back linking spaces to a repository that does not exist, and the store still works", () => {
      expect(() => store.linkSpaces(9999, site, [wid])).toThrow();
      // The space inserted before the link failed went with the rollback.
      expect(store.listSpaces()).toEqual([]);

      expect(store.linkSpaces(repoId, site, [wid]).map((s) => s.key)).toEqual(["WID"]);
    });

    it("rolls back a batch of work items that fails part way, and the store still works", () => {
      const [space] = store.linkSpaces(repoId, site, [wid]);
      const bad = { ...workItem({ key: "WID-2" }), updatedAt: undefined as unknown as string };

      expect(() => store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" }), bad])).toThrow();
      expect(store.workItemCount(space!.id)).toBe(0);

      store.upsertWorkItems(space!.id, [workItem({ key: "WID-1" })]);
      expect(store.workItemCount(space!.id)).toBe(1);
    });

    it("rolls back removing work items when a delete fails, and the store still works", () => {
      const [space] = store.linkSpaces(repoId, site, [wid]);
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
    const [space] = first.linkSpaces(repoId, site, [wid]);
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
    const [space] = store.linkSpaces(repoId, site, [wid]);
    expect("people" in store.getSpace(space!.id)!).toBe(false);

    store.setSpacePeople(space!.id, { "acct-1": "Someone" });
    expect(store.getSpace(space!.id)!.people).toEqual({ "acct-1": "Someone" });
    expect(store.spacesFor(repoId)[0]!.people).toEqual({ "acct-1": "Someone" });

    // Saving replaces the map, and an empty map reads back as empty rather than absent.
    store.setSpacePeople(space!.id, {});
    expect(store.getSpace(space!.id)!.people).toEqual({});
  });

  it("lists every space across repositories, ordered by site then key", () => {
    const gadgets = store.addRepo("acme", "gadgets", [], "main").id;
    const ops = { key: "OPS", name: "Operations" };
    store.linkSpaces(repoId, site, [wid]);
    store.linkSpaces(gadgets, site, [gad]);
    store.linkSpaces(gadgets, { id: "cloud-0", url: "https://other.example.test" }, [ops]);

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
    const [space] = store.linkSpaces(repoId, site, [wid]);
    store.linkSpaces(gadgets, site, [wid]);
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
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, site, [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run(saved, id);
    db.close();

    const store = new SqliteRepoStore(path);

    expect(store.getSpace(id)).toMatchObject({ key: "WID", name: "Widgets" });
    expect("people" in store.getSpace(id)!).toBe(false);
    expect("people" in store.listSpaces()[0]!).toBe(false);
  });

  it("adds the board column, reading existing spaces as read with columns, none when crawled without, and not yet read otherwise", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO tracker_spaces (site_id, site_url, space_key, name, last_crawled_at) VALUES (?, ?, ?, ?, ?)").run(
      "cloud-1",
      "https://acme.example.test",
      "OPS",
      "Operations",
      "2026-09-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO tracker_spaces (site_id, site_url, space_key, name, columns) VALUES (?, ?, ?, ?, ?)").run(
      "cloud-1",
      "https://acme.example.test",
      "GAD",
      "Gadgets",
      JSON.stringify([{ name: "Backlog", statusIds: ["1"] }]),
    );
    db.close();

    const store = new SqliteRepoStore(path);

    expect(store.listSpaces().map((s) => [s.key, s.board])).toEqual([
      ["GAD", "read"],
      ["OPS", "none"],
      ["WID", null],
    ]);
  });

  it("migrates in one go, and a second open changes nothing", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    new SqliteRepoStore(path);
    const columns = () => {
      const db = new DatabaseSync(path);
      const found = db.prepare("PRAGMA table_info(tracker_spaces)").all() as unknown as { name: string; notnull: number }[];
      db.close();
      return found.filter((c) => c.name === "board");
    };
    expect(columns()).toEqual([expect.objectContaining({ name: "board", notnull: 0 })]);

    const again = new SqliteRepoStore(path);

    expect(columns()).toHaveLength(1);
    expect(again.listSpaces()[0]!.board).toBeNull();
  });

  it("rebuilds an earlier NOT NULL board column, so a space never read stops saying there is no board and a refused one stays refused", () => {
    const path = join(dir, "earlier.db");
    oldDatabase(path);
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE tracker_spaces ADD COLUMN board TEXT NOT NULL DEFAULT 'none'");
    const add = db.prepare(
      "INSERT INTO tracker_spaces (site_id, site_url, space_key, name, board, last_crawled_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    add.run("cloud-1", "https://acme.example.test", "FRB", "Forbidden", "forbidden", "2026-09-01T00:00:00.000Z");
    add.run("cloud-1", "https://acme.example.test", "NON", "None", "none", "2026-09-01T00:00:00.000Z");
    db.close();

    const store = new SqliteRepoStore(path);

    expect(store.listSpaces().map((s) => [s.key, s.board])).toEqual([
      ["FRB", "forbidden"],
      ["NON", "none"],
      ["WID", null],
    ]);
    const check = new DatabaseSync(path);
    const names = (check.prepare("PRAGMA table_info(tracker_spaces)").all() as unknown as { name: string }[]).map((c) => c.name);
    check.close();
    expect(names).not.toContain("board_earlier");
    // New rows now start with the board not read.
    const repo = store.addRepo("acme", "widgets", [], "main").id;
    expect(store.linkSpaces(repo, site, [{ key: "NEW", name: "New" }])[0]!.board).toBeNull();
  });

  it("leaves the table as it was when the migration fails part-way", () => {
    const path = join(dir, "failing.db");
    oldDatabase(path);
    const db = new DatabaseSync(path);
    // A trigger makes the backfill UPDATE fail after the ALTER has run.
    db.exec("CREATE TRIGGER refuse BEFORE UPDATE ON tracker_spaces BEGIN SELECT RAISE(ABORT, 'refused'); END");
    db.close();

    expect(() => new SqliteRepoStore(path)).toThrow("refused");

    const check = new DatabaseSync(path);
    const names = (check.prepare("PRAGMA table_info(tracker_spaces)").all() as unknown as { name: string }[]).map((c) => c.name);
    check.close();
    expect(names).not.toContain("board");
  });

  it("migrates the board column once, so reopening does not turn a refused board into a read one", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    const first = new SqliteRepoStore(path);
    first.setSpaceDetails(first.listSpaces()[0]!.id, [], [], "forbidden");

    const second = new SqliteRepoStore(path);

    expect(second.listSpaces()[0]!.board).toBe("forbidden");
  });

  it("warns with the space id, and no names, when saved names are unreadable", () => {
    const path = join(dir, "logged.db");
    const first = new SqliteRepoStore(path);
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, site, [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run('{"acct-1": "Someone", broken', id);
    db.close();
    const warned: { context: Record<string, unknown>; message: string }[] = [];
    const store = new SqliteRepoStore(path, undefined, {
      info: () => undefined,
      error: () => undefined,
      warn: (context, message) => void warned.push({ context: context as Record<string, unknown>, message }),
    });

    store.getSpace(id);

    expect(warned).toHaveLength(1);
    expect(warned[0]!.context["spaceId"]).toBe(id);
    expect(warned[0]!.message).toContain("not readable");
    expect(JSON.stringify(warned)).not.toContain("Someone");
  });

  it("warns with the space id when saved names are valid JSON but not a map", () => {
    const path = join(dir, "shape.db");
    const first = new SqliteRepoStore(path);
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, site, [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run("[1, 2]", id);
    db.close();
    const warned: object[] = [];
    const store = new SqliteRepoStore(path, undefined, {
      info: () => undefined,
      error: () => undefined,
      warn: (context) => void warned.push(context),
    });

    expect(store.getSpace(id)!.people).toBeUndefined();
    expect(warned).toEqual([{ spaceId: id }]);
  });

  it("keeps only string names from saved names, and warns about nothing", () => {
    const path = join(dir, "mixed.db");
    const first = new SqliteRepoStore(path);
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, site, [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run(
      JSON.stringify({ "acct-1": "Someone", "acct-2": 42, "acct-3": null, "acct-4": { name: "Nested" }, "acct-5": ["x"] }),
      id,
    );
    db.close();
    const warned: object[] = [];
    const store = new SqliteRepoStore(path, undefined, {
      info: () => undefined,
      error: () => undefined,
      warn: (context) => void warned.push(context),
    });

    expect(store.getSpace(id)!.people).toEqual({ "acct-1": "Someone" });
    expect(warned).toEqual([]);
  });

  it("restores names after unreadable ones with the next save, as a full crawl does", () => {
    const path = join(dir, "corrupt.db");
    const first = new SqliteRepoStore(path);
    const id = first.linkSpaces(first.addRepo("acme", "widgets", [], "main").id, site, [wid])[0]!.id;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run("{not json", id);
    db.close();
    const store = new SqliteRepoStore(path);
    expect(store.getSpace(id)!.people).toBeUndefined();

    store.setSpacePeople(id, { "acct-1": "Someone" });

    expect(store.getSpace(id)!.people).toEqual({ "acct-1": "Someone" });
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

describe("the store's clock", () => {
  const at = new Date("2026-03-04T05:06:07.000Z");

  it("stamps a repository's added time and every crawl finish from the clock it was given", () => {
    const store = new SqliteRepoStore(":memory:", () => at);
    const repo = store.addRepo("acme", "widgets", [], "main");
    const [space] = store.linkSpaces(repo.id, site, [wid]);

    store.finishCrawl(repo.id, null);
    store.finishSpaceCrawl(space!.id, null);

    expect(repo.addedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(store.getRepo(repo.id)!.lastCrawledAt).toBe("2026-03-04T05:06:07.000Z");
    expect(store.getSpace(space!.id)!.lastCrawledAt).toBe("2026-03-04T05:06:07.000Z");
  });

  it("reads the clock afresh each time, so a later crawl carries a later stamp", () => {
    let now = at;
    const store = new SqliteRepoStore(":memory:", () => now);
    const repo = store.addRepo("acme", "widgets", [], "main");
    store.finishCrawl(repo.id, null);

    now = new Date("2026-03-05T00:00:00.000Z");
    store.finishCrawl(repo.id, null);

    expect(store.getRepo(repo.id)!.lastCrawledAt).toBe("2026-03-05T00:00:00.000Z");
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

  describe("idle expiry", () => {
    const HOUR = 3_600_000;
    let now: number;
    let store: MemoryTrackerGrantStore;
    beforeEach(() => {
      now = 1_000_000;
      store = new MemoryTrackerGrantStore(8 * HOUR, () => now);
    });

    it("drops a grant not read or written for longer than the idle time", () => {
      store.set("alice", grant({ accessToken: "a" }));

      now += 8 * HOUR + 1;

      expect(store.get("alice")).toBeNull();
    });

    it("keeps a grant at exactly the idle time", () => {
      store.set("alice", grant({ accessToken: "a" }));

      now += 8 * HOUR;

      expect(store.get("alice")!.accessToken).toBe("a");
    });

    it("counts every read as use, so a crawl reading the grant keeps it alive", () => {
      store.set("alice", grant({ accessToken: "a" }));

      for (let i = 0; i < 4; i++) {
        now += 5 * HOUR;
        expect(store.get("alice")!.accessToken).toBe("a");
      }
    });

    it("counts a write as use, so a refreshed grant starts its idle time again", () => {
      store.set("alice", grant({ accessToken: "a" }));
      now += 7 * HOUR;
      store.set("alice", grant({ accessToken: "b" }));

      now += 7 * HOUR;

      expect(store.get("alice")!.accessToken).toBe("b");
    });

    it("drops idle grants of other logins as well, without waiting for them to come back", () => {
      store.set("alice", grant({ accessToken: "a" }));
      now += 6 * HOUR;
      store.set("bob", grant({ accessToken: "b" }));
      now += 3 * HOUR;

      expect(store.get("bob")!.accessToken).toBe("b");
      expect(store.get("alice")).toBeNull();
    });

    it("lasts as long as a dashboard session by default", () => {
      const original = Date.now;
      let clock = 5_000_000;
      Date.now = () => clock;
      try {
        const standard = new MemoryTrackerGrantStore();
        standard.set("alice", grant());
        clock += 8 * HOUR - 1;
        expect(standard.get("alice")).not.toBeNull();
        clock += 8 * HOUR + 1;
        expect(standard.get("alice")).toBeNull();
      } finally {
        Date.now = original;
      }
    });
  });

  describe("why a grant was dropped", () => {
    const HOUR = 3_600_000;
    let now: number;
    let store: MemoryTrackerGrantStore;
    let dropped: string[];
    beforeEach(() => {
      now = 1_000_000;
      store = new MemoryTrackerGrantStore(8 * HOUR, () => now);
      dropped = [];
      store.onDrop((reason) => void dropped.push(reason));
    });

    it("remembers a refused drop, tells the listener, and answers null for a login never dropped", () => {
      store.set("alice", grant());
      store.drop("alice", "refused");

      expect(store.get("alice")).toBeNull();
      expect(store.lapsed("alice")).toBe("refused");
      expect(store.lapsed("bob")).toBeNull();
      expect(dropped).toEqual(["refused"]);
    });

    it("remembers an idle sweep and tells the listener once, whichever login's call swept it", () => {
      store.set("alice", grant());
      now += 8 * HOUR + 1;

      store.set("bob", grant());

      expect(store.lapsed("alice")).toBe("idle");
      expect(dropped).toEqual(["idle"]);
      store.get("bob");
      expect(dropped).toEqual(["idle"]);
    });

    it("forgets the reason after a day", () => {
      store.drop("alice", "refused");
      now += LAPSE_MEMORY_MS;
      expect(store.lapsed("alice")).toBe("refused");
      now += 1;
      expect(store.lapsed("alice")).toBeNull();
    });

    it("forgets the reason when the login connects again or disconnects on purpose", () => {
      store.drop("alice", "refused");
      store.set("alice", grant());
      expect(store.lapsed("alice")).toBeNull();

      store.drop("alice", "refused");
      store.delete("alice");
      expect(store.lapsed("alice")).toBeNull();
    });

    it("does not count asking why as use of a grant, and needs no listener", () => {
      const quiet = new MemoryTrackerGrantStore(8 * HOUR, () => now);
      quiet.set("alice", grant());
      quiet.drop("alice", "idle");
      expect(quiet.lapsed("alice")).toBe("idle");
    });
  });

  it("holds a copy, so changing the original does not change what is stored", () => {
    const store = new MemoryTrackerGrantStore();
    const original = grant({ accessToken: "a" });
    store.set("alice", original);
    (original as { accessToken: string }).accessToken = "changed";
    expect(store.get("alice")!.accessToken).toBe("a");
  });
});
