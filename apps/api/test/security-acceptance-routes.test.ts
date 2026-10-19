import { fingerprintOfFinding, fingerprintOfUse, type WorkflowFinding } from "@dora-dashboard/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { FakeCli, FakeProvider, config, rawDb, repoPosture, supplyChainFacts, supplyChainRecord } from "./fakes.js";

const NOW = new Date("2026-10-19T09:30:00Z");
const BLOB = "0123456789abcdef0123456789abcdef01234567";
const checkout: WorkflowFinding = {
  file: ".github/workflows/db.yml",
  line: 31,
  risk: "prHeadCheckout",
  evidence: "github.event.workflow_run.head_sha",
  lineHash: "00112233aabbccdd",
  reachHash: "0123456789abcdef",
};
const unpinned = {
  file: ".github/workflows/ci.yml",
  line: 12,
  action: "zed/tool",
  ref: "v1",
  pinned: false,
  kind: "other" as const,
};
const body = (overrides: Record<string, unknown> = {}) => ({
  check: "prHeadCheckout",
  path: checkout.file,
  fingerprint: fingerprintOfFinding(checkout),
  reason: "guarded_elsewhere",
  note: "Only push runs reach this job.",
  ...overrides,
});

describe("the acceptance routes", () => {
  let app: FastifyInstance;
  let store: SqliteRepoStore;
  let cli: FakeCli;
  let id: number;
  const url = () => `/api/repos/${id}/security/acceptances`;
  const post = (payload: unknown, headers: Record<string, string> = {}, path = url()) =>
    app.inject({ method: "POST", url: path, payload: payload as never, headers });

  beforeEach(async () => {
    store = new SqliteRepoStore(":memory:");
    cli = new FakeCli();
    const built = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli,
      clock: () => NOW,
      exchangeCode: async () => "unused",
    });
    app = built.app;
    id = store.addRepo("acme", "widgets", [], "main").id;
    store.finishCrawl(id, null);
    store.saveSupplyChain(
      id,
      supplyChainRecord({
        facts: supplyChainFacts({
          findings: [checkout],
          actions: [unpinned],
          securityTools: [{ tool: "github/codeql-action/analyze", category: "sast", file: "ci.yml" }],
          keyFiles: [{ path: ".env.production", blob: BLOB, strength: "strong" }],
        }),
      }),
      [],
    );
    store.savePosture(id, repoPosture({ visibility: "private" }), "2026-10-19T09:00:00.000Z");
  });
  afterEach(async () => {
    await app.close();
  });

  describe("access", () => {
    it("answers 401 to both routes without a session", async () => {
      cli.error = new UnauthorisedError("run gh auth login");
      expect((await post(body())).statusCode).toBe(401);
      expect((await app.inject({ method: "DELETE", url: `${url()}/1` })).statusCode).toBe(401);
      expect(store.acceptances(id)).toEqual([]);
    });

    it("answers 403 to a request from another origin, before anything is read or stored", async () => {
      const post403 = await post(body(), { origin: "https://evil.example" });
      expect(post403.statusCode).toBe(403);
      const accepted = (await post(body())).json<{ id: number }>();
      const del403 = await app.inject({
        method: "DELETE",
        url: `${url()}/${accepted.id}`,
        headers: { origin: "https://evil.example" },
      });
      expect(del403.statusCode).toBe(403);
      expect(store.acceptances(id)).toHaveLength(1);
    });

    it("allows the dashboard's own origin", async () => {
      expect((await post(body(), { origin: "http://localhost:5181" })).statusCode).toBe(201);
    });
  });

  describe("accepting", () => {
    it("answers 201 with the acceptance, its line and the time from the clock, and nothing about a person", async () => {
      const res = await post(body());

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: 1,
        check: "prHeadCheckout",
        path: ".github/workflows/db.yml",
        line: 31,
        fingerprint: fingerprintOfFinding(checkout),
        reason: "guarded_elsewhere",
        note: "Only push runs reach this job.",
        acceptedAt: "2026-10-19T09:30:00.000Z",
      });
      expect(res.body).not.toMatch(/login|session|token/i);
    });

    it("lifts the report's grade and shows the band before, then restores it when removed", async () => {
      const band = async () => {
        const report = (await app.inject(`/api/repos/${id}/security`)).json();
        return { band: report.grade.overall.band, accepted: report.accepted, views: report.acceptances };
      };
      const before = await band();
      expect(before).toMatchObject({ band: "low", accepted: { graded: 0, bandBefore: null }, views: [] });

      const { id: acceptanceId } = (await post(body())).json<{ id: number }>();
      const after = await band();
      expect(after.band).toBe("high");
      expect(after.accepted).toEqual({ graded: 1, advice: 0, bandBefore: "low", supplyChainBefore: "low" });
      expect(after.views).toEqual([expect.objectContaining({ status: "applies", covers: 1, graded: true })]);
      expect(((await app.inject("/api/security")).json() as { accepted: unknown }[])[0]!.accepted).toEqual({
        graded: 1,
        bandBefore: "low",
      });

      expect((await app.inject({ method: "DELETE", url: `${url()}/${acceptanceId}` })).statusCode).toBe(204);
      expect(await band()).toEqual(before);
      expect(((await app.inject("/api/security")).json() as { accepted: unknown }[])[0]!.accepted).toEqual({
        graded: 0,
        bandBefore: null,
      });
    });

    it("accepts an action use, a key file and an absence", async () => {
      const posted = [
        body({ check: "unpinnedActions", path: unpinned.file, fingerprint: fingerprintOfUse(unpinned) }),
        body({ check: "keyFiles", path: ".env.production", fingerprint: `b:${BLOB}`, reason: "public_by_design" }),
        body({ check: "dependencyReview", path: null, fingerprint: "n1:", reason: "risk_accepted" }),
      ];
      for (const payload of posted) expect((await post(payload)).statusCode).toBe(201);
      expect(store.acceptances(id).map((a) => [a.check, a.path, a.line])).toEqual([
        ["unpinnedActions", unpinned.file, 12],
        ["keyFiles", ".env.production", null],
        ["dependencyReview", null, null],
      ]);
    });

    it("answers 404 for an unknown repository", async () => {
      expect((await post(body(), {}, "/api/repos/999/security/acceptances")).statusCode).toBe(404);
    });

    it("answers 409 with a code for a finding that is not in the latest read, a duplicate, and a repository with no record", async () => {
      const changed = await post(body({ path: "gone.yml" }));
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "acceptance_finding_changed" });
      expect((await post(body())).statusCode).toBe(201);
      const duplicate = await post(body({ note: "Again." }));
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: "That finding is already accepted", code: "acceptance_duplicate" });
      const bare = store.addRepo("acme", "gadgets", [], "main").id;
      const none = await post(body(), {}, `/api/repos/${bare}/security/acceptances`);
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ code: "acceptance_no_record" });
    });

    it("answers 409 with the limit code once the repository holds 500 acceptances", async () => {
      const insert = rawDb(store).prepare(
        "INSERT INTO security_acceptances (repo_id, check_id, path, line, fingerprint, reason, note, accepted_at) VALUES (?, 'lockfiles', ?, NULL, 'p1:', 'risk_accepted', 'x', 't')",
      );
      for (let n = 0; n < 500; n++) insert.run(id, `p${n}/package.json`);

      const limited = await post(body());

      expect(limited.statusCode).toBe(409);
      expect(limited.json()).toMatchObject({ code: "acceptance_limit" });
    });

    it("answers 400 for a note that is only spaces, as the service does for a note the schema lets through", async () => {
      expect((await post(body({ note: "   " }))).statusCode).toBe(400);
    });

    it.each([
      ["a missing field", (b: Record<string, unknown>) => (delete b.note, b)],
      ["an unknown field", (b: Record<string, unknown>) => ({ ...b, login: "alice" })],
      ["an unknown check", (b: Record<string, unknown>) => ({ ...b, check: "everything" })],
      ["an unknown reason", (b: Record<string, unknown>) => ({ ...b, reason: "because" })],
      ["a fingerprint of no known kind", (b: Record<string, unknown>) => ({ ...b, fingerprint: "w9:0123456789abcdef" })],
      ["a fingerprint that is too long", (b: Record<string, unknown>) => ({ ...b, fingerprint: `b:${"a".repeat(81)}` })],
      ["a path with a control character", (b: Record<string, unknown>) => ({ ...b, path: "a\u0000b.yml" })],
      ["a path of nothing", (b: Record<string, unknown>) => ({ ...b, path: "" })],
      ["a path of more than 1,000 characters", (b: Record<string, unknown>) => ({ ...b, path: "a".repeat(1001) })],
      ["an empty note", (b: Record<string, unknown>) => ({ ...b, note: "" })],
      ["a note with a line break", (b: Record<string, unknown>) => ({ ...b, note: "one\ntwo" })],
      ["a note with a control character", (b: Record<string, unknown>) => ({ ...b, note: "bell\u0007" })],
      ["a note of 281 characters", (b: Record<string, unknown>) => ({ ...b, note: "x".repeat(281) })],
    ])("answers 400 for %s", async (_what, change) => {
      const res = await post(change(body()));
      expect(res.statusCode).toBe(400);
      expect(store.acceptances(id)).toEqual([]);
    });

    it("answers 400 for a repository id that is not a positive integer", async () => {
      expect((await post(body(), {}, "/api/repos/0/security/acceptances")).statusCode).toBe(400);
      expect((await post(body(), {}, "/api/repos/abc/security/acceptances")).statusCode).toBe(400);
    });

    it("accepts a note of exactly 280 characters", async () => {
      expect((await post(body({ note: "x".repeat(280) }))).statusCode).toBe(201);
    });
  });

  describe("removing", () => {
    it("answers 204 with no body and removes the acceptance", async () => {
      const { id: acceptanceId } = (await post(body())).json<{ id: number }>();
      const res = await app.inject({ method: "DELETE", url: `${url()}/${acceptanceId}` });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(store.acceptances(id)).toEqual([]);
    });

    it("answers 404 for an unknown repository, an acceptance that is not there and another repository's", async () => {
      const other = store.addRepo("acme", "gadgets", [], "main").id;
      const { id: acceptanceId } = (await post(body())).json<{ id: number }>();

      expect(
        (await app.inject({ method: "DELETE", url: `/api/repos/999/security/acceptances/${acceptanceId}` })).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${url()}/42` })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/repos/${other}/security/acceptances/${acceptanceId}` })).statusCode,
      ).toBe(404);
      expect(store.acceptances(id)).toHaveLength(1);
    });

    it("answers 400 for an acceptance id that is not a positive integer", async () => {
      expect((await app.inject({ method: "DELETE", url: `${url()}/0` })).statusCode).toBe(400);
      expect((await app.inject({ method: "DELETE", url: `${url()}/abc` })).statusCode).toBe(400);
    });
  });

  describe("the rate limit", () => {
    const TOO_MANY = { error: "Too many requests. Please wait a moment and try again." };

    it("answers 429 to the 31st accept in a minute, counting every answer", async () => {
      for (let i = 0; i < 30; i++) expect((await post(body({ path: "gone.yml" }))).statusCode, `request ${i + 1}`).toBe(409);
      const limited = await post(body());
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual(TOO_MANY);
      expect(store.acceptances(id)).toEqual([]);
    });

    it("counts each route on its own, so 30 accepts and 30 removals a minute are both allowed", async () => {
      for (let i = 0; i < 30; i++) {
        expect((await app.inject({ method: "DELETE", url: `${url()}/42` })).statusCode, `request ${i + 1}`).toBe(404);
      }
      const limited = await app.inject({ method: "DELETE", url: `${url()}/42` });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual(TOO_MANY);
      // The accept route is counted on its own.
      expect((await post(body())).statusCode).toBe(201);
    });

    it("does not limit the report", async () => {
      for (let i = 0; i < 35; i++) expect((await app.inject(`/api/repos/${id}/security`)).statusCode).toBe(200);
    });
  });
});
