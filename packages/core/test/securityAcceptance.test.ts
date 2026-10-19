import { describe, expect, it } from "vitest";
import {
  ABSENT,
  AcceptanceIndex,
  MISSING_LOCKFILE,
  acceptanceViews,
  fingerprintOf,
  fingerprintOfBlob,
  fingerprintOfFinding,
  fingerprintOfUse,
  noteLength,
  noteProblem,
  subjectLine,
  subjectPath,
  type Subject,
} from "../src/securityAcceptance.js";
import { findAcceptable, supplyChainFound } from "../src/securityGrade.js";
import {
  ACCEPTANCE_FINGERPRINT,
  CURRENT_FINGERPRINT,
  FINGERPRINT_KINDS,
  RETIRED_FINGERPRINT_KINDS,
  type ActionUse,
  type DockerfileFacts,
  type FindingAcceptance,
  type RepoPosture,
  type SupplyChainItem,
  type WorkflowFinding,
} from "../src/securityTypes.js";
import { shortHash } from "../src/workflowReach.js";
import { acceptance, posture, record } from "./security.js";

const BLOB = "0123456789abcdef0123456789abcdef01234567";
const BLOB_256 = "0123456789abcdef".repeat(4);

const checkout = (overrides: Partial<WorkflowFinding> = {}): WorkflowFinding => ({
  file: ".github/workflows/db.yml",
  line: 31,
  risk: "prHeadCheckout",
  evidence: "github.event.workflow_run.head_sha",
  lineHash: "00112233aabbccdd",
  reachHash: "8899aabbccddeeff",
  routes: [{ trigger: "workflow_run", via: [{ file: ".github/workflows/deploy.yml", job: "deploy" }] }],
  ...overrides,
});
/** How the build before `w2` fingerprinted `checkout()`: its one route, and no condition. */
const RETIRED_CHECKOUT = `w1:${shortHash(
  "prHeadCheckout\x00.github/workflows/db.yml\x0000112233aabbccdd\x00github.event.workflow_run.head_sha\x00workflow_run>.github/workflows/deploy.yml#deploy",
)}`;
const dockerfile = (overrides: Partial<DockerfileFacts> = {}): DockerfileFacts => ({
  path: "Dockerfile",
  blob: BLOB,
  images: 2,
  unpinnedImages: 2,
  latestImages: 0,
  runsAsRoot: false,
  addsRemote: false,
  curlPipeShell: false,
  ...overrides,
});
const use = (overrides: Partial<ActionUse> = {}): ActionUse => ({
  file: ".github/workflows/ci.yml",
  line: 9,
  action: "zed/tool",
  ref: "v1",
  pinned: false,
  kind: "other",
  ...overrides,
});
const finding = (f: WorkflowFinding): Subject => ({ kind: "finding", finding: f });

describe("the fingerprint of a workflow finding", () => {
  it("is w2: and the hash of the risk, file, line hash, evidence and reach hash, joined with NUL", () => {
    // FNV-1a over 64 bits of
    // "prHeadCheckout\0.github/workflows/db.yml\000112233aabbccdd\0github.event.workflow_run.head_sha\08899aabbccddeeff",
    // worked out apart from `shortHash`.
    expect(fingerprintOfFinding(checkout())).toBe("w2:81f25960cb5c6271");
  });

  it("does not let a bar move from one field to the next and give two findings the same fingerprint", () => {
    const a = checkout({ file: "a|b.yml", evidence: "c" });
    const b = checkout({ file: "a.yml", evidence: "b.yml|c" });
    expect(fingerprintOfFinding(a)).not.toBe(fingerprintOfFinding(b));
    expect(fingerprintOfFinding(checkout({ file: "a", evidence: "b|c" }))).not.toBe(
      fingerprintOfFinding(checkout({ file: "a|b", evidence: "c" })),
    );
  });

  it("is sixteen hex digits after the w2 prefix, which both patterns accept", () => {
    expect(fingerprintOfFinding(checkout())).toMatch(/^w2:[0-9a-f]{16}$/);
    expect(ACCEPTANCE_FINGERPRINT.test(fingerprintOfFinding(checkout()))).toBe(true);
    expect(CURRENT_FINGERPRINT.test(fingerprintOfFinding(checkout()))).toBe(true);
  });

  it.each([
    ["an edit to the line", { lineHash: "ffffffffffffffff" }],
    ["another file", { file: ".github/workflows/other.yml" }],
    ["other evidence", { evidence: "github.event.pull_request.head.sha" }],
    ["another risk", { risk: "scriptInjection" as const }],
    // A swapped fourth caller or a deleted guard changes the reach hash and nothing that is shown.
    ["another reach", { reachHash: "8899aabbccddeef0" }],
  ])("changes with %s, so the acceptance reopens", (_what, change: Partial<WorkflowFinding>) => {
    expect(fingerprintOfFinding(checkout(change))).not.toBe(fingerprintOfFinding(checkout()));
  });

  it("stays the same while every hashed field does, whatever the line and the routes and conditions kept for display", () => {
    const same = checkout({
      line: 99,
      routes: [{ trigger: "pull_request_target", via: [] }],
      routesDropped: 3,
      conditions: [{ file: "a.yml", line: 4, text: "always()", verdict: "unknown" }],
      conditionsDropped: 2,
    });
    expect(fingerprintOfFinding(same)).toBe(fingerprintOfFinding(checkout()));
    expect(fingerprintOfFinding(checkout({ routes: [] }))).toBe(fingerprintOfFinding(checkout()));
  });
});

describe("the kinds of fingerprint", () => {
  it("makes w2, a1, b, p1 and n1, and has retired w1", () => {
    expect(FINGERPRINT_KINDS).toEqual(["w2", "a1", "b", "p1", "n1"]);
    expect(RETIRED_FINGERPRINT_KINDS).toEqual(["w1"]);
  });

  it("still loads a stored w1 fingerprint, so its row reads as reopened rather than vanishing, but accepts nothing new under it", () => {
    expect(ACCEPTANCE_FINGERPRINT.test(RETIRED_CHECKOUT)).toBe(true);
    expect(CURRENT_FINGERPRINT.test(RETIRED_CHECKOUT)).toBe(false);
  });

  it.each([
    ["a workflow finding", { kind: "finding", finding: checkout() }],
    ["an action use", { kind: "use", use: use() }],
    ["a key file", { kind: "key", key: { path: ".env", blob: BLOB, strength: "strong" } }],
    ["a Dockerfile", { kind: "image", dockerfile: dockerfile() }],
    ["a missing lockfile", { kind: "lockfile", path: "web/package.json" }],
    ["an absence", { kind: "absence" }],
  ] as [string, Subject][])("makes %s's fingerprint with a current kind", (_what, subject) => {
    expect(CURRENT_FINGERPRINT.test(fingerprintOf(subject)!)).toBe(true);
  });
});

describe("the other fingerprints", () => {
  it("hashes an action use as action@ref, so moving the line keeps it and a new reference changes it", () => {
    expect(fingerprintOfUse(use())).toBe(`a1:${shortHash("zed/tool@v1")}`);
    expect(fingerprintOfUse(use({ line: 40 }))).toBe(fingerprintOfUse(use()));
    expect(fingerprintOfUse(use({ ref: "v2" }))).not.toBe(fingerprintOfUse(use()));
    expect(fingerprintOfUse(use({ action: "docker://alpine", ref: null }))).toBe(`a1:${shortHash("docker://alpine@")}`);
  });

  it("uses the git blob id of a key file or a Dockerfile, of either length", () => {
    expect(fingerprintOfBlob(BLOB)).toBe(`b:${BLOB}`);
    expect(fingerprintOfBlob(BLOB_256)).toBe(`b:${BLOB_256}`);
    expect(ACCEPTANCE_FINGERPRINT.test(`b:${BLOB_256}`)).toBe(true);
  });

  it("gives no fingerprint, so no acceptance, when the blob was not read or is not a blob id", () => {
    expect(fingerprintOfBlob(null)).toBeNull();
    expect(fingerprintOfBlob("not-a-blob")).toBeNull();
    expect(fingerprintOfBlob(BLOB.toUpperCase())).toBeNull();
    expect(fingerprintOf({ kind: "key", key: { path: ".env", blob: null, strength: "strong" } })).toBeNull();
  });

  it("is p1: for a missing lockfile and n1: for the absence of a file or tool, which never change", () => {
    expect(fingerprintOf({ kind: "lockfile", path: "web/package.json" })).toBe(MISSING_LOCKFILE);
    expect(MISSING_LOCKFILE).toBe("p1:");
    expect(fingerprintOf({ kind: "absence" })).toBe(ABSENT);
    expect(ABSENT).toBe("n1:");
    expect(ACCEPTANCE_FINGERPRINT.test("p1:") && ACCEPTANCE_FINGERPRINT.test("n1:")).toBe(true);
  });

  it("reads each kind through one function", () => {
    expect(fingerprintOf(finding(checkout()))).toBe(fingerprintOfFinding(checkout()));
    expect(fingerprintOf({ kind: "use", use: use() })).toBe(fingerprintOfUse(use()));
    expect(fingerprintOf({ kind: "image", dockerfile: dockerfile() })).toBe(`b:${BLOB}`);
  });

  it("refuses a fingerprint neither pattern would accept", () => {
    for (const bad of [
      "",
      "w1:abc",
      "w2:abc",
      "w3:0123456789abcdef",
      "b:xyz",
      "a1:0123456789ABCDEF",
      "n1:x",
      "x w2:0123456789abcdef",
    ]) {
      expect(ACCEPTANCE_FINGERPRINT.test(bad), bad).toBe(false);
      expect(CURRENT_FINGERPRINT.test(bad), bad).toBe(false);
    }
  });

  it("names the path and the line of a subject, and neither for an absence", () => {
    expect(subjectPath(finding(checkout()))).toBe(".github/workflows/db.yml");
    expect(subjectLine(finding(checkout()))).toBe(31);
    expect(subjectPath({ kind: "use", use: use() })).toBe(".github/workflows/ci.yml");
    expect(subjectLine({ kind: "use", use: use() })).toBe(9);
    expect(subjectPath({ kind: "lockfile", path: "p.json" })).toBe("p.json");
    expect(subjectLine({ kind: "lockfile", path: "p.json" })).toBeNull();
    expect(subjectPath({ kind: "absence" })).toBeNull();
  });
});

describe("the index of acceptances", () => {
  const held = acceptance({
    id: 5,
    check: "prHeadCheckout",
    path: ".github/workflows/db.yml",
    fingerprint: fingerprintOfFinding(checkout()),
  });

  it("finds the acceptance by check, path and fingerprint, and nothing else", () => {
    const index = new AcceptanceIndex([held]);
    expect(index.find("prHeadCheckout", finding(checkout()))).toBe(held);
    expect(index.find("scriptInjection", finding(checkout()))).toBeNull();
    expect(index.find("prHeadCheckout", finding(checkout({ file: "other.yml" })))).toBeNull();
    expect(index.find("prHeadCheckout", finding(checkout({ lineHash: "ffffffffffffffff" })))).toBeNull();
  });

  it("is empty with no acceptance, and finds the absence of a tool under a null path", () => {
    expect(new AcceptanceIndex([]).empty).toBe(true);
    expect(new AcceptanceIndex([held]).empty).toBe(false);
    const absent = acceptance();
    expect(new AcceptanceIndex([absent]).find("dependencyReview", { kind: "absence" })).toBe(absent);
  });

  it("never matches a subject with no fingerprint", () => {
    const key = { path: ".env", blob: null, strength: "strong" as const };
    const odd = acceptance({ check: "keyFiles", path: ".env", fingerprint: "b:" + BLOB });
    expect(new AcceptanceIndex([odd]).find("keyFiles", { kind: "key", key })).toBeNull();
  });

  it("tells two acceptances of one check in one file apart by their fingerprints", () => {
    const other = checkout({ line: 50, lineHash: "ffffffffffffffff" });
    const second = acceptance({ id: 6, check: "prHeadCheckout", path: other.file, fingerprint: fingerprintOfFinding(other) });
    const index = new AcceptanceIndex([held, second]);
    expect(index.find("prHeadCheckout", finding(checkout()))).toBe(held);
    expect(index.find("prHeadCheckout", finding(other))).toBe(second);
  });
});

describe("what an acceptance covers once the facts are split", () => {
  const owner = "acme";
  const itemOf = (_check: string, subject: Subject): SupplyChainItem => ({
    path: subjectPath(subject) ?? "",
    line: subjectLine(subject),
    detail: null,
    url: null,
    risk: null,
    fingerprint: fingerprintOf(subject),
    routes: [],
    routesDropped: 0,
    conditions: [],
    conditionsDropped: 0,
  });
  const accept = (f: WorkflowFinding, id = 1, check: FindingAcceptance["check"] = "prHeadCheckout"): FindingAcceptance =>
    acceptance({ id, check, path: f.file, line: f.line, fingerprint: fingerprintOfFinding(f) });
  const viewsOf = (
    acceptances: FindingAcceptance[],
    overrides: Parameters<typeof record>[0] = {},
    held: RepoPosture | null = null,
  ) => {
    const supplyChain = record(overrides);
    return acceptanceViews(acceptances, supplyChainFound(supplyChain, owner, held, acceptances), itemOf);
  };
  const statusOf = (...args: Parameters<typeof viewsOf>) => viewsOf(...args)[0]!.status;

  it("applies when it matches a finding of the latest read, and lists the place with how many it covers", () => {
    const [view] = viewsOf([accept(checkout())], { findings: [checkout()] });
    expect(view).toMatchObject({ status: "applies", graded: true, covers: 1 });
    expect(view!.items).toEqual([expect.objectContaining({ path: ".github/workflows/db.yml", line: 31 })]);
  });

  it("covers two identical lines in one file with the one acceptance", () => {
    const twin = checkout({ line: 77 });
    const [view] = viewsOf([accept(checkout())], { findings: [checkout(), twin] });
    expect(view).toMatchObject({ status: "applies", covers: 2 });
    expect(view!.items.map((i) => i.line)).toEqual([31, 77]);
  });

  it("is reopened when the file still holds an open finding of the same check that no longer matches", () => {
    const changed = checkout({ lineHash: "ffffffffffffffff" });
    const [view] = viewsOf([accept(checkout())], { findings: [changed] });
    expect(view).toMatchObject({ status: "reopened", covers: 0, items: [] });
  });

  it("is gone when nothing of its check is left in the file", () => {
    const [view] = viewsOf([accept(checkout())], { findings: [checkout({ file: "other.yml" })] });
    expect(view).toMatchObject({ status: "gone", covers: 0, items: [] });
  });

  it("is not reopened by an open finding of another check in the same file", () => {
    const other = checkout({ risk: "scriptInjection", lineHash: "1111111111111111" });
    const [view] = viewsOf([accept(checkout())], { findings: [other] });
    expect(view!.status).toBe("gone");
  });

  it("is unchecked for every acceptance when there is no supply chain record", () => {
    const views = acceptanceViews([accept(checkout()), acceptance({ id: 2 })], null, itemOf);
    expect(views.map((v) => [v.acceptance.id, v.status, v.covers, v.items])).toEqual([
      [1, "unchecked", 0, []],
      [2, "unchecked", 0, []],
    ]);
  });

  it("applies to a missing lockfile until one appears, then is gone", () => {
    const missing = acceptance({ id: 3, check: "lockfiles", path: "web/package.json", fingerprint: "p1:" });
    expect(viewsOf([missing], { missingLockfiles: ["web/package.json"] })[0]).toMatchObject({ status: "applies", graded: false });
    expect(viewsOf([missing], { missingLockfiles: [] })[0]).toMatchObject({ status: "gone" });
  });

  it("applies to an absence until the tool appears, lists no place for it, and never reopens", () => {
    const absent = acceptance({ id: 4 });
    const none = { securityTools: [] };
    expect(viewsOf([absent], none)[0]).toMatchObject({ status: "applies", covers: 1, items: [] });
    expect(viewsOf([absent])[0]).toMatchObject({ status: "gone", covers: 0 });
  });

  it("applies to a key file only while its blob id is the one accepted, and reopens when the file changes", () => {
    const key = (blob: string | null) => ({ keyFiles: [{ path: ".env.production", blob, strength: "strong" as const }] });
    const held = acceptance({ id: 6, check: "keyFiles", path: ".env.production", fingerprint: `b:${BLOB}` });
    expect(viewsOf([held], key(BLOB))[0]).toMatchObject({ status: "applies", graded: true });
    expect(viewsOf([held], key("f".repeat(40)))[0]).toMatchObject({ status: "reopened" });
  });

  describe("a key file or Dockerfile whose blob id was not read", () => {
    const keyHeld = acceptance({ id: 6, check: "keyFiles", path: ".env.production", fingerprint: `b:${BLOB}` });
    const imageHeld = acceptance({ id: 7, check: "baseImagesPinned", path: "Dockerfile", fingerprint: `b:${BLOB}` });
    const key = (blob: string | null) => [{ path: ".env.production", blob, strength: "strong" as const }];

    it("is unchecked, not reopened, when the file's own blob is null though the lookup worked", () => {
      expect(statusOf([keyHeld], { keyFiles: key(null), blobsRead: true })).toBe("unchecked");
      expect(statusOf([imageHeld], { dockerfiles: [dockerfile({ blob: null })], blobsRead: true })).toBe("unchecked");
    });

    it("is unchecked when the lookup of blob ids failed as a whole", () => {
      expect(statusOf([keyHeld], { keyFiles: key(null), blobsRead: false })).toBe("unchecked");
      expect(statusOf([imageHeld], { dockerfiles: [dockerfile({ blob: null })], blobsRead: false })).toBe("unchecked");
      // The facts say the lookup failed, so even a blob id held from somewhere else is not compared.
      expect(statusOf([keyHeld], { keyFiles: key("f".repeat(40)), blobsRead: false })).toBe("unchecked");
    });

    it("is gone when the file no longer holds a finding of its check, which needs no blob id to see", () => {
      expect(statusOf([keyHeld], { keyFiles: [], blobsRead: false })).toBe("gone");
      expect(statusOf([imageHeld], { dockerfiles: [dockerfile({ blob: null, unpinnedImages: 0 })], blobsRead: false })).toBe(
        "gone",
      );
    });

    it("leaves an action use reopened when the lookup failed, as it is matched on its reference and not on a blob", () => {
      const held = acceptance({
        id: 8,
        check: "unpinnedActions",
        path: ".github/workflows/ci.yml",
        fingerprint: `a1:${"0".repeat(16)}`,
      });
      expect(statusOf([held], { actions: [use()], blobsRead: false })).toBe("reopened");
    });
  });

  it("reads a w1 row stored by the earlier build as reopened while its check still finds something in the file", () => {
    const retired = acceptance({ id: 9, check: "prHeadCheckout", path: checkout().file, fingerprint: RETIRED_CHECKOUT });
    expect(statusOf([retired], { findings: [checkout()] })).toBe("reopened");
    expect(statusOf([retired], { findings: [] })).toBe("gone");
  });

  /** Every way a repository can be not known to be public. */
  const NOT_PUBLIC: [string, RepoPosture | null][] = [
    ["the visibility could not be read", posture({ visibility: null })],
    ["no posture has been read", null],
    ["the repository is private", posture({ visibility: "private" })],
    ["the repository is internal", posture({ visibility: "internal" })],
  ];

  describe("a self-hosted runner", () => {
    const runner = checkout({ risk: "selfHosted", onPullRequest: true, evidence: "self-hosted" });
    const held = accept(runner, 10, "selfHostedPublic");

    it("applies in a public repository, and reopens there when the finding changes", () => {
      expect(statusOf([held], { findings: [runner] }, posture({ visibility: "public" }))).toBe("applies");
      const moved = { ...runner, reachHash: "0000000000000000" };
      expect(statusOf([held], { findings: [moved] }, posture({ visibility: "public" }))).toBe("reopened");
    });

    it.each(NOT_PUBLIC)(
      "is unchecked, not gone, while %s, as the check is applied only in a public repository",
      (_what, seen) => {
        expect(statusOf([held], { findings: [runner] }, seen)).toBe("unchecked");
        expect(statusOf([held], { findings: [] }, seen)).toBe("unchecked");
      },
    );
  });

  describe("the accepted absence of a security policy", () => {
    const held = acceptance({ id: 11, check: "securityPolicy" });
    const missing = { securityPolicy: null };
    const present = { securityPolicy: "SECURITY.md" };

    it("applies in a public repository while the policy is missing, and is gone once one is added", () => {
      expect(statusOf([held], missing, posture({ visibility: "public" }))).toBe("applies");
      expect(statusOf([held], present, posture({ visibility: "public" }))).toBe("gone");
    });

    it.each(NOT_PUBLIC)(
      "is unchecked, not gone, while %s, as a policy is asked for only in a public repository",
      (_what, seen) => {
        expect(statusOf([held], missing, seen)).toBe("unchecked");
        expect(statusOf([held], present, seen)).toBe("unchecked");
      },
    );

    it("leaves the accepted absence of a tool that is asked for everywhere gone in a private repository once it is added", () => {
      // The clean record runs a dependency review, so nothing of that check is missing.
      const review = acceptance({ id: 12, check: "dependencyReview" });
      expect(statusOf([review], {}, posture({ visibility: "private" }))).toBe("gone");
    });
  });

  it("applies to a Dockerfile under each of its checks on its own", () => {
    const held = acceptance({ id: 7, check: "baseImagesPinned", path: "Dockerfile", fingerprint: `b:${BLOB}` });
    const found = supplyChainFound(record({ dockerfiles: [dockerfile({ runsAsRoot: true })] }), owner, null, [held]);
    expect(found.images.unpinned).toEqual([]);
    expect(found.images.root).toHaveLength(1);
    expect(found.acceptedByCheck).toEqual({ baseImagesPinned: 1 });
  });

  it("keeps the order of the acceptances it was given", () => {
    const views = viewsOf([acceptance({ id: 9 }), acceptance({ id: 2, check: "staticAnalysis" })], { securityTools: [] });
    expect(views.map((v) => v.acceptance.id)).toEqual([9, 2]);
  });
});

describe("whether a request names something that can be accepted", () => {
  const owner = "acme";
  const supplyChain = record({
    findings: [checkout({ line: 31 })],
    actions: [use({ line: 12 })],
    securityTools: [],
    keyFiles: [
      { path: ".env.production", blob: BLOB, strength: "strong" },
      { path: ".env.staging", blob: null, strength: "strong" },
    ],
  });
  const request = (overrides: Partial<FindingAcceptance>) => {
    const { id: _id, line: _line, acceptedAt: _at, ...rest } = acceptance(overrides);
    return rest;
  };

  it("returns the line of the finding, never one from the request", () => {
    const asked = request({
      check: "prHeadCheckout",
      path: ".github/workflows/db.yml",
      fingerprint: fingerprintOfFinding(checkout()),
    });
    expect(findAcceptable(supplyChain, owner, null, { ...asked, line: 1 } as never)).toEqual({ line: 31 });
  });

  it("returns the line of an action use and null for a file or an absence", () => {
    expect(
      findAcceptable(
        supplyChain,
        owner,
        null,
        request({ check: "unpinnedActions", path: ".github/workflows/ci.yml", fingerprint: fingerprintOfUse(use()) }),
      ),
    ).toEqual({ line: 12 });
    expect(
      findAcceptable(supplyChain, owner, null, request({ check: "keyFiles", path: ".env.production", fingerprint: `b:${BLOB}` })),
    ).toEqual({ line: null });
    expect(findAcceptable(supplyChain, owner, null, request({}))).toEqual({ line: null });
  });

  it("refuses a finding that is not in the read, a changed fingerprint and a file whose blob was not read", () => {
    expect(
      findAcceptable(
        supplyChain,
        owner,
        null,
        request({ check: "prHeadCheckout", path: "gone.yml", fingerprint: fingerprintOfFinding(checkout()) }),
      ),
    ).toBeNull();
    expect(
      findAcceptable(
        supplyChain,
        owner,
        null,
        request({ check: "prHeadCheckout", path: ".github/workflows/db.yml", fingerprint: `w2:${"0".repeat(16)}` }),
      ),
    ).toBeNull();
    expect(
      findAcceptable(supplyChain, owner, null, request({ check: "keyFiles", path: ".env.staging", fingerprint: `b:${BLOB}` })),
    ).toBeNull();
  });

  it("never accepts a finding under a retired kind, even the one the earlier build made for this very finding", () => {
    const asked = request({ check: "prHeadCheckout", path: ".github/workflows/db.yml", fingerprint: RETIRED_CHECKOUT });
    expect(findAcceptable(supplyChain, owner, null, asked)).toBeNull();
    expect(findAcceptable(supplyChain, owner, null, { ...asked, fingerprint: fingerprintOfFinding(checkout()) })).toEqual({
      line: 31,
    });
  });

  it("refuses an absence that is not there, and the absence of a security policy in a private repository", () => {
    expect(findAcceptable(record(), owner, null, request({}))).toBeNull();
    const policy = request({ check: "securityPolicy", fingerprint: "n1:" });
    const missing = record({ securityPolicy: null });
    expect(findAcceptable(missing, owner, posture({ visibility: "private" }), policy)).toBeNull();
    expect(findAcceptable(missing, owner, posture({ visibility: "public" }), policy)).toEqual({ line: null });
  });

  it("refuses a self-hosted finding while the visibility is not known, since the report shows none", () => {
    const runner = checkout({ risk: "selfHosted", onPullRequest: true, evidence: "self-hosted" });
    const sc = record({ findings: [runner] });
    const asked = request({ check: "selfHostedPublic", path: runner.file, fingerprint: fingerprintOfFinding(runner) });
    expect(findAcceptable(sc, owner, posture({ visibility: null }), asked)).toBeNull();
    expect(findAcceptable(sc, owner, posture({ visibility: "public" }), asked)).toEqual({ line: 31 });
    // In a private repository there is no one outside to open a pull request, so there is nothing to accept either.
    expect(findAcceptable(sc, owner, posture({ visibility: "private" }), asked)).toBeNull();
  });
});

describe("the note on an acceptance", () => {
  it("counts the trimmed text by code point, so an emoji of two UTF-16 units is one character", () => {
    expect(noteLength("  ab  ")).toBe(2);
    // "😀" is the surrogate pair U+D83D U+DE00, which `length` counts as 2.
    expect("😀".length).toBe(2);
    expect(noteLength("😀")).toBe(1);
    expect(noteLength("")).toBe(0);
  });

  it.each([
    ["nothing", "", "empty"],
    ["only spaces and line breaks", " \n\t ", "empty"],
    ["one character more than the limit", "a".repeat(281), "tooLong"],
    ["281 emoji, which is 562 UTF-16 units", "😀".repeat(281), "tooLong"],
    ["a line break inside it", "line one\nline two", "control"],
    ["a tab inside it", "one\ttwo", "control"],
    ["a NUL", "one\u0000two", "control"],
    ["a delete character", "one\u007ftwo", "control"],
    // Length is checked first, as the form shows the count beside the field.
    ["too many characters and a control character", `${"a".repeat(140)}\n${"a".repeat(141)}`, "tooLong"],
  ])("refuses a note holding %s", (_what, note, problem) => {
    expect(noteProblem(note)).toBe(problem);
  });

  it.each([
    ["exactly the limit", "a".repeat(280)],
    ["280 emoji, which is 560 UTF-16 units", "😀".repeat(280)],
    ["the limit with spaces around it, which are trimmed", ` ${"a".repeat(280)} \n`],
    ["one character", "x"],
    ["a C1 character, which is outside the range refused", "one\u0080two"],
  ])("takes a note of %s", (_what, note) => {
    expect(noteProblem(note)).toBeNull();
  });
});
