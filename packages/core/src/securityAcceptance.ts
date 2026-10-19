import type { SupplyChainFound } from "./securityGrade.js";
import {
  ACCEPTANCE_LIMITS,
  GRADED_SUPPLY_CHAIN_CHECKS,
  type AcceptanceStatus,
  type AcceptanceView,
  type ActionUse,
  type DockerfileFacts,
  type FindingAcceptance,
  type KeyFile,
  type SupplyChainCheckId,
  type SupplyChainItem,
  type WorkflowFinding,
} from "./securityTypes.js";
import { shortHash } from "./workflowReach.js";

/**
 * Accepting a finding from the clone (ADR 0040). A fingerprint says what was accepted, so that the acceptance holds
 * while the thing is the same and stops applying, reopening the finding, when it changes. Fingerprints are worked out
 * here at report time and never stored with the facts, so a later change to one kind only bumps its prefix.
 */

/** The fingerprint of the absence of a file or tool, which never changes: it stops applying once the thing appears. */
export const ABSENT = "n1:";
/** The fingerprint of a missing lockfile, which never changes: it stops applying once a lockfile appears. */
export const MISSING_LOCKFILE = "p1:";

const BLOB = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Something a supply chain line can point at, and so something an acceptance can cover. */
export type Subject =
  | { kind: "finding"; finding: WorkflowFinding }
  | { kind: "use"; use: ActionUse }
  | { kind: "key"; key: KeyFile }
  | { kind: "image"; dockerfile: DockerfileFacts }
  | { kind: "lockfile"; path: string }
  | { kind: "absence" };

/** A finding an acceptance covers, with the check it was found under. */
export interface AcceptedHit {
  acceptance: FindingAcceptance;
  check: SupplyChainCheckId;
  subject: Subject;
}

/** The file a subject is in; null for an absence. */
export function subjectPath(subject: Subject): string | null {
  switch (subject.kind) {
    case "finding":
      return subject.finding.file;
    case "use":
      return subject.use.file;
    case "key":
      return subject.key.path;
    case "image":
      return subject.dockerfile.path;
    case "lockfile":
      return subject.path;
    case "absence":
      return null;
  }
}

/** The line a subject is on, or null when it has none. */
export function subjectLine(subject: Subject): number | null {
  if (subject.kind === "finding") return subject.finding.line;
  if (subject.kind === "use") return subject.use.line;
  return null;
}

/**
 * `w2:` and a hash of the risk, file, line hash, evidence and reach hash. The reach hash covers every route that reached
 * the line and every condition consulted on the way, before the three of each kept for display, so a changed line, a new
 * or swapped caller and a guard that was deleted or edited all reopen an acceptance, and an edit above the line does not.
 * A route or a condition going away reopens it too, which is accepted, since the finding was judged as it was reached.
 * The fields are joined with a NUL, which no path, hash or evidence holds, so two findings cannot hash alike by moving a
 * `|` from one field to the next.
 */
export const fingerprintOfFinding = (finding: WorkflowFinding): string =>
  `w2:${shortHash([finding.risk, finding.file, finding.lineHash, finding.evidence, finding.reachHash].join("\0"))}`;

/** `a1:` and a hash of `action@ref`, so moving the line does not reopen it and changing the reference does. */
export const fingerprintOfUse = (use: ActionUse): string => `a1:${shortHash(`${use.action}@${use.ref ?? ""}`)}`;

/** `b:` and the git blob id, or null when the blob was not read, so that finding cannot be accepted. */
export const fingerprintOfBlob = (blob: string | null): string | null => (blob !== null && BLOB.test(blob) ? `b:${blob}` : null);

/** What an acceptance of the subject is matched on, or null when it cannot be accepted. */
export function fingerprintOf(subject: Subject): string | null {
  switch (subject.kind) {
    case "finding":
      return fingerprintOfFinding(subject.finding);
    case "use":
      return fingerprintOfUse(subject.use);
    case "key":
      return fingerprintOfBlob(subject.key.blob);
    case "image":
      return fingerprintOfBlob(subject.dockerfile.blob);
    case "lockfile":
      return MISSING_LOCKFILE;
    case "absence":
      return ABSENT;
  }
}

/**
 * Acceptances by check and path, so a subject is looked up with one `Map` read and its fingerprint is worked out only
 * when something is accepted in its file. The cost stays in proportion to the findings plus the acceptances.
 */
export class AcceptanceIndex {
  private readonly places = new Map<string, FindingAcceptance[]>();

  constructor(acceptances: readonly FindingAcceptance[]) {
    for (const acceptance of acceptances) {
      const key = `${acceptance.check}\0${acceptance.path ?? ""}`;
      const held = this.places.get(key);
      if (held) held.push(acceptance);
      else this.places.set(key, [acceptance]);
    }
  }

  get empty(): boolean {
    return this.places.size === 0;
  }

  /** The acceptance that covers the subject under the check, or null. */
  find(check: SupplyChainCheckId, subject: Subject): FindingAcceptance | null {
    const held = this.places.get(`${check}\0${subjectPath(subject) ?? ""}`);
    if (!held) return null;
    const fingerprint = fingerprintOf(subject);
    return fingerprint === null ? null : (held.find((a) => a.fingerprint === fingerprint) ?? null);
  }
}

/** Most places an acceptance's view lists. */
export const VIEW_ITEM_LIMIT = 50;

/**
 * The checks applied only in a repository known to be public: a self-hosted runner that pull requests reach, and the
 * absence of a security policy, which only outside reporters need.
 */
const PUBLIC_ONLY: ReadonlySet<SupplyChainCheckId> = new Set(["selfHostedPublic", "securityPolicy"]);

/**
 * Why an acceptance that matched nothing in the latest read matched nothing. A check applied only in a public repository
 * is not matched while the repository is not known to be public, and a file whose blob id was not read cannot be
 * compared, so both are unchecked rather than reopened or gone. Otherwise an open finding of the same check in the same
 * file means what was accepted changed.
 */
function lapsed({ check, path }: FindingAcceptance, found: SupplyChainFound): Exclude<AcceptanceStatus, "applies"> {
  if (PUBLIC_ONLY.has(check) && !found.knownPublic) return "unchecked";
  if (path === null) return "gone";
  if (found.uncheckedPaths.get(check)?.has(path) === true) return "unchecked";
  return found.openPaths.get(check)?.has(path) === true ? "reopened" : "gone";
}

/**
 * Every acceptance with whether it still holds. `found` is null when there is no supply chain record, which leaves each
 * acceptance `unchecked`. `itemOf` builds the place a hit points at, so core does not know how a host links a file.
 */
export function acceptanceViews(
  acceptances: readonly FindingAcceptance[],
  found: SupplyChainFound | null,
  itemOf: (check: SupplyChainCheckId, subject: Subject) => SupplyChainItem,
): AcceptanceView[] {
  const hits = new Map<number, AcceptedHit[]>();
  for (const hit of found?.accepted ?? []) {
    const held = hits.get(hit.acceptance.id);
    if (held) held.push(hit);
    else hits.set(hit.acceptance.id, [hit]);
  }
  return acceptances.map((acceptance): AcceptanceView => {
    const graded = GRADED_SUPPLY_CHAIN_CHECKS.includes(acceptance.check);
    if (found === null) return { acceptance, status: "unchecked", graded, covers: 0, items: [] };
    const covered = hits.get(acceptance.id);
    if (covered) {
      const items = covered
        .filter((hit) => hit.subject.kind !== "absence")
        .slice(0, VIEW_ITEM_LIMIT)
        .map((hit) => itemOf(hit.check, hit.subject));
      return { acceptance, status: "applies", graded, covers: covered.length, items };
    }
    return { acceptance, status: lapsed(acceptance, found), graded, covers: 0, items: [] };
  });
}

/** Why a note cannot be stored: nothing is written, it is too long, or it holds a control character. */
export type NoteProblem = "empty" | "tooLong" | "control";

/** How long a note is as the server counts it: the trimmed text, by code point and not by UTF-16 unit. */
export const noteLength = (note: string): number => [...note.trim()].length;

/**
 * Why a note cannot be stored, or null when it can. The note is trimmed, then must hold 1 to `ACCEPTANCE_LIMITS.note`
 * code points and no character from U+0000 to U+001F or U+007F, so a line break inside it is refused. The web and the API
 * both call this, so the form and the server never disagree.
 */
export function noteProblem(note: string): NoteProblem | null {
  const text = note.trim();
  if (text.length === 0) return "empty";
  if (noteLength(text) > ACCEPTANCE_LIMITS.note) return "tooLong";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return "control";
  return null;
}
