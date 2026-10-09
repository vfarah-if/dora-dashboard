import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { issue } from "./fakes.js";

describe("issues in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("reads an issue back exactly as it was stored, and replaces it by number", () => {
    const original = issue({
      number: 7,
      labels: ["bug"],
      closedBy: [{ repo: "acme/widgets", number: 9 }],
      eventsTruncated: true,
    });
    store.upsertIssues(repoId, [original, issue({ number: 8 })]);
    store.upsertIssues(repoId, [{ ...original, title: "Renamed", updatedAt: "2026-09-05T00:00:00Z" }]);

    const held = store.issues(repoId);

    expect(held).toHaveLength(2);
    expect(held.find((i) => i.number === 7)).toEqual({ ...original, title: "Renamed", updatedAt: "2026-09-05T00:00:00Z" });
  });

  it("returns issues newest update first, then by number", () => {
    store.upsertIssues(repoId, [
      issue({ number: 1, updatedAt: "2026-09-01T00:00:00Z" }),
      issue({ number: 3, updatedAt: "2026-09-03T00:00:00Z" }),
      issue({ number: 2, updatedAt: "2026-09-03T00:00:00Z" }),
      issue({ number: 4, updatedAt: "2026-09-02T00:00:00Z" }),
    ]);

    expect(store.issues(repoId).map((i) => i.number)).toEqual([2, 3, 4, 1]);
  });

  it("counts issues beside pull requests and deploy runs, per repository", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.upsertIssues(repoId, [issue({ number: 1 }), issue({ number: 2 })]);
    store.upsertIssues(other, [issue({ number: 1 })]);

    expect(store.counts(repoId)).toEqual({ pullRequests: 0, deployRuns: 0, issues: 2 });
    expect(store.counts(other).issues).toBe(1);
  });

  it("removes the issues not in the set to keep, and says how many went", () => {
    store.upsertIssues(
      repoId,
      [1, 2, 3].map((number) => issue({ number })),
    );

    const removed = store.removeIssuesExcept(repoId, new Set([2]));

    expect(removed).toBe(2);
    expect(store.issues(repoId).map((i) => i.number)).toEqual([2]);
  });

  it("leaves another repository alone when pruning, though both hold the same issue numbers", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.upsertIssues(
      repoId,
      [1, 2, 3].map((number) => issue({ number })),
    );
    store.upsertIssues(
      other,
      [1, 2, 3].map((number) => issue({ number })),
    );

    const removed = store.removeIssuesExcept(repoId, new Set([1]));

    expect(removed).toBe(2);
    expect(store.issues(repoId).map((i) => i.number)).toEqual([1]);
    expect(
      store
        .issues(other)
        .map((i) => i.number)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it("stores nothing when a later issue in the batch cannot be stored", () => {
    const broken = issue({ number: 2 });
    Object.defineProperty(broken, "toJSON", {
      value: () => {
        throw new Error("cannot serialise");
      },
    });

    expect(() => store.upsertIssues(repoId, [issue({ number: 1 }), broken])).toThrow("cannot serialise");

    expect(store.issues(repoId)).toEqual([]);
  });

  it("names the repository and the issue when a stored row cannot be read", () => {
    store.upsertIssues(repoId, [issue({ number: 41 })]);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE issues SET data = '{broken' WHERE repo_id = ? AND number = 41").run(repoId);

    expect(() => store.issues(repoId)).toThrow(`Stored issue #41 of repository ${repoId} is not readable`);
  });

  it("reads a closed row stored without a close time as closed at its last update", () => {
    store.upsertIssues(repoId, [issue({ number: 42, updatedAt: "2026-09-03T10:00:00Z" })]);
    const db = (store as unknown as { db: DatabaseSync }).db;
    const legacy = { ...store.issues(repoId)[0]!, state: "closed", closeReason: "completed", closedAt: null };
    db.prepare("UPDATE issues SET data = ? WHERE repo_id = ? AND number = 42").run(JSON.stringify(legacy), repoId);

    expect(store.issues(repoId)[0]).toMatchObject({ state: "closed", closedAt: "2026-09-03T10:00:00Z" });
  });

  it("indexes issues by repository, update time and number, the order the report reads them in", () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    const columns = db.prepare("PRAGMA index_info(idx_issues_repo_updated)").all() as unknown as { name: string }[];

    expect(columns.map((c) => c.name)).toEqual(["repo_id", "updated_at", "number"]);
  });

  it("switches issues off in one step, clearing issues, cursor and error and leaving other repositories alone", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.upsertIssues(repoId, [issue({ number: 1 })]);
    store.upsertIssues(other, [issue({ number: 1 })]);
    store.finishIssueCrawl(repoId, "2026-09-01T00:00:00.000Z");
    store.failIssueCrawl(repoId, "GitHub answered 500");

    store.disableIssues(repoId);

    expect(store.issues(repoId)).toEqual([]);
    expect(store.issues(other)).toHaveLength(1);
    expect(store.issueState(repoId)).toMatchObject({ enabled: false, cursor: null, error: null });
  });

  it("removes issues with their repository", () => {
    store.upsertIssues(repoId, [issue({ number: 1 })]);

    store.deleteRepo(repoId);

    const db = (store as unknown as { db: DatabaseSync }).db;
    expect((db.prepare("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
  });

  it("starts with nothing recorded about the issue crawl", () => {
    expect(store.issueState(repoId)).toEqual({ enabled: null, cursor: null, labels: null, labelsUnreadable: false, error: null });
    expect(store.issueState(999)).toEqual({ enabled: null, cursor: null, labels: null, labelsUnreadable: false, error: null });
  });

  it("records a finished crawl, and keeps the cursor when finishing with none", () => {
    store.finishIssueCrawl(repoId, "2026-09-01T00:00:00.000Z");
    store.finishIssueCrawl(repoId, null);

    expect(store.issueState(repoId)).toMatchObject({ enabled: true, cursor: "2026-09-01T00:00:00.000Z" });
  });

  it("records a failure without touching the cursor, and clears it when the next crawl finishes", () => {
    store.finishIssueCrawl(repoId, "2026-09-01T00:00:00.000Z");

    store.failIssueCrawl(repoId, "GitHub answered 500");
    expect(store.issueState(repoId)).toMatchObject({ error: "GitHub answered 500", cursor: "2026-09-01T00:00:00.000Z" });

    store.finishIssueCrawl(repoId, null);
    expect(store.issueState(repoId).error).toBeNull();
  });

  it("saves a label override, and clears it with null", () => {
    const rules = { kinds: { bug: ["defect"] }, priorities: { P0: ["sev1"] } };

    store.setIssueLabels(repoId, rules);
    expect(store.issueState(repoId).labels).toEqual(rules);

    store.setIssueLabels(repoId, null);
    expect(store.issueState(repoId).labels).toBeNull();
  });

  it("says a saved override is unreadable until a good one is saved", () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(store.issueState(repoId).labelsUnreadable).toBe(false);

    db.prepare("UPDATE repos SET issue_labels = '{not json' WHERE id = ?").run(repoId);
    expect(store.issueState(repoId)).toMatchObject({ labels: null, labelsUnreadable: true });

    db.prepare('UPDATE repos SET issue_labels = \'{"kinds":{"bug":"x"}}\' WHERE id = ?').run(repoId);
    expect(store.issueState(repoId).labelsUnreadable).toBe(true);

    store.setIssueLabels(repoId, { kinds: { bug: ["defect"] } });
    expect(store.issueState(repoId)).toMatchObject({ labels: { kinds: { bug: ["defect"] } }, labelsUnreadable: false });
  });

  it("reads labels that are not usable as no override, and logs which repository", () => {
    const warnings: unknown[] = [];
    const log: Logger = { info: () => undefined, error: () => undefined, warn: (context) => void warnings.push(context) };
    const logged = new SqliteRepoStore(":memory:", undefined, log);
    const id = logged.addRepo("acme", "widgets", [], "main").id;
    const db = (logged as unknown as { db: DatabaseSync }).db;

    for (const bad of ["{not json", "[1]", "7", "null"]) {
      db.prepare("UPDATE repos SET issue_labels = ? WHERE id = ?").run(bad, id);
      expect(logged.issueState(id).labels).toBeNull();
    }
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ repoId: id })]));
  });
});

describe("saved labels of the wrong shape", () => {
  const setup = () => {
    const warnings: Record<string, unknown>[] = [];
    const log: Logger = {
      info: () => undefined,
      error: () => undefined,
      warn: (context) => void warnings.push(context as Record<string, unknown>),
    };
    const store = new SqliteRepoStore(":memory:", undefined, log);
    const id = store.addRepo("acme", "widgets", [], "main").id;
    const db = (store as unknown as { db: DatabaseSync }).db;
    const save = (value: string) => db.prepare("UPDATE repos SET issue_labels = ? WHERE id = ?").run(value, id);
    return { warnings, store, id, save };
  };

  it.each([
    '{"kinds":{"bug":"x"}}',
    '{"kinds":{"bug":[1]}}',
    '{"kinds":{"nonsense":["a"]}}',
    '{"kinds":[]}',
    '{"priorities":{"P9":["a"]}}',
    '{"priorities":{"P0":"sev1"}}',
    '{"extra":1}',
  ])("reads %s as no override, so a report cannot throw on it", (bad) => {
    const { store, id, save, warnings } = setup();
    save(bad);

    expect(store.issueState(id).labels).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("accepts a valid override and an empty object", () => {
    const { store, id, save, warnings } = setup();
    save('{"kinds":{"epic":["epic"]},"priorities":{"P0":[]}}');
    expect(store.issueState(id).labels).toEqual({ kinds: { epic: ["epic"] }, priorities: { P0: [] } });
    save("{}");
    expect(store.issueState(id).labels).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("warns once per repository however often the state is read, and again after new labels are saved", () => {
    const { store, id, save, warnings } = setup();
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    save('{"kinds":{"bug":"x"}}');

    for (let i = 0; i < 5; i++) store.issueState(id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ repoId: id });

    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE repos SET issue_labels = ? WHERE id = ?").run("[1]", other);
    store.issueState(other);
    expect(warnings).toHaveLength(2);

    store.setIssueLabels(id, null);
    save('{"kinds":{"bug":"y"}}');
    store.issueState(id);
    expect(warnings).toHaveLength(3);
  });
});

describe("migrating a database made before issues were read", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The repos table as it was before the issue columns, holding one repository. */
  function oldDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      deploy_workflows TEXT NOT NULL DEFAULT '[]',
      deploy_branch TEXT NOT NULL DEFAULT 'main',
      added_at TEXT NOT NULL,
      last_crawled_at TEXT,
      crawl_status TEXT NOT NULL DEFAULT 'idle',
      crawl_error TEXT,
      crawl_progress TEXT,
      crawl_cursor TEXT,
      UNIQUE (owner, name)
    )`);
    db.prepare("INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', '2026-09-01T00:00:00Z')").run();
    db.close();
  }

  const issueColumns = (path: string) => {
    const db = new DatabaseSync(path);
    const found = db.prepare("PRAGMA table_info(repos)").all() as unknown as { name: string }[];
    db.close();
    return found.map((c) => c.name).filter((name) => name.startsWith("issue"));
  };

  it("adds the issue columns, keeps the repository, and lets issues be stored", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);

    const store = new SqliteRepoStore(path);

    expect(issueColumns(path)).toEqual(["issues_enabled", "issue_cursor", "issue_labels", "issue_error"]);
    const repo = store.findRepo("acme", "widgets")!;
    expect(store.issueState(repo.id)).toEqual({
      enabled: null,
      cursor: null,
      labels: null,
      labelsUnreadable: false,
      error: null,
    });
    store.upsertIssues(repo.id, [issue({ number: 1 })]);
    expect(store.counts(repo.id).issues).toBe(1);
  });

  it("changes nothing when opened a second time", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    const first = new SqliteRepoStore(path);
    const id = first.findRepo("acme", "widgets")!.id;
    first.finishIssueCrawl(id, "2026-09-01T00:00:00.000Z");
    first.setIssueLabels(id, { kinds: { bug: ["defect"] } });

    const again = new SqliteRepoStore(path);

    expect(issueColumns(path)).toHaveLength(4);
    expect(again.issueState(id)).toEqual({
      enabled: true,
      cursor: "2026-09-01T00:00:00.000Z",
      labels: { kinds: { bug: ["defect"] } },
      labelsUnreadable: false,
      error: null,
    });
  });
});
