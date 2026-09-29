import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { parseRepoRef } from "../src/services/repo-ref.js";
import { RepoService } from "../src/services/repo-service.js";
import { ReportService } from "../src/services/report-service.js";
import { FakeProvider, pr } from "./fakes.js";

describe("parseRepoRef", () => {
  it.each([
    ["acme/widgets", { owner: "acme", name: "widgets" }],
    ["https://github.com/acme/widgets/", { owner: "acme", name: "widgets" }],
    ["git@github.com:acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["https://gitlab.example.test/acme/widgets", { owner: "acme", name: "widgets" }],
    ["  acme/my.repo-1  ", { owner: "acme", name: "my.repo-1" }],
  ])("reads %s", (input, expected) => {
    expect(parseRepoRef(input)).toEqual(expected);
  });

  it.each(["widgets", "", "acme/", "a b/c d"])("rejects %j", (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });
});

describe("RepoService", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let service: RepoService;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    service = new RepoService(store, provider);
    provider.seed("acme/widgets", { workflows: ["ci.yml", "deploy-prod.yml", "release.yml"] });
  });

  it("picks the first deploy-looking workflow when none is named", async () => {
    const repo = await service.add("token", { repo: "https://github.com/acme/widgets" });
    expect(repo).toMatchObject({ owner: "acme", name: "widgets", deployWorkflows: ["deploy-prod.yml"], deployBranch: "main" });
  });

  it("keeps the named workflows and branch, trimmed", async () => {
    const repo = await service.add("token", {
      repo: "acme/widgets",
      deployWorkflows: [" ship.yml ", ""],
      deployBranch: " trunk ",
    });
    expect(repo).toMatchObject({ deployWorkflows: ["ship.yml"], deployBranch: "trunk" });
  });

  it("refuses an unreadable reference, a duplicate, and a repository the credential cannot see", async () => {
    await expect(service.add("token", { repo: "nonsense" })).rejects.toBeInstanceOf(ValidationError);
    await service.add("token", { repo: "acme/widgets" });
    await expect(service.add("token", { repo: "ACME/Widgets" })).rejects.toBeInstanceOf(ConflictError);
    await expect(service.add("token", { repo: "acme/secret" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists repositories with their stored counts", async () => {
    const repo = await service.add("token", { repo: "acme/widgets" });
    store.upsertPullRequests(repo.id, [pr({ number: 1 })]);
    expect(service.list()).toEqual([expect.objectContaining({ id: repo.id, pullRequests: 1, deployRuns: 0 })]);
  });

  it("reconfigures, lists workflows and removes", async () => {
    const repo = await service.add("token", { repo: "acme/widgets" });
    expect(service.configure(repo.id, ["release.yml"], "")).toMatchObject({
      deployWorkflows: ["release.yml"],
      deployBranch: "main",
    });
    expect(await service.workflows("token", repo.id)).toHaveLength(3);
    service.remove(repo.id);
    expect(() => service.get(repo.id)).toThrow(NotFoundError);
    expect(() => service.configure(repo.id, [], "main")).toThrow(NotFoundError);
  });
});

describe("ReportService", () => {
  let store: SqliteRepoStore;
  let service: ReportService;
  let a: number;
  let b: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    service = new ReportService(store);
    a = store.addRepo("acme", "widgets", [], "main").id;
    b = store.addRepo("acme", "gadgets", [], "main").id;
    store.upsertPullRequests(a, [pr({ number: 1 }), pr({ number: 2, author: "dependabot[bot]" })]);
  });

  it("builds a report from stored rows, excluding bots unless asked", () => {
    expect(service.report(a, { to: "2026-09-30" }).totals.merged).toBe(1);
    expect(service.report(a, { to: "2026-09-30", includeBots: true }).totals.merged).toBe(2);
  });

  it("compares repositories in the order asked for", () => {
    expect(service.compare([b, a]).map((r) => r.repo.name)).toEqual(["gadgets", "widgets"]);
  });

  it("rejects malformed or inverted ranges, unknown ids and an empty comparison", () => {
    expect(() => service.report(a, { from: "01/09/2026" })).toThrow(ValidationError);
    expect(() => service.report(a, { from: "2026-09-10", to: "2026-09-01" })).toThrow("from must not be after to");
    expect(() => service.report(999)).toThrow(NotFoundError);
    expect(() => service.compare([])).toThrow(ValidationError);
  });
});
