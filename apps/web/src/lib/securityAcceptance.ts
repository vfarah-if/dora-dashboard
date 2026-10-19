import { ACCEPTANCE_LIMITS, ACCEPTANCE_REASONS, FINGERPRINT_KINDS } from "@dora-dashboard/core";
import type {
  AcceptanceReason,
  AcceptanceRequest,
  AcceptanceView,
  Band,
  FingerprintKind,
  NoteProblem,
  SupplyChainItem,
  SupplyChainLine,
} from "@dora-dashboard/core";
import { ApiError } from "../api/client";
import { copy } from "../copy";

const c = copy.security.acceptance;

/** The reasons in the order the form lists them, read from core so a reason added there reaches the form. */
export const REASONS: readonly AcceptanceReason[] = ACCEPTANCE_REASONS;

/** An item can be accepted only when core could say what to match it on. */
export const canAccept = <T extends Pick<SupplyChainItem, "fingerprint">>(item: T): item is T & { fingerprint: string } =>
  item.fingerprint !== null;

/**
 * What the note on the grade says: the band the repository would have without its acceptances, or that they change
 * nothing. Null when no graded finding is accepted or the band before is not known.
 */
export function acceptanceNote(band: Band | null, before: Band | null, graded: number): string | null {
  if (band === null || before === null || graded <= 0) return null;
  return before === band ? c.note.unchanged(graded) : c.note.changed(copy.dora.band[before], graded);
}

/** The prefix of a fingerprint, such as `w2` for `w2:0123456789abcdef`. */
const kindOf = (fingerprint: string): string => fingerprint.slice(0, fingerprint.indexOf(":"));

const isCurrentKind = (kind: string): kind is FingerprintKind => (FINGERPRINT_KINDS as readonly string[]).includes(kind);

/**
 * When an acceptance stops holding, by the kind of fingerprint it was matched on. The wording is typed by core's kinds,
 * so a new kind fails the build until its sentence exists, and a retired kind reads with the general rule.
 */
export function reopenRule(fingerprint: string): string {
  const kind = kindOf(fingerprint);
  return isCurrentKind(kind) ? c.section.reopen[kind] : c.section.reopenOther;
}

/**
 * Whether an acceptance is a decision still standing, which is Undone, and not one that has lapsed and is only tidied
 * away. One that has not been checked yet stands until the next crawl says otherwise.
 */
export const isLive = (view: Pick<AcceptanceView, "status">): boolean => view.status === "applies" || view.status === "unchecked";

export const statusSentence = (view: Pick<AcceptanceView, "status">): string => c.section.status[view.status];

/**
 * The sentence for a 409 from accepting a finding, by the code that says why, or the general one when the API sent a 409
 * with no code this build knows. Null for any other failure, which shows from the request's own error.
 */
export function conflictText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const sentences: Record<string, string> = c.conflicts;
  return error.code !== null && Object.hasOwn(sentences, error.code) ? sentences[error.code]! : c.changed;
}

export const noteProblemText = (problem: NoteProblem): string =>
  problem === "tooLong" ? c.problems.tooLong(ACCEPTANCE_LIMITS.note) : c.problems[problem];

export type AcceptTarget = Omit<AcceptanceRequest, "reason" | "note">;

/** The body of the request: exactly the five fields the API takes, with the note trimmed. */
export function acceptanceRequest(target: AcceptTarget, reason: AcceptanceReason, note: string): AcceptanceRequest {
  return { check: target.check, path: target.path, fingerprint: target.fingerprint, reason, note: note.trim() };
}

/** A line is wholly accepted when something was accepted and nothing open is left, so its state is Accepted. */
export const fullyAccepted = (line: Pick<SupplyChainLine, "accepted" | "total" | "absence">): boolean =>
  line.accepted > 0 && line.total === 0 && line.absence === null;
