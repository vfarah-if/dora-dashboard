import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceOk, SourceState } from "@dora-dashboard/core";
import { NOT_USED_REASONS } from "@dora-dashboard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import {
  acceptance,
  codeScanningAlert,
  dependabotAlert,
  lockedPackage,
  osvAlert,
  rawDb,
  repoPosture,
  scorecardResult,
  secretScanningAlert,
  supplyChainFacts,
  supplyChainRecord,
} from "./fakes.js";

const okState = (overrides: Partial<SourceOk> = {}): SourceState => ({
  status: "ok",
  readAt: "2026-09-29T10:00:00.000Z",
  attemptedAt: "2026-09-29T10:00:00.000Z",
  truncated: false,
  skipped: 0,
  ...overrides,
});

describe("security alerts in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("reads each kind of alert back exactly as it was stored", () => {
    const all = [dependabotAlert({ key: "1" }), codeScanningAlert({ key: "2" }), secretScanningAlert({ key: "3" })];
    store.saveSecurityAlerts(repoId, "dependabot", [all[0]!], "replace");
    store.saveSecurityAlerts(repoId, "code_scanning", [all[1]!], "replace");
    store.saveSecurityAlerts(repoId, "secret_scanning", [all[2]!], "replace");

    // Ordered by source, then key.
    expect(store.securityAlerts(repoId)).toEqual([all[1], all[0], all[2]]);
  });

  it("replaces an alert by source and key, so the same number under two sources is two alerts", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "high" })], "replace");
    store.saveSecurityAlerts(repoId, "osv", [osvAlert({ key: "1" })], "replace");
    store.saveSecurityAlerts(
      repoId,
      "dependabot",
      [dependabotAlert({ key: "1", severity: "low", state: "fixed", closedAt: "2026-09-05T00:00:00Z" })],
      "replace",
    );

    const held = store.securityAlerts(repoId);

    expect(held).toHaveLength(2);
    expect(held.find((a) => a.source === "dependabot")).toMatchObject({ severity: "low", state: "fixed" });
  });

  it("removes the alerts a complete read did not see, and only those of the same source and repository", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.saveSecurityAlerts(
      repoId,
      "dependabot",
      [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" }), dependabotAlert({ key: "3" })],
      "replace",
    );
    store.saveSecurityAlerts(repoId, "code_scanning", [codeScanningAlert({ key: "1" })], "replace");
    store.saveSecurityAlerts(other, "dependabot", [dependabotAlert({ key: "9" })], "replace");

    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "2" })], "replace");

    expect(store.securityAlerts(repoId).map((a) => `${a.source}:${a.key}`)).toEqual(["code_scanning:1", "dependabot:2"]);
    expect(store.securityAlerts(other)).toHaveLength(1);
  });

  it("keeps the alerts a partial read did not see", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], "replace");

    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "2", severity: "low" })], "merge");

    expect(store.securityAlerts(repoId).map((a) => a.key)).toEqual(["1", "2"]);
    expect(store.securityAlerts(repoId)[1]).toMatchObject({ severity: "low" });
  });

  it("empties a complete read that found nothing", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert()], "replace");
    store.saveSecurityAlerts(repoId, "dependabot", [], "replace");
    expect(store.securityAlerts(repoId)).toEqual([]);
  });

  it("saves and prunes in one transaction, so an alert that cannot be saved leaves everything as it was", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], "replace");
    // The second alert is filed under the wrong source, which the store refuses after saving the first.
    const wrong = codeScanningAlert({ key: "5" });

    expect(() =>
      store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "low" }), wrong as never], "replace"),
    ).toThrow("cannot be saved as dependabot");

    const held = store.securityAlerts(repoId);
    expect(held.map((a) => a.key)).toEqual(["1", "2"]);
    expect(held[0]).toMatchObject({ severity: "high" });
  });

  it("rolls back a prune that fails part way", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], "replace");
    rawDb(store).exec(
      "CREATE TRIGGER stop_deletes BEFORE DELETE ON security_alerts BEGIN SELECT RAISE(ABORT, 'no deleting'); END",
    );

    expect(() =>
      store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "low" })], "replace"),
    ).toThrow("no deleting");

    expect(store.securityAlerts(repoId).map((a) => `${a.key}:${a.source === "dependabot" ? a.severity : ""}`)).toEqual([
      "1:high",
      "2:high",
    ]);
  });

  it("clears one source's alerts and no other's", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert()], "replace");
    store.saveSecurityAlerts(repoId, "code_scanning", [codeScanningAlert()], "replace");

    store.clearSecurityAlerts(repoId, "dependabot");

    expect(store.securityAlerts(repoId).map((a) => a.source)).toEqual(["code_scanning"]);
  });

  it("leaves out an alert whose stored record cannot be read, and logs it once, so the others still show", () => {
    const warnings: Record<string, unknown>[] = [];
    const log = {
      info: () => undefined,
      error: () => undefined,
      warn: (context: object) => void warnings.push(context as never),
    };
    const logged = new SqliteRepoStore(":memory:", () => new Date(), log);
    const id = logged.addRepo("acme", "widgets", [], "main").id;
    logged.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "41" }), dependabotAlert({ key: "42" })], "replace");
    rawDb(logged).exec("UPDATE security_alerts SET data = '{broken' WHERE key = '41'");

    expect(logged.securityAlerts(id).map((a) => a.key)).toEqual(["42"]);
    expect(logged.securityAlerts(id).map((a) => a.key)).toEqual(["42"]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ repoId: id, source: "dependabot" });
    expect(String((warnings[0]!.err as Error).message)).toContain("Stored dependabot alert 41 of repository");
  });

  it("stores no field called secret and no login, whatever an alert carries", () => {
    store.saveSecurityAlerts(repoId, "secret_scanning", [secretScanningAlert()], "replace");
    const row = rawDb(store).prepare("SELECT data FROM security_alerts").get() as unknown as { data: string };
    expect(row.data).not.toMatch(/"secret"|login/);
  });
});

describe("source states in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("answers not_read for every source that was never read", () => {
    const notRead = { status: "not_read" };
    expect(store.sourceStates(repoId)).toEqual({
      dependabot: notRead,
      code_scanning: notRead,
      secret_scanning: notRead,
      osv: notRead,
    });
  });

  it("round trips a state and replaces it on the next save, leaving the other sources alone", () => {
    store.setSourceState(repoId, "dependabot", okState({ truncated: true }));
    store.setSourceState(repoId, "code_scanning", {
      status: "off",
      reason: "needs_advanced_security",
      attemptedAt: "2026-09-29T10:00:00.000Z",
    });
    store.setSourceState(repoId, "dependabot", {
      status: "error",
      error: "GitHub could not be reached",
      attemptedAt: "2026-09-29T10:00:00.000Z",
      lastGood: { readAt: "2026-09-28T10:00:00.000Z", truncated: true, skipped: 2 },
    });

    const states = store.sourceStates(repoId);

    expect(states.dependabot).toEqual({
      status: "error",
      error: "GitHub could not be reached",
      attemptedAt: "2026-09-29T10:00:00.000Z",
      lastGood: { readAt: "2026-09-28T10:00:00.000Z", truncated: true, skipped: 2 },
    });
    expect(states.code_scanning).toEqual({
      status: "off",
      reason: "needs_advanced_security",
      attemptedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(states.secret_scanning.status).toBe("not_read");
  });

  it("round trips every status with only the fields that status has", () => {
    const at = "2026-09-29T10:00:00.000Z";
    const states: [Parameters<typeof store.setSourceState>[1], SourceState][] = [
      ["dependabot", okState({ truncated: true, skipped: 4 })],
      ["code_scanning", { status: "no_access", reason: "admin_only_or_off", attemptedAt: at }],
      ["secret_scanning", { status: "error", error: "down", attemptedAt: at, lastGood: null }],
      ["osv", { status: "not_used", reason: "dependabot_ok", attemptedAt: at }],
    ];
    for (const [source, state] of states) store.setSourceState(repoId, source, state);

    expect(store.sourceStates(repoId)).toEqual(Object.fromEntries(states));
  });

  it.each(NOT_USED_REASONS)("reads back an OSV source that was not used because of %s", (reason) => {
    const state: SourceState = { status: "not_used", reason, attemptedAt: "2026-09-29T10:00:00.000Z" };
    store.setSourceState(repoId, "osv", state);
    expect(store.sourceStates(repoId).osv).toEqual(state);
  });

  it("removes the row when a source is set back to not read", () => {
    store.setSourceState(repoId, "dependabot", okState());
    store.setSourceState(repoId, "dependabot", { status: "not_read" });
    expect(store.sourceStates(repoId).dependabot).toEqual({ status: "not_read" });
  });

  describe("a row written by the earlier build", () => {
    const warned: string[] = [];
    let logged: SqliteRepoStore;
    let id: number;

    beforeEach(() => {
      warned.length = 0;
      const log = {
        info: () => undefined,
        error: () => undefined,
        warn: (_: object, message: string) => void warned.push(message),
      };
      logged = new SqliteRepoStore(":memory:", () => new Date(), log);
      id = logged.addRepo("acme", "widgets", [], "main").id;
    });

    const insert = (source: string, fields: Record<string, string | number | null>) =>
      rawDb(logged)
        .prepare(
          `INSERT INTO security_sources (repo_id, source, status, reason, read_at, attempted_at, truncated, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          source,
          fields.status!,
          fields.reason ?? null,
          fields.read_at ?? null,
          fields.attempted_at ?? null,
          0,
          fields.error ?? null,
        );

    it("reads OSV's old off with a lookup reason as not read, and logs it once", () => {
      insert("osv", { status: "off", reason: "lookup_off", attempted_at: "2026-09-29T10:00:00.000Z" });

      expect(logged.sourceStates(id).osv).toEqual({ status: "not_read" });
      logged.sourceStates(id);
      expect(warned).toHaveLength(1);
    });

    it.each([
      ["a status that is not known", { status: "mystery", attempted_at: "t" }],
      ["an ok state with no read time", { status: "ok", attempted_at: "t" }],
      ["an ok state with no attempt time", { status: "ok", read_at: "t" }],
      ["an off state with a reason that belongs to another status", { status: "off", reason: "forbidden", attempted_at: "t" }],
      [
        "a not used state with a reason that belongs to another status",
        { status: "not_used", reason: "disabled", attempted_at: "t" },
      ],
      ["a no access state with no reason", { status: "no_access", attempted_at: "t" }],
      ["an error with no message", { status: "error", attempted_at: "t" }],
    ])("reads %s as not read", (_label, fields) => {
      insert("dependabot", fields);
      expect(logged.sourceStates(id).dependabot).toEqual({ status: "not_read" });
    });

    it("keeps an old ok row, whose skipped count is 0", () => {
      insert("dependabot", { status: "ok", read_at: "2026-09-28T10:00:00.000Z", attempted_at: "2026-09-29T10:00:00.000Z" });

      const states = logged.sourceStates(id);

      expect(states.dependabot).toEqual({
        status: "ok",
        readAt: "2026-09-28T10:00:00.000Z",
        attemptedAt: "2026-09-29T10:00:00.000Z",
        truncated: false,
        skipped: 0,
      });
    });

    it("rewrites such a row with the next save", () => {
      insert("osv", { status: "off", reason: "lookup_off", attempted_at: "t" });
      logged.setSourceState(id, "osv", { status: "not_used", reason: "lookup_off", attemptedAt: "t2" });
      expect(logged.sourceStates(id).osv).toEqual({ status: "not_used", reason: "lookup_off", attemptedAt: "t2" });
    });
  });

  it("keeps states apart per repository", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.setSourceState(repoId, "osv", okState());
    expect(store.sourceStates(other).osv.status).toBe("not_read");
  });

  it("ignores a row for a source this build does not know", () => {
    rawDb(store).prepare("INSERT INTO security_sources (repo_id, source, status) VALUES (?, 'future', 'ok')").run(repoId);
    expect(Object.keys(store.sourceStates(repoId))).toEqual(["dependabot", "code_scanning", "secret_scanning", "osv"]);
  });
});

describe("supply chain facts, posture and scorecard in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("answers null and no packages before anything was read", () => {
    expect(store.supplyChain(repoId)).toBeNull();
    expect(store.lockedPackages(repoId)).toEqual([]);
    expect(store.posture(repoId)).toBeNull();
    expect(store.scorecard(repoId)).toBeNull();
  });

  it("round trips the record and its packages, and replaces both together", () => {
    const record = supplyChainRecord({
      facts: supplyChainFacts({ workflowsRead: 2, ecosystems: ["npm"], updateConfig: ".github/dependabot.yml" }),
    });
    store.saveSupplyChain(repoId, record, [lockedPackage(), lockedPackage({ name: "left-pad", version: "1.3.0" })]);

    expect(store.supplyChain(repoId)).toEqual(record);
    expect(store.lockedPackages(repoId).map((p) => p.name)).toEqual(["lodash", "left-pad"]);

    store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "def5678" }), []);

    expect(store.supplyChain(repoId)!.commitSha).toBe("def5678");
    expect(store.lockedPackages(repoId)).toEqual([]);
  });

  it("never returns packages from supplyChain(), and never reads them", () => {
    store.saveSupplyChain(repoId, supplyChainRecord(), [lockedPackage()]);

    expect(Object.keys(store.supplyChain(repoId)!).sort()).toEqual(["commitSha", "facts", "readAt"]);
    expect(JSON.stringify(store.supplyChain(repoId))).not.toContain("lodash");
    // Packages that cannot be parsed do not matter to a caller that does not ask for them.
    rawDb(store).exec("UPDATE supply_chain SET packages = '{broken'");
    expect(store.supplyChain(repoId)).not.toBeNull();
    expect(() => store.lockedPackages(repoId)).toThrow("Stored locked packages of repository");
  });

  describe("a stored row that cannot be read", () => {
    const warnings: { context: Record<string, unknown>; message: string }[] = [];
    let logged: SqliteRepoStore;
    let id: number;

    beforeEach(() => {
      warnings.length = 0;
      const log = {
        info: () => undefined,
        error: () => undefined,
        warn: (context: object, message: string) => void warnings.push({ context: context as never, message }),
      };
      logged = new SqliteRepoStore(":memory:", () => new Date(), log);
      id = logged.addRepo("acme", "widgets", [], "main").id;
    });

    it("answers no supply chain record for facts that are not JSON, and logs it once, naming the repository", () => {
      logged.saveSupplyChain(id, supplyChainRecord(), []);
      rawDb(logged).exec("UPDATE supply_chain SET facts = 'nope'");

      expect(logged.supplyChain(id)).toBeNull();
      expect(logged.supplyChain(id)).toBeNull();

      expect(warnings).toHaveLength(1);
      expect(String((warnings[0]!.context.err as Error).message)).toContain("Stored supply chain facts of repository");
      expect(warnings[0]!.context.repoId).toBe(id);
    });

    it.each([
      ["valid JSON of another shape", "{}"],
      ["a list where an object is expected", "[]"],
      ["facts of another version", JSON.stringify({ ...supplyChainFacts(), version: 0 })],
      ["facts with a list missing", JSON.stringify({ ...supplyChainFacts(), lockfiles: undefined })],
      ["facts with a table that is a list", JSON.stringify({ ...supplyChainFacts(), manifestsByEcosystem: [] })],
      [
        "a key file without its blob key, as the interim build wrote it",
        JSON.stringify({ ...supplyChainFacts(), keyFiles: [{ path: ".env", strength: "strong" }] }),
      ],
      [
        "a Dockerfile without its blob key",
        JSON.stringify({
          ...supplyChainFacts(),
          dockerfiles: [
            {
              path: "Dockerfile",
              images: 1,
              unpinnedImages: 0,
              latestImages: 0,
              runsAsRoot: false,
              addsRemote: false,
              curlPipeShell: false,
            },
          ],
        }),
      ],
      [
        "a key file whose blob is a number",
        JSON.stringify({ ...supplyChainFacts(), keyFiles: [{ path: ".env", blob: 7, strength: "strong" }] }),
      ],
    ])("answers no supply chain record for %s, so the next crawl reads it again", (_label, facts) => {
      logged.saveSupplyChain(id, supplyChainRecord(), []);
      rawDb(logged).prepare("UPDATE supply_chain SET facts = ?").run(facts);
      expect(logged.supplyChain(id)).toBeNull();
    });

    it("answers no posture or scorecard for a row that is not readable, and keeps the other repository's", () => {
      const other = logged.addRepo("acme", "gadgets", [], "main").id;
      for (const repo of [id, other]) {
        logged.savePosture(repo, repoPosture(), "t");
        logged.saveScorecard(repo, "t", scorecardResult());
      }
      rawDb(logged).prepare("UPDATE security_posture SET data = 'x' WHERE repo_id = ?").run(id);
      rawDb(logged).prepare("UPDATE security_scorecard SET data = 'x' WHERE repo_id = ?").run(id);

      expect(logged.posture(id)).toBeNull();
      // No read time either, so the report makes no claim about the scan and the crawl reads the project again.
      expect(logged.scorecard(id)).toEqual({ readAt: null, result: null, failure: null });
      expect(logged.posture(other)).toEqual({ value: repoPosture(), readAt: "t" });
      expect(logged.scorecard(other)!.result).toEqual(scorecardResult());
      expect(warnings.map((w) => String((w.context.err as Error).message))).toEqual([
        `Stored posture of repository ${id} is not readable`,
        `Stored scorecard of repository ${id} is not readable`,
      ]);
    });

    it.each([
      ["a posture with no branch", JSON.stringify({ ...repoPosture(), branch: undefined })],
      ["a posture with no rules", JSON.stringify({ ...repoPosture(), branch: { name: "main", protected: true } })],
      ["a posture with no settings", JSON.stringify({ ...repoPosture(), settings: null })],
    ])("answers no posture for %s", (_label, data) => {
      logged.savePosture(id, repoPosture(), "t");
      rawDb(logged).prepare("UPDATE security_posture SET data = ?").run(data);
      expect(logged.posture(id)).toBeNull();
    });

    it.each([
      ["no checks", JSON.stringify({ score: 7, date: "2026-09-28" })],
      ["a score that is text", JSON.stringify({ score: "7", date: "2026-09-28", checks: [] })],
      ["no date", JSON.stringify({ score: 7, checks: [] })],
    ])("answers no scorecard result for %s", (_label, data) => {
      logged.saveScorecard(id, "t", scorecardResult());
      rawDb(logged).prepare("UPDATE security_scorecard SET data = ?").run(data);
      expect(logged.scorecard(id)).toEqual({ readAt: null, result: null, failure: null });
    });

    it("keeps the read time of a scorecard that was read and found the project absent, which has no data to be unreadable", () => {
      logged.saveScorecard(id, "t", null);
      expect(logged.scorecard(id)).toEqual({ readAt: "t", result: null, failure: null });
    });

    it("leaves out an alert of valid JSON in another shape, so the report is never given one", () => {
      logged.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], "replace");
      logged.saveSecurityAlerts(id, "code_scanning", [codeScanningAlert({ key: "3" })], "replace");
      logged.saveSecurityAlerts(id, "secret_scanning", [secretScanningAlert({ key: "4" })], "replace");
      rawDb(logged).exec("UPDATE security_alerts SET data = '{}' WHERE key = '1'");

      expect(logged.securityAlerts(id).map((a) => `${a.source}:${a.key}`)).toEqual([
        "code_scanning:3",
        "dependabot:2",
        "secret_scanning:4",
      ]);
      expect(warnings).toHaveLength(1);
    });

    it.each([
      ["another source from the row's", (a: Record<string, unknown>) => ({ ...a, source: "osv" })],
      ["a source that does not exist", (a: Record<string, unknown>) => ({ ...a, source: "gitlab" })],
      ["another key from the row's", (a: Record<string, unknown>) => ({ ...a, key: "99" })],
      ["a state that is not known", (a: Record<string, unknown>) => ({ ...a, state: "reopened" })],
      ["no creation time", (a: Record<string, unknown>) => ({ ...a, createdAt: null })],
      ["no dependency part", (a: Record<string, unknown>) => ({ ...a, dependency: undefined })],
      [
        "a close reason that is free text",
        (a: Record<string, unknown>) => ({ ...a, closeReason: "we will not fix this, ask Alice" }),
      ],
      ["a fixed state with no close time", (a: Record<string, unknown>) => ({ ...a, state: "fixed", closeReason: "fixed" })],
      ["an open state with a close time", (a: Record<string, unknown>) => ({ ...a, closedAt: "2026-09-05T00:00:00Z" })],
      ["an open state with a close reason", (a: Record<string, unknown>) => ({ ...a, closeReason: "fixed" })],
    ])("leaves out a Dependabot alert stored with %s", (_label, damage) => {
      logged.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "1" })], "replace");
      rawDb(logged)
        .prepare("UPDATE security_alerts SET data = ?")
        .run(JSON.stringify(damage(JSON.parse(JSON.stringify(dependabotAlert({ key: "1" }))))));
      expect(logged.securityAlerts(id)).toEqual([]);
    });

    it("counts the alerts it leaves out for each source, and none for a source that has none", () => {
      logged.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], "replace");
      logged.saveSecurityAlerts(id, "code_scanning", [codeScanningAlert({ key: "3" })], "replace");
      rawDb(logged).exec("UPDATE security_alerts SET data = '{broken' WHERE key = '1'");
      rawDb(logged).exec("UPDATE security_alerts SET data = '{}' WHERE key = '3'");

      const scan = logged.securityAlertScan(id);

      expect(scan.alerts.map((a) => a.key)).toEqual(["2"]);
      expect(scan.unreadable).toEqual({ dependabot: 1, code_scanning: 1, secret_scanning: 0, osv: 0 });
      const other = logged.addRepo("acme", "gadgets", [], "main").id;
      expect(logged.securityAlertScan(other).unreadable).toEqual({ dependabot: 0, code_scanning: 0, secret_scanning: 0, osv: 0 });
    });

    it.each(["toString", "constructor", "gitlab"])(
      "leaves out a row stored under %s, which is no alert source, without counting it against any source",
      (source) => {
        rawDb(logged)
          .prepare("INSERT INTO security_alerts (repo_id, source, key, state, data) VALUES (?, ?, 'x', 'open', '{broken')")
          .run(id, source);

        const scan = logged.securityAlertScan(id);

        expect(scan.alerts).toEqual([]);
        expect(scan.unreadable).toEqual({ dependabot: 0, code_scanning: 0, secret_scanning: 0, osv: 0 });
      },
    );

    it("leaves out a code scanning alert with no code part and a secret alert with no exposure part", () => {
      logged.saveSecurityAlerts(id, "code_scanning", [codeScanningAlert({ key: "3" })], "replace");
      logged.saveSecurityAlerts(id, "secret_scanning", [secretScanningAlert({ key: "4" })], "replace");
      rawDb(logged).exec(
        `UPDATE security_alerts SET data = json_remove(data, '$.code', '$.exposure') WHERE source IN ('code_scanning', 'secret_scanning')`,
      );
      expect(logged.securityAlerts(id)).toEqual([]);
    });

    it("ignores a source row with a status it does not know", () => {
      logged.setSourceState(id, "dependabot", okState());
      rawDb(logged).exec("UPDATE security_sources SET status = 'mystery'");
      expect(logged.sourceStates(id).dependabot.status).toBe("not_read");
    });

    it("throws for packages that cannot be read, which only the OSV lookup wants and the crawl records", () => {
      logged.saveSupplyChain(id, supplyChainRecord(), [lockedPackage()]);
      rawDb(logged).exec("UPDATE supply_chain SET packages = '{'");
      expect(() => logged.lockedPackages(id)).toThrow("Stored locked packages of repository");
    });
  });

  it("round trips posture with its read time", () => {
    const posture = repoPosture({ visibility: "public", advisories: { draft: 0, triage: 1, published: 2, closed: 3 } });
    store.savePosture(repoId, posture, "2026-09-29T10:00:00.000Z");
    store.savePosture(repoId, { ...posture, isAdmin: true }, "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toEqual({ value: { ...posture, isAdmin: true }, readAt: "2026-09-30T10:00:00.000Z" });
  });

  it("round trips a scorecard, and records that a project was asked about and not scanned", () => {
    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", scorecardResult());
    expect(store.scorecard(repoId)).toEqual({ readAt: "2026-09-29T10:00:00.000Z", result: scorecardResult(), failure: null });

    store.saveScorecard(repoId, "2026-09-30T10:00:00.000Z", null);
    expect(store.scorecard(repoId)).toEqual({ readAt: "2026-09-30T10:00:00.000Z", result: null, failure: null });
  });

  it("records a failed scorecard read beside the last good one, until the next good read clears it", () => {
    store.failScorecard(repoId, "Scorecard is not answering", "2026-09-30T08:00:00.000Z");
    expect(store.scorecard(repoId)).toEqual({
      readAt: null,
      result: null,
      failure: { message: "Scorecard is not answering", attemptedAt: "2026-09-30T08:00:00.000Z" },
    });

    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", scorecardResult());
    store.failScorecard(repoId, "Scorecard is not answering", "2026-09-30T08:00:00.000Z");
    expect(store.scorecard(repoId)).toEqual({
      readAt: "2026-09-29T10:00:00.000Z",
      result: scorecardResult(),
      failure: { message: "Scorecard is not answering", attemptedAt: "2026-09-30T08:00:00.000Z" },
    });

    store.saveScorecard(repoId, "2026-09-30T10:00:00.000Z", scorecardResult({ score: 8 }));
    expect(store.scorecard(repoId)).toMatchObject({ readAt: "2026-09-30T10:00:00.000Z", failure: null });
  });

  describe("a failed clone inspection", () => {
    const at = "2026-09-30T09:00:00.000Z";

    it("is recorded with its time beside the held record, which it leaves alone, and is none before one", () => {
      expect(store.supplyChainFailure(repoId)).toBeNull();
      store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "abc1234" }), [lockedPackage()]);

      store.failSupplyChain(repoId, "The clone could not be read", at);

      expect(store.supplyChainFailure(repoId)).toEqual({ message: "The clone could not be read", attemptedAt: at });
      expect(store.supplyChain(repoId)!.commitSha).toBe("abc1234");
      expect(store.lockedPackages(repoId)).toEqual([lockedPackage()]);
    });

    it("can be recorded when no record was ever held, and the latest failure replaces the earlier one", () => {
      store.failSupplyChain(repoId, "first", at);
      store.failSupplyChain(repoId, "second", "2026-09-30T10:00:00.000Z");

      expect(store.supplyChainFailure(repoId)).toEqual({ message: "second", attemptedAt: "2026-09-30T10:00:00.000Z" });
      expect(store.supplyChain(repoId)).toBeNull();
    });

    it("is cleared by the next good inspection, and changes the memo key when recorded and cleared", () => {
      const before = JSON.stringify(store.securityKeys(repoId));
      store.failSupplyChain(repoId, "down", at);
      expect(store.securityKeys(repoId).supplyChainFailure).toBe(at);
      expect(JSON.stringify(store.securityKeys(repoId))).not.toBe(before);

      store.saveSupplyChain(repoId, supplyChainRecord(), []);

      expect(store.supplyChainFailure(repoId)).toBeNull();
      expect(store.securityKeys(repoId).supplyChainFailure).toBeNull();
    });

    it("is removed with its repository", () => {
      store.failSupplyChain(repoId, "down", at);
      store.deleteRepo(repoId);
      expect(rawDb(store).prepare("SELECT count(*) AS n FROM supply_chain_failure").get()).toEqual({ n: 0 });
    });
  });

  // Every row of this version has these fields, so one without them is damaged, and a missing listing flag must never
  // be read as a complete listing that could close OSV alerts for lockfiles it never saw.
  it.each([
    ["no listing flag", { listingComplete: undefined }],
    ["a listing flag that is not a boolean", { listingComplete: "yes" }],
    ["no flag for the blob lookup", { blobsRead: undefined }],
    ["a blob lookup flag that is not a boolean", { blobsRead: "yes" }],
    ["no count of dropped findings", { findingsDropped: undefined }],
    ["a count of dropped actions that is not a number", { actionsDropped: "3" }],
  ])("answers no record for facts with %s", (_, change) => {
    store.saveSupplyChain(repoId, supplyChainRecord(), []);
    rawDb(store)
      .prepare("UPDATE supply_chain SET facts = ?")
      .run(JSON.stringify({ ...supplyChainFacts(), ...change }));
    expect(store.supplyChain(repoId)).toBeNull();
  });

  it("answers no record for facts that an earlier build wrote as version 1, so the next crawl reads them again", () => {
    store.saveSupplyChain(repoId, supplyChainRecord(), []);
    rawDb(store)
      .prepare("UPDATE supply_chain SET facts = ?")
      .run(
        JSON.stringify({
          ...supplyChainFacts(),
          version: 1,
          lockfiles: [{ path: "a", read: "parsed", packages: 1, publicPackages: 1 }],
        }),
      );

    expect(store.supplyChain(repoId)).toBeNull();
  });

  it("changes the scorecard memo key when a read fails", () => {
    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", null);
    const good = store.securityKeys(repoId).scorecard;
    store.failScorecard(repoId, "down", "2026-09-30T08:00:00.000Z");
    expect(store.securityKeys(repoId).scorecard).not.toBe(good);
  });

  it("keeps the last good posture beside a failed read, and a good read clears the failure", () => {
    store.savePosture(repoId, repoPosture({ visibility: "public" }), "2026-09-29T10:00:00.000Z");
    store.failPosture(repoId, "GitHub answered 500", "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toMatchObject({ readAt: "2026-09-29T10:00:00.000Z" });
    expect(store.postureFailure(repoId)).toEqual({ message: "GitHub answered 500", attemptedAt: "2026-09-30T10:00:00.000Z" });

    store.savePosture(repoId, repoPosture(), "2026-10-01T10:00:00.000Z");
    expect(store.postureFailure(repoId)).toBeNull();
  });

  it("accepts a first failed posture read, which has no posture and no read time", () => {
    store.failPosture(repoId, "down", "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toBeNull();
    expect(store.postureFailure(repoId)).toEqual({ message: "down", attemptedAt: "2026-09-30T10:00:00.000Z" });
    expect(store.securityKeys(repoId).posture).toBe("!2026-09-30T10:00:00.000Z");
  });

  it("changes the posture memo key when a read fails", () => {
    store.savePosture(repoId, repoPosture(), "2026-09-29T10:00:00.000Z");
    const good = store.securityKeys(repoId).posture;
    store.failPosture(repoId, "down", "2026-09-30T10:00:00.000Z");
    expect(store.securityKeys(repoId).posture).not.toBe(good);
  });

  it("gives memo keys that change when any of the parts is written", () => {
    const keys = () => JSON.stringify(store.securityKeys(repoId));
    const empty = keys();
    expect(store.securityKeys(repoId)).toEqual({
      sources: "",
      supplyChain: null,
      posture: null,
      scorecard: null,
      supplyChainFailure: null,
      acceptances: "0:0",
    });

    store.setSourceState(repoId, "dependabot", okState());
    const afterSource = keys();
    store.saveSupplyChain(repoId, supplyChainRecord(), []);
    const afterSupply = keys();
    store.savePosture(repoId, repoPosture(), "2026-09-29T11:00:00.000Z");
    const afterPosture = keys();
    store.saveScorecard(repoId, "2026-09-29T12:00:00.000Z", null);
    const afterScorecard = keys();

    expect(new Set([empty, afterSource, afterSupply, afterPosture, afterScorecard]).size).toBe(5);
    expect(store.securityKeys(repoId)).toEqual({
      sources: "dependabot:2026-09-29T10:00:00.000Z:2026-09-29T10:00:00.000Z",
      supplyChain: "2026-09-29T10:00:00.000Z",
      posture: "2026-09-29T11:00:00.000Z",
      scorecard: "2026-09-29T12:00:00.000Z",
      supplyChainFailure: null,
      acceptances: "0:0",
    });
    store.setSourceState(repoId, "dependabot", okState({ attemptedAt: "2026-09-30T10:00:00.000Z" }));
    expect(keys()).not.toBe(afterScorecard);
  });
});

describe("deleting a repository removes its security data", () => {
  it("cascades to every security table and leaves another repository's data", () => {
    const store = new SqliteRepoStore(":memory:");
    const gone = store.addRepo("acme", "widgets", [], "main").id;
    const kept = store.addRepo("acme", "gadgets", [], "main").id;
    for (const id of [gone, kept]) {
      store.saveSecurityAlerts(id, "dependabot", [dependabotAlert()], "replace");
      store.setSourceState(id, "dependabot", okState());
      store.saveSupplyChain(id, supplyChainRecord(), [lockedPackage()]);
      store.savePosture(id, repoPosture(), "t");
      store.saveScorecard(id, "t", scorecardResult());
      store.saveAcceptance(id, acceptanceOf());
    }

    store.deleteRepo(gone);

    for (const table of [
      "security_alerts",
      "security_sources",
      "supply_chain",
      "security_posture",
      "security_scorecard",
      "security_acceptances",
    ]) {
      const rows = rawDb(store).prepare(`SELECT repo_id FROM ${table}`).all() as unknown as { repo_id: number }[];
      expect(
        rows.map((r) => r.repo_id),
        table,
      ).toEqual([kept]);
    }
  });
});

describe("opening a database made before security was read", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-security-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the security tables, keeps the repository, and lets security data be stored and survive a reopen", () => {
    const path = join(dir, "old.db");
    const first = new SqliteRepoStore(path);
    const id = first.addRepo("acme", "widgets", [], "main").id;
    // What a database written before this feature looks like: every table of the feature missing.
    const db = rawDb(first);
    for (const table of ["security_alerts", "security_sources", "supply_chain", "security_posture", "security_scorecard"]) {
      db.exec(`DROP TABLE ${table}`);
    }
    db.close();

    const store = new SqliteRepoStore(path);
    const tables = (
      rawDb(store).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["security_alerts", "security_sources", "supply_chain", "security_posture", "security_scorecard"]),
    );
    expect(store.findRepo("acme", "widgets")!.id).toBe(id);
    expect(store.sourceStates(id).dependabot.status).toBe("not_read");

    store.saveSecurityAlerts(id, "dependabot", [dependabotAlert()], "replace");
    rawDb(store).close();
    expect(new SqliteRepoStore(path).securityAlerts(id)).toHaveLength(1);
  });
});

describe("migrating a database made by an earlier build of the security feature", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The security tables exactly as phase one made them: the scorecard table had a NOT NULL read time and no error column. */
  function earlierDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL,
      deploy_workflows TEXT NOT NULL DEFAULT '[]', deploy_branch TEXT NOT NULL DEFAULT 'main', added_at TEXT NOT NULL,
      last_crawled_at TEXT, crawl_status TEXT NOT NULL DEFAULT 'idle', crawl_error TEXT, crawl_progress TEXT,
      crawl_cursor TEXT, UNIQUE (owner, name)
    );
    CREATE TABLE security_alerts (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, source TEXT NOT NULL, key TEXT NOT NULL,
      state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo_id, source, key)
    );
    CREATE TABLE security_sources (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, source TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, read_at TEXT, attempted_at TEXT, truncated INTEGER NOT NULL DEFAULT 0, error TEXT,
      PRIMARY KEY (repo_id, source)
    );
    CREATE TABLE supply_chain (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, commit_sha TEXT NOT NULL,
      read_at TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, packages TEXT NOT NULL
    );
    CREATE TABLE security_posture (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE security_scorecard (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT NOT NULL, data TEXT
    );`);
    db.prepare("INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', '2026-09-01T00:00:00Z')").run();
    db.prepare("INSERT INTO security_scorecard (repo_id, read_at, data) VALUES (1, '2026-09-28T00:00:00.000Z', ?)").run(
      JSON.stringify(scorecardResult()),
    );
    db.prepare("INSERT INTO security_posture (repo_id, read_at, data) VALUES (1, '2026-09-27T00:00:00.000Z', ?)").run(
      JSON.stringify(repoPosture({ visibility: "public" })),
    );
    db.close();
  }

  const scorecardColumns = (path: string) => {
    const db = new DatabaseSync(path);
    const columns = db.prepare("PRAGMA table_info(security_scorecard)").all() as unknown as { name: string; notnull: number }[];
    db.close();
    return columns.map((c) => `${c.name}:${c.notnull}`);
  };

  it("adds the error column, loosens the read time, keeps the stored scorecard and works end to end", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);

    const store = new SqliteRepoStore(path);
    expect(store.securityKeys(1).scorecard).toBe("2026-09-28T00:00:00.000Z");
    expect(store.scorecard(1)).toEqual({ readAt: "2026-09-28T00:00:00.000Z", result: scorecardResult(), failure: null });
    store.failScorecard(1, "down", "2026-09-30T00:00:00.000Z");
    expect(store.scorecard(1)).toMatchObject({ failure: { message: "down" }, result: scorecardResult() });
    store.saveScorecard(1, "2026-09-29T00:00:00.000Z", null);
    expect(store.scorecard(1)).toEqual({ readAt: "2026-09-29T00:00:00.000Z", result: null, failure: null });

    expect(scorecardColumns(path)).toEqual(["repo_id:0", "read_at:0", "data:0", "error:0", "attempted_at:0"]);
  });

  it("adds the posture failure columns, keeps the stored posture and accepts a failure", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);

    const store = new SqliteRepoStore(path);
    expect(store.posture(1)).toEqual({ value: repoPosture({ visibility: "public" }), readAt: "2026-09-27T00:00:00.000Z" });
    expect(store.postureFailure(1)).toBeNull();
    store.failPosture(1, "down", "2026-09-30T00:00:00.000Z");
    expect(store.postureFailure(1)).toEqual({ message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" });
    expect(store.posture(1)!.readAt).toBe("2026-09-27T00:00:00.000Z");

    const db = new DatabaseSync(path);
    const columns = db.prepare("PRAGMA table_info(security_posture)").all() as unknown as { name: string; notnull: number }[];
    db.close();
    expect(columns.map((c) => `${c.name}:${c.notnull}`)).toEqual([
      "repo_id:0",
      "read_at:0",
      "data:0",
      "error:0",
      "attempted_at:0",
    ]);
    // A second open finds the new shape and keeps what was stored.
    expect(new SqliteRepoStore(path).postureFailure(1)).toMatchObject({ message: "down" });
  });

  it("rebuilds only the old table when the other is current, and keeps the failure a current table holds", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    // The scorecard table is already in its current shape and holds a failed first read; only the posture table is old.
    raw.exec(`DROP TABLE security_scorecard;
      CREATE TABLE security_scorecard (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT, data TEXT, error TEXT,
        attempted_at TEXT
      );
      INSERT INTO security_scorecard (repo_id, read_at, data, error, attempted_at)
        VALUES (1, NULL, NULL, 'down', '2026-09-30T00:00:00.000Z')`);
    raw.close();

    const store = new SqliteRepoStore(path);

    expect(store.scorecard(1)).toEqual({
      readAt: null,
      result: null,
      failure: { message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" },
    });
    expect(store.posture(1)).toEqual({ value: repoPosture({ visibility: "public" }), readAt: "2026-09-27T00:00:00.000Z" });
    store.failPosture(1, "also down", "2026-09-30T00:00:00.000Z");
    expect(store.postureFailure(1)).toMatchObject({ message: "also down" });
  });

  it("keeps the failure a posture table held while it is rebuilt for a read time that must be nullable", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE security_posture;
      CREATE TABLE security_posture (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT NOT NULL, data TEXT NOT NULL,
        error TEXT, attempted_at TEXT
      );`);
    raw
      .prepare(
        "INSERT INTO security_posture (repo_id, read_at, data, error, attempted_at) VALUES (1, '2026-09-27T00:00:00.000Z', ?, 'down', '2026-09-30T00:00:00.000Z')",
      )
      .run(JSON.stringify(repoPosture({ visibility: "public" })));
    raw.close();

    const store = new SqliteRepoStore(path);

    expect(store.postureFailure(1)).toEqual({ message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" });
    expect(store.posture(1)!.readAt).toBe("2026-09-27T00:00:00.000Z");
  });

  it("leaves both tables as they were, and raises, when a rebuild fails part way", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    // An old posture table that lacks the `data` column the copy reads, so the second rebuild fails after the first.
    raw.exec(`DROP TABLE security_posture;
      CREATE TABLE security_posture (repo_id INTEGER PRIMARY KEY, read_at TEXT NOT NULL);
      INSERT INTO security_posture (repo_id, read_at) VALUES (1, '2026-09-27T00:00:00.000Z')`);
    raw.close();

    expect(() => new SqliteRepoStore(path)).toThrow(/data/);

    const db = new DatabaseSync(path);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; notnull: number }[]).map(
        (c) => `${c.name}:${c.notnull}`,
      );
    // The scorecard rebuild that came first was undone with it.
    expect(columns("security_scorecard")).toEqual(["repo_id:0", "read_at:1", "data:0"]);
    expect(columns("security_posture")).toEqual(["repo_id:0", "read_at:1"]);
    expect(columns("security_scorecard_earlier")).toEqual([]);
    expect(db.prepare("SELECT read_at FROM security_scorecard").get()).toEqual({ read_at: "2026-09-28T00:00:00.000Z" });
    db.close();
  });

  it("drops a scorecard failure the earlier build stored without an attempt time, and keeps the result", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE security_scorecard;
      CREATE TABLE security_scorecard (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT, data TEXT, error TEXT
      )`);
    raw
      .prepare("INSERT INTO security_scorecard (repo_id, read_at, data, error) VALUES (1, '2026-09-28T00:00:00.000Z', ?, 'down')")
      .run(JSON.stringify(scorecardResult()));
    raw.close();

    const store = new SqliteRepoStore(path);

    expect(store.scorecard(1)).toEqual({ readAt: "2026-09-28T00:00:00.000Z", result: scorecardResult(), failure: null });
    store.failScorecard(1, "down again", "2026-09-30T00:00:00.000Z");
    expect(store.scorecard(1)!.failure).toEqual({ message: "down again", attemptedAt: "2026-09-30T00:00:00.000Z" });
  });

  it("gives an error row of the earlier build no last good read, since it may carry the read time of a source never graded", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO security_sources (repo_id, source, status, read_at, attempted_at, error)
      VALUES (1, 'dependabot', 'error', '2026-06-01T00:00:00.000Z', '2026-09-28T00:00:00.000Z', 'down')`);
    raw.close();

    const store = new SqliteRepoStore(path);

    // The read time left over from an earlier no_access state is gone, so these alerts are not graded again.
    expect(store.sourceStates(1).dependabot).toEqual({
      status: "error",
      error: "down",
      attemptedAt: "2026-09-28T00:00:00.000Z",
      lastGood: null,
    });
    // A failure written by this build keeps its last good read, and a second open does not strip it.
    store.setSourceState(1, "dependabot", {
      status: "error",
      error: "down",
      attemptedAt: "2026-09-29T00:00:00.000Z",
      lastGood: { readAt: "2026-09-27T00:00:00.000Z", truncated: false, skipped: 0 },
    });
    expect((new SqliteRepoStore(path).sourceStates(1).dependabot as { lastGood: unknown }).lastGood).toEqual({
      readAt: "2026-09-27T00:00:00.000Z",
      truncated: false,
      skipped: 0,
    });
  });

  it("rebuilds a posture table that has the error column but not the attempt time, keeping what it held", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE security_posture;
      CREATE TABLE security_posture (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT, data TEXT, error TEXT
      )`);
    raw
      .prepare("INSERT INTO security_posture (repo_id, read_at, data) VALUES (1, '2026-09-27T00:00:00.000Z', ?)")
      .run(JSON.stringify(repoPosture({ visibility: "public" })));
    raw.close();

    const store = new SqliteRepoStore(path);
    store.failPosture(1, "down", "2026-09-30T00:00:00.000Z");

    expect(store.postureFailure(1)).toEqual({ message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" });
    expect(store.posture(1)!.readAt).toBe("2026-09-27T00:00:00.000Z");
  });

  it("adds the skipped column to a source table without it, keeping the rows, and does it once", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "INSERT INTO security_sources (repo_id, source, status, read_at, attempted_at, truncated) VALUES (1, 'dependabot', 'ok', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z', 1)",
      )
      .run();
    raw.close();

    const store = new SqliteRepoStore(path);
    new SqliteRepoStore(path);

    expect(store.sourceStates(1).dependabot).toEqual({
      status: "ok",
      readAt: "2026-09-28T00:00:00.000Z",
      attemptedAt: "2026-09-28T00:00:00.000Z",
      truncated: true,
      skipped: 0,
    });
  });

  it("accepts a first failed read, which has no read time", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM security_scorecard");
    raw.close();

    const store = new SqliteRepoStore(path);
    store.failScorecard(1, "down", "2026-09-30T00:00:00.000Z");

    expect(store.scorecard(1)).toEqual({
      readAt: null,
      result: null,
      failure: { message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" },
    });
  });

  it("changes nothing on a second open", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    const first = new SqliteRepoStore(path);
    first.failScorecard(1, "down", "2026-09-30T00:00:00.000Z");
    const columns = scorecardColumns(path);

    const second = new SqliteRepoStore(path);

    expect(scorecardColumns(path)).toEqual(columns);
    expect(second.scorecard(1)).toEqual({
      readAt: "2026-09-28T00:00:00.000Z",
      result: scorecardResult(),
      failure: { message: "down", attemptedAt: "2026-09-30T00:00:00.000Z" },
    });
  });

  it("leaves the other security tables as the earlier build made them", () => {
    const path = join(dir, "dora.db");
    earlierDatabase(path);
    new SqliteRepoStore(path);
    const db = new DatabaseSync(path);
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);

    expect(names("security_sources")).toEqual([
      "repo_id",
      "source",
      "status",
      "reason",
      "read_at",
      "attempted_at",
      "truncated",
      "error",
      "skipped",
    ]);
    expect(names("supply_chain")).toEqual(["repo_id", "commit_sha", "read_at", "version", "facts", "packages"]);
    expect(names("security_alerts")).toEqual(["repo_id", "source", "key", "state", "data"]);
    db.close();
  });
});

describe("accepted findings in the store", () => {
  const warnings: { context: Record<string, unknown>; message: string }[] = [];
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    warnings.length = 0;
    const log = {
      info: () => undefined,
      error: () => undefined,
      warn: (context: object, message: string) => void warnings.push({ context: context as never, message }),
    };
    store = new SqliteRepoStore(":memory:", () => new Date(), log);
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("saves an acceptance with a new id and reads it back as it was given, oldest first", () => {
    const first = store.saveAcceptance(repoId, acceptanceOf({ note: "First." }));
    const second = store.saveAcceptance(
      repoId,
      acceptanceOf({ check: "lockfiles", path: "web/package.json", fingerprint: "p1:", note: "Second.", line: null }),
    );

    expect(first).toEqual({ ...acceptanceOf({ note: "First." }), id: 1 });
    expect(second!.id).toBe(2);
    expect(store.acceptances(repoId)).toEqual([first, second]);
  });

  it("keeps the line it was given, and reads an absence's empty path back as null", () => {
    store.saveAcceptance(
      repoId,
      acceptanceOf({ check: "prHeadCheckout", path: "a.yml", line: 31, fingerprint: `w1:${"a".repeat(16)}` }),
    );
    store.saveAcceptance(repoId, acceptanceOf());

    const [withLine, absence] = store.acceptances(repoId);
    expect(withLine).toMatchObject({ path: "a.yml", line: 31 });
    expect(absence).toMatchObject({ path: null, line: null });
    // Stored as '' so that UNIQUE sees the absence, which a NULL would let through twice.
    expect(rawDb(store).prepare("SELECT path FROM security_acceptances WHERE id = 2").get()).toEqual({ path: "" });
  });

  it("answers null for the same finding twice, and keeps the first", () => {
    const first = store.saveAcceptance(repoId, acceptanceOf({ note: "First." }));
    expect(store.saveAcceptance(repoId, acceptanceOf({ note: "Again.", reason: "false_positive" }))).toBeNull();
    expect(store.acceptances(repoId)).toEqual([first]);
  });

  it("treats another check, path or fingerprint, or another repository, as another finding", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const base = { check: "keyFiles" as const, path: ".env", fingerprint: `b:${"a".repeat(40)}` };
    expect(store.saveAcceptance(repoId, acceptanceOf(base))).not.toBeNull();
    expect(store.saveAcceptance(repoId, acceptanceOf({ ...base, check: "weakKeyFiles" }))).not.toBeNull();
    expect(store.saveAcceptance(repoId, acceptanceOf({ ...base, path: ".env.production" }))).not.toBeNull();
    expect(store.saveAcceptance(repoId, acceptanceOf({ ...base, fingerprint: `b:${"b".repeat(40)}` }))).not.toBeNull();
    expect(store.saveAcceptance(other, acceptanceOf(base))).not.toBeNull();
    expect(store.acceptances(repoId)).toHaveLength(4);
    expect(store.acceptances(other)).toHaveLength(1);
  });

  it("deletes only the repository's own acceptance, and says whether it was there", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    const mine = store.saveAcceptance(repoId, acceptanceOf())!;
    const theirs = store.saveAcceptance(other, acceptanceOf())!;

    expect(store.deleteAcceptance(repoId, theirs.id)).toBe(false);
    expect(store.deleteAcceptance(repoId, mine.id)).toBe(true);
    expect(store.deleteAcceptance(repoId, mine.id)).toBe(false);
    expect(store.acceptances(repoId)).toEqual([]);
    expect(store.acceptances(other)).toEqual([theirs]);
  });

  it("never reuses an id, so the key changes after an undo followed by another accept", () => {
    const first = store.saveAcceptance(repoId, acceptanceOf())!;
    const afterFirst = store.securityKeys(repoId).acceptances;
    store.deleteAcceptance(repoId, first.id);
    const afterUndo = store.securityKeys(repoId).acceptances;
    const again = store.saveAcceptance(repoId, acceptanceOf())!;
    const afterAgain = store.securityKeys(repoId).acceptances;

    expect(again.id).toBe(2);
    // The count and the newest id together say the same set only once: ids only ever grow and rows are only removed.
    expect([afterFirst, afterUndo, afterAgain]).toEqual(["1:1", "0:0", "1:2"]);
  });

  it("leaves out a row that is not what the service saves, logs it once and keeps the others", () => {
    store.saveAcceptance(repoId, acceptanceOf({ note: "Good." }));
    const insert = rawDb(store).prepare(
      "INSERT INTO security_acceptances (repo_id, check_id, path, line, fingerprint, reason, note, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const bad: unknown[][] = [
      [repoId, "notACheck", "", null, "n1:", "risk_accepted", "x", "t"],
      [repoId, "lockfiles", "p.json", null, "n1:", "not_a_reason", "x", "t"],
      [repoId, "lockfiles", "p.json", null, "w9:abc", "risk_accepted", "x", "t"],
      [repoId, "lockfiles", "q.json", null, "p1:", "risk_accepted", "   ", "t"],
      [repoId, "lockfiles", "r.json", null, "p1:", "risk_accepted", "x".repeat(281), "t"],
      [repoId, "lockfiles", "s.json", 1.5, "p1:", "risk_accepted", "x", "t"],
      [repoId, "lockfiles", "t.json", null, "p1:", "risk_accepted", "one\ntwo", "t"],
    ];
    for (const row of bad) insert.run(...(row as never[]));

    expect(store.acceptances(repoId).map((a) => a.note)).toEqual(["Good."]);
    store.acceptances(repoId);
    expect(warnings).toHaveLength(bad.length);
    expect(warnings[0]!.context).toEqual({ repoId, acceptanceId: 2 });
  });

  it("counts the rows it left out beside the readable ones", () => {
    store.saveAcceptance(repoId, acceptanceOf({ note: "Good." }));
    expect(store.acceptanceScan(repoId)).toEqual({ acceptances: store.acceptances(repoId), unreadable: 0 });
    const insert = rawDb(store).prepare(
      "INSERT INTO security_acceptances (repo_id, check_id, path, line, fingerprint, reason, note, accepted_at) VALUES (?, 'lockfiles', ?, NULL, 'p1:', 'not_a_reason', 'x', 't')",
    );
    insert.run(repoId, "a.json");
    insert.run(repoId, "b.json");

    const scan = store.acceptanceScan(repoId);

    expect(scan.unreadable).toBe(2);
    expect(scan.acceptances.map((a) => a.note)).toEqual(["Good."]);
  });

  it("lets a constraint failure other than the unique key surface, instead of reading it as a duplicate", () => {
    expect(() => store.saveAcceptance(repoId, acceptanceOf({ note: null as unknown as string }))).toThrow(/NOT NULL/);
    expect(store.acceptances(repoId)).toEqual([]);
  });

  it("replaces a stored row that is not readable when the same finding is accepted again", () => {
    rawDb(store)
      .prepare(
        "INSERT INTO security_acceptances (repo_id, check_id, path, line, fingerprint, reason, note, accepted_at) VALUES (?, 'lockfiles', 'p.json', NULL, 'p1:', 'not_a_reason', 'x', 't')",
      )
      .run(repoId);
    expect(store.acceptances(repoId)).toEqual([]);
    const before = store.securityKeys(repoId).acceptances;

    const saved = store.saveAcceptance(
      repoId,
      acceptanceOf({ check: "lockfiles", path: "p.json", fingerprint: "p1:", line: null, note: "Mended." }),
    );

    expect(saved).toMatchObject({ note: "Mended." });
    // A new id, never the unreadable row's.
    expect(saved!.id).toBeGreaterThan(1);
    expect(store.acceptances(repoId)).toEqual([saved]);
    expect(rawDb(store).prepare("SELECT count(*) AS n FROM security_acceptances").get()).toEqual({ n: 1 });
    expect(store.securityKeys(repoId).acceptances).not.toBe(before);
  });

  it("keeps a readable row and answers null when the same finding is accepted again", () => {
    const first = store.saveAcceptance(repoId, acceptanceOf({ note: "First." }))!;
    expect(store.saveAcceptance(repoId, acceptanceOf({ note: "Second." }))).toBeNull();
    expect(store.acceptances(repoId)).toEqual([first]);
    expect(rawDb(store).prepare("SELECT count(*) AS n FROM security_acceptances").get()).toEqual({ n: 1 });
  });

  it("counts a note by characters, so 280 emoji are allowed and 281 are not", () => {
    const insert = rawDb(store).prepare(
      "INSERT INTO security_acceptances (repo_id, check_id, path, line, fingerprint, reason, note, accepted_at) VALUES (?, 'lockfiles', ?, NULL, 'p1:', 'risk_accepted', ?, 't')",
    );
    insert.run(repoId, "a.json", "\u{1F600}".repeat(280));
    insert.run(repoId, "b.json", "\u{1F600}".repeat(281));
    expect(store.acceptances(repoId).map((a) => a.path)).toEqual(["a.json"]);
  });

  it("has no column that could hold a person", () => {
    const columns = (rawDb(store).prepare("PRAGMA table_info(security_acceptances)").all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(["id", "repo_id", "check_id", "path", "line", "fingerprint", "reason", "note", "accepted_at"]);
  });
});

/** An acceptance without its id, the absence of a dependency review unless changed. */
function acceptanceOf(overrides: Parameters<typeof acceptance>[0] = {}) {
  const { id: _id, ...rest } = acceptance(overrides);
  return rest;
}
