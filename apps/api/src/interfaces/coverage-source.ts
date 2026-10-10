import type { CoverageArtefact, CoverageReport } from "@dora-dashboard/core";

/**
 * Where a repository's measured test coverage is published, such as the artefacts of GitHub Actions runs. It is read
 * with the token the crawl already holds, so it is a port of its own rather than part of `SourceCheckout` or
 * `IssueProvider` (ADR 0003, ADR 0028). Coverage is shown and never graded (ADR 0013).
 *
 * The adapter downloads and parses the archive, so that a service never imports infrastructure and never sees a
 * file format: `readArtefact` returns reports in core's shape, and `chooseCoverageRun` and `alignCoverage` in core
 * take it from there.
 *
 * Contract every implementation must honour, because the coverage service relies on it:
 * - `findArtefacts` returns the unexpired artefacts of the deploy `branch` whose name says they hold coverage
 *   (`isCoverageArtefactName`), newest first, each with the run and commit that produced it. It leaves out runs from
 *   forks, whose coverage the maintainers did not produce. It reads a bounded number of pages and returns what it has
 *   when it reaches the limit. A repository with no such artefact answers an empty list, never an error.
 * - `readArtefact` downloads one artefact and returns every coverage report in it, with `artefact` set to its name and
 *   `dir` to the directory of each file inside the archive. A report in a format that is not read, such as JaCoCo,
 *   Clover or a Go profile, is left out, so an archive with nothing readable answers an empty list. It never reads an
 *   artefact larger than its limit, nor more than its caps on entries and bytes after unzipping, and raises
 *   `UpstreamError` for an archive that is corrupt or over a cap.
 * - A rejected credential raises `UnauthorisedError`. A repository that is missing, or that the credential cannot see,
 *   and an artefact that has expired or been deleted, raise `NotFoundError`. A credential that lacks the permission to
 *   read Actions artefacts raises `UpstreamError` with a message that says what to grant. Any other failure raises
 *   `UpstreamError`. No message ever carries the token, and none carries a path from inside an archive.
 */
export interface CoverageSource {
  readonly kind: string;
  findArtefacts(token: string, owner: string, name: string, branch: string): Promise<CoverageArtefact[]>;
  readArtefact(token: string, owner: string, name: string, artefact: CoverageArtefact): Promise<CoverageReport[]>;
}
