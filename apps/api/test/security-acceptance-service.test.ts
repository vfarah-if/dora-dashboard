import {
  ACCEPTANCE_LIMITS,
  fingerprintOfFinding,
  fingerprintOfUse,
  type AcceptanceRequest,
  type WorkflowFinding,
} from "@dora-dashboard/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { SecurityAcceptanceService } from "../src/services/security-acceptance-service.js";
import { rawDb, repoPosture, supplyChainFacts, supplyChainRecord } from "./fakes.js";

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

const onCheckout = (overrides: Partial<AcceptanceRequest> = {}): AcceptanceRequest => ({
  check: "prHeadCheckout",
  path: checkout.file,
  fingerprint: fingerprintOfFinding(checkout),
  reason: "guarded_elsewhere",
  note: "Only push runs reach this job.",
  ...overrides,
});

/** The error `run` throws, so a test can read its code as well as its type. */
function conflictOf(run: () => unknown): ConflictError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConflictError) return error;
    throw error;
  }
  throw new Error("Expected a ConflictError");
}

describe("accepting a finding", () => {
  let store: SqliteRepoStore;
  let repoId: number;
  let service: SecurityAcceptanceService;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
    store.saveSupplyChain(
      repoId,
      supplyChainRecord({
        facts: supplyChainFacts({
          findings: [checkout],
          actions: [unpinned],
          keyFiles: [
            { path: ".env.production", blob: BLOB, strength: "strong" },
            { path: ".env.staging", blob: null, strength: "strong" },
          ],
        }),
      }),
      [],
    );
    service = new SecurityAcceptanceService(store, store, () => NOW);
  });

  it("saves the acceptance with the line of the finding and the time of the clock, and returns it", () => {
    const saved = service.accept(repoId, onCheckout());

    expect(saved).toEqual({
      id: 1,
      check: "prHeadCheckout",
      path: ".github/workflows/db.yml",
      line: 31,
      fingerprint: fingerprintOfFinding(checkout),
      reason: "guarded_elsewhere",
      note: "Only push runs reach this job.",
      acceptedAt: "2026-10-19T09:30:00.000Z",
    });
    expect(store.acceptances(repoId)).toEqual([saved]);
  });

  it("takes the line from the finding even when the request carries another, and never stores a login", () => {
    const sneaky = {
      ...onCheckout(),
      line: 999,
      login: "alice",
      acceptedAt: "2001-01-01T00:00:00Z",
      id: 77,
    } as AcceptanceRequest;

    const saved = service.accept(repoId, sneaky);

    expect(saved.line).toBe(31);
    expect(saved.acceptedAt).toBe("2026-10-19T09:30:00.000Z");
    expect(saved.id).toBe(1);
    expect("login" in saved).toBe(false);
    expect(Object.keys(saved).sort()).toEqual(["acceptedAt", "check", "fingerprint", "id", "line", "note", "path", "reason"]);
    expect(JSON.stringify(store.acceptances(repoId))).not.toContain("alice");
  });

  it("trims the note", () => {
    expect(service.accept(repoId, onCheckout({ note: "  spaced out \t" })).note).toBe("spaced out");
  });

  it("accepts an action use, a key file whose blob was read and the absence of a tool, with the right lines", () => {
    expect(
      service.accept(repoId, {
        check: "unpinnedActions",
        path: unpinned.file,
        fingerprint: fingerprintOfUse(unpinned),
        reason: "risk_accepted",
        note: "Vendor action.",
      }).line,
    ).toBe(12);
    expect(
      service.accept(repoId, {
        check: "keyFiles",
        path: ".env.production",
        fingerprint: `b:${BLOB}`,
        reason: "public_by_design",
        note: "Vite mode file.",
      }).line,
    ).toBeNull();
    expect(
      service.accept(repoId, {
        check: "dependencyReview",
        path: null,
        fingerprint: "n1:",
        reason: "risk_accepted",
        note: "Not needed here.",
      }),
    ).toMatchObject({ path: null, line: null });
    expect(store.acceptances(repoId)).toHaveLength(3);
  });

  describe("what it refuses", () => {
    it("answers not found for a repository that does not exist", () => {
      expect(() => service.accept(999, onCheckout())).toThrow(NotFoundError);
    });

    it("answers a conflict when the files have not been read", () => {
      const fresh = store.addRepo("acme", "gadgets", [], "main").id;
      const error = conflictOf(() => service.accept(fresh, onCheckout()));
      expect(error.message).toMatch(/not been read/);
      expect(error.code).toBe("acceptance_no_record");
    });

    it("answers a conflict for a record the store cannot read, which counts as none", () => {
      rawDb(store).exec("UPDATE supply_chain SET facts = 'nope'");
      expect(conflictOf(() => service.accept(repoId, onCheckout())).code).toBe("acceptance_no_record");
    });

    /** Each case arranges what it needs and says what to ask for, so no case branches on its own label. */
    const keepsToolPresent = (): Partial<AcceptanceRequest> => {
      const record = store.supplyChain(repoId)!;
      store.saveSupplyChain(
        repoId,
        {
          ...record,
          facts: {
            ...record.facts,
            securityTools: [{ tool: "actions/dependency-review-action", category: "dependency_review", file: "ci.yml" }],
          },
        },
        [],
      );
      return { check: "dependencyReview", path: null, fingerprint: "n1:" };
    };
    it.each<[string, () => Partial<AcceptanceRequest>]>([
      ["a finding that is not in the latest read", () => ({ path: "gone.yml" })],
      ["a fingerprint that no longer matches, because the line changed", () => ({ fingerprint: `w1:${"0".repeat(16)}` })],
      ["another check than the finding is under", () => ({ check: "scriptInjection" })],
      ["a key file whose blob id was not read", () => ({ check: "keyFiles", path: ".env.staging", fingerprint: `b:${BLOB}` })],
      ["an absence that is not one, as the tool is present", keepsToolPresent],
    ])("answers a conflict, asking for a reload, for %s", (_why, arrange) => {
      const change = arrange();
      const error = conflictOf(() => service.accept(repoId, onCheckout(change)));
      expect(error.message).toMatch(/Reload/);
      expect(error.code).toBe("acceptance_finding_changed");
      expect(store.acceptances(repoId)).toEqual([]);
    });

    it("answers a conflict for a finding that is already accepted, and keeps the first note", () => {
      service.accept(repoId, onCheckout({ note: "First." }));
      const error = conflictOf(() => service.accept(repoId, onCheckout({ note: "Second.", reason: "false_positive" })));
      expect(error.message).toMatch(/already accepted/);
      expect(error.code).toBe("acceptance_duplicate");
      expect(store.acceptances(repoId).map((a) => a.note)).toEqual(["First."]);
    });

    it("answers a conflict once the repository holds 500 acceptances, and not before", () => {
      const insert = (n: number) =>
        store.saveAcceptance(repoId, {
          check: "lockfiles",
          path: `p${n}/package.json`,
          line: null,
          fingerprint: "p1:",
          reason: "risk_accepted",
          note: "x",
          acceptedAt: "2026-10-01T00:00:00.000Z",
        });
      for (let n = 0; n < ACCEPTANCE_LIMITS.perRepository - 1; n++) insert(n);
      expect(service.accept(repoId, onCheckout()).id).toBe(ACCEPTANCE_LIMITS.perRepository);
      const error = conflictOf(() =>
        service.accept(
          repoId,
          onCheckout({ check: "unpinnedActions", path: unpinned.file, fingerprint: fingerprintOfUse(unpinned) }),
        ),
      );
      expect(error.message).toMatch(/at most 500/);
      expect(error.code).toBe("acceptance_limit");
    });

    it.each([
      ["nothing", ""],
      ["only spaces", "   \t "],
    ])("answers a validation error for a note of %s", (_what, note) => {
      expect(() => service.accept(repoId, onCheckout({ note }))).toThrow(ValidationError);
    });

    it("answers a validation error for a note of more than 280 characters, counting each emoji as one", () => {
      expect(service.accept(repoId, onCheckout({ note: "\u{1F600}".repeat(280) })).note).toHaveLength(560);
      store.deleteAcceptance(repoId, 1);
      expect(() => service.accept(repoId, onCheckout({ note: "\u{1F600}".repeat(281) }))).toThrow(ValidationError);
      expect(() => service.accept(repoId, onCheckout({ note: "x".repeat(281) }))).toThrow(/at most 280/);
    });

    it("answers a validation error for a note with a line break or another control character", () => {
      expect(() => service.accept(repoId, onCheckout({ note: "one\ntwo" }))).toThrow(ValidationError);
      expect(() => service.accept(repoId, onCheckout({ note: "bell\u0007" }))).toThrow(/control characters/);
    });

    it("checks the repository and the note before it looks at the files", () => {
      const fresh = store.addRepo("acme", "gadgets", [], "main").id;
      expect(() => service.accept(fresh, onCheckout({ note: " " }))).toThrow(ValidationError);
    });
  });

  it("reads the posture, so a self-hosted finding is accepted only where the report shows it", () => {
    const runner: WorkflowFinding = {
      file: "ci.yml",
      line: 3,
      risk: "selfHosted",
      evidence: "self-hosted",
      onPullRequest: true,
      lineHash: "00112233aabbccdd",
      reachHash: "0123456789abcdef",
    };
    store.saveSupplyChain(repoId, supplyChainRecord({ facts: supplyChainFacts({ findings: [runner] }) }), []);
    const asked = onCheckout({ check: "selfHostedPublic", path: "ci.yml", fingerprint: fingerprintOfFinding(runner) });

    expect(() => service.accept(repoId, asked)).toThrow(ConflictError);
    store.savePosture(repoId, repoPosture({ visibility: "public" }), "2026-10-19T09:00:00.000Z");
    expect(service.accept(repoId, asked).line).toBe(3);
  });

  describe("removing", () => {
    it("removes the acceptance so the finding counts again", () => {
      const { id } = service.accept(repoId, onCheckout());
      expect(service.remove(repoId, id)).toBeUndefined();
      expect(store.acceptances(repoId)).toEqual([]);
    });

    it("answers not found for an unknown repository and for an acceptance that is another repository's or not there", () => {
      const other = store.addRepo("acme", "gadgets", [], "main").id;
      const { id } = service.accept(repoId, onCheckout());

      expect(() => service.remove(999, id)).toThrow(NotFoundError);
      expect(() => service.remove(other, id)).toThrow(/Unknown acceptance/);
      expect(() => service.remove(repoId, 42)).toThrow(NotFoundError);
      expect(store.acceptances(repoId)).toHaveLength(1);
    });
  });

  it("works with the default clock", () => {
    const real = new SecurityAcceptanceService(store, store).accept(repoId, onCheckout());
    expect(real.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
