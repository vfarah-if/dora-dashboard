import { isCoverageArtefactName, type CoverageArtefact, type CoverageReport } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import type { CoverageSource } from "../../interfaces/coverage-source.js";
import { readCoverageArchive } from "../coverage-reports/read-coverage-archive.js";
import { API, download, type Fetch, RATE_LIMIT_MESSAGE, request } from "./github-http.js";

const PAGE_SIZE = 100;
/** Three pages of 100 reach back past the newest 300 artefacts, which is far further than a run worth showing. */
const MAX_PAGES = 3;
/** The most of a zip downloaded. Coverage reports compress well, so a larger artefact is almost certainly not one. */
export const MAX_ARTEFACT_BYTES = 50 * 1024 * 1024;

interface RestArtefact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string | null;
  workflow_run?: {
    id?: number;
    repository_id?: number;
    head_repository_id?: number;
    head_branch?: string | null;
    head_sha?: string | null;
  } | null;
}

interface RestArtefacts {
  artifacts?: RestArtefact[];
}

const noActionsAccess = () =>
  new UpstreamError(
    "GitHub refused access to this repository's Actions artefacts; a fine-grained token needs read access to Actions",
    403,
  );

/** A 403 that is not a rate limit means the token lacks the Actions permission, which the person can grant. */
function explainForbidden(error: unknown): unknown {
  return error instanceof UpstreamError && error.status === 403 && !error.message.startsWith(RATE_LIMIT_MESSAGE)
    ? noActionsAccess()
    : error;
}

/**
 * Reads coverage from the artefacts of GitHub Actions runs (`CoverageSource`). An artefact counts when its name says
 * coverage, it has not expired, its run was on the deploy branch and its run came from this repository and not a fork,
 * which is when the run's head repository is the repository itself. The newest come first.
 */
export class GitHubCoverageSource implements CoverageSource {
  readonly kind = "github";

  constructor(
    private readonly http: Fetch = fetch,
    private readonly base: string = API,
  ) {}

  async findArtefacts(token: string, owner: string, name: string, branch: string): Promise<CoverageArtefact[]> {
    const found: CoverageArtefact[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${this.base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/artifacts?per_page=${PAGE_SIZE}&page=${page}`;
        const body = await request<RestArtefacts>(this.http, token, url);
        const artefacts = body.artifacts ?? [];
        for (const artefact of artefacts) {
          const mapped = this.map(artefact, branch);
          if (mapped) found.push(mapped);
        }
        if (artefacts.length < PAGE_SIZE) break;
      }
    } catch (error) {
      throw explainForbidden(error);
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readArtefact(token: string, owner: string, name: string, artefact: CoverageArtefact): Promise<CoverageReport[]> {
    if (artefact.sizeBytes > MAX_ARTEFACT_BYTES) {
      throw new UpstreamError("The coverage artefact is larger than the limit for reading coverage", 502);
    }
    const url = `${this.base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/artifacts/${artefact.id}/zip`;
    let bytes: Uint8Array;
    try {
      bytes = await download(this.http, token, url, MAX_ARTEFACT_BYTES);
    } catch (error) {
      throw explainForbidden(error);
    }
    return readCoverageArchive(bytes, artefact.name);
  }

  /** The artefact in core's shape, or null when it is not one to read. Fields GitHub left out make it unusable. */
  private map(artefact: RestArtefact, branch: string): CoverageArtefact | null {
    const run = artefact.workflow_run;
    if (
      artefact.expired ||
      typeof artefact.id !== "number" ||
      typeof artefact.name !== "string" ||
      !isCoverageArtefactName(artefact.name) ||
      typeof artefact.created_at !== "string" ||
      !run ||
      run.head_branch !== branch ||
      typeof run.id !== "number" ||
      typeof run.head_sha !== "string" ||
      run.repository_id === undefined ||
      run.head_repository_id !== run.repository_id
    ) {
      return null;
    }
    return {
      id: artefact.id,
      name: artefact.name,
      sizeBytes: artefact.size_in_bytes ?? 0,
      createdAt: artefact.created_at,
      runId: run.id,
      commitSha: run.head_sha,
    };
  }
}
