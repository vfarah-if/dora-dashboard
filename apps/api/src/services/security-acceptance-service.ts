import {
  ACCEPTANCE_LIMITS,
  findAcceptable,
  noteProblem,
  type AcceptanceRequest,
  type NoteProblem,
  type FindingAcceptance,
} from "@dora-dashboard/core";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SecurityStore } from "../interfaces/security-store.js";

const NOTE_MESSAGES: Record<NoteProblem, string> = {
  empty: "Say why this finding is accepted, in a few words",
  tooLong: `The note may be at most ${ACCEPTANCE_LIMITS.note} characters`,
  control: "The note must be one line, with no control characters",
};

/**
 * Accepting and un-accepting findings of the clone (ADR 0040). The service is handed the request and nothing of the
 * session, so no login, token or session value can reach the store, and the line and the time come from the finding and
 * the clock, never from the caller. Matching is core's, so what can be accepted is exactly what the grade then leaves out.
 */
export class SecurityAcceptanceService {
  constructor(
    private readonly store: RepoStore,
    private readonly securityStore: SecurityStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  accept(repoId: number, request: AcceptanceRequest): FindingAcceptance {
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);
    const note = request.note.trim();
    const problem = noteProblem(note);
    if (problem !== null) throw new ValidationError(NOTE_MESSAGES[problem]);
    const record = this.securityStore.supplyChain(repoId);
    if (record === null)
      throw new ConflictError(
        "The repository's files have not been read yet, so nothing can be accepted",
        "acceptance_no_record",
      );
    const posture = this.securityStore.posture(repoId)?.value ?? null;
    const found = findAcceptable(record, repo.owner, posture, request);
    if (found === null) {
      throw new ConflictError(
        "That finding is not in the latest read of the repository. Reload the page and try again",
        "acceptance_finding_changed",
      );
    }
    if (this.securityStore.acceptances(repoId).length >= ACCEPTANCE_LIMITS.perRepository) {
      throw new ConflictError(
        `A repository may hold at most ${ACCEPTANCE_LIMITS.perRepository} accepted findings`,
        "acceptance_limit",
      );
    }
    const saved = this.securityStore.saveAcceptance(repoId, {
      check: request.check,
      path: request.path,
      line: found.line,
      fingerprint: request.fingerprint,
      reason: request.reason,
      note,
      acceptedAt: this.clock().toISOString(),
    });
    if (saved === null) throw new ConflictError("That finding is already accepted", "acceptance_duplicate");
    return saved;
  }

  remove(repoId: number, acceptanceId: number): void {
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
    if (!this.securityStore.deleteAcceptance(repoId, acceptanceId)) throw new NotFoundError(`Unknown acceptance ${acceptanceId}`);
  }
}
