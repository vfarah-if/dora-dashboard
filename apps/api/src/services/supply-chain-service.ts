import {
  SUPPLY_CHAIN_VERSION,
  readLockfile,
  supplyChainCandidates,
  supplyChainFacts,
  type CandidateFile,
  type LockedPackage,
  type LockfileSummary,
} from "@dora-dashboard/core";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { SecurityStore } from "../interfaces/security-store.js";
import { AppError } from "../core/errors.js";
import type { CloneInspector, CloneView, InspectOutcome } from "./clone-inspector.js";

/**
 * The largest workflow, composite action, Dockerfile, Makefile or package.json file read. A Dockerfile or workflow
 * over it is passed to core as unread, so the report names it.
 */
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
/** The most a clone's lockfiles may add up to, so a repository of large lockfiles cannot hold the crawl's memory. */
const MAX_LOCKFILE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_LOCKFILES = 20;

const unreadable = (path: string): LockfileSummary => ({
  path,
  read: "unreadable",
  packages: 0,
  publicPackages: 0,
  capped: false,
});

/**
 * Reads the supply chain facts from a clone that code health has already made (ADR 0032): workflows and the actions
 * they use, Dockerfiles, and the lockfiles whose public packages are later looked up (ADR 0034). It reads only the
 * files `supplyChainCandidates` names, so a key-like file is never opened (its blob id comes from the commit's tree), and it
 * runs nothing from the clone.
 *
 * An inspection that completes stores a row even when some files could not be read; the facts say which. When only the
 * blob ids could not be read the facts are still saved, with a null `blobs`, and `inspect` answers `partial` so the
 * caller counts it as a failed attempt for that head. One that throws stores no facts, so they stay stale and a later crawl tries again, until the caller's limit of attempts for one
 * head is reached; the caller records the failure beside them.
 */
export class SupplyChainService implements CloneInspector {
  constructor(
    private readonly store: SecurityStore,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
  ) {}

  isStale(repoId: number, head: string): boolean {
    const record = this.store.supplyChain(repoId);
    // A lookup of blob ids that failed is read again at the same head. The caller counts that inspection as an
    // attempt, though it stores no failure, so it stops at the limit of attempts for the head. A single null blob is not a reason, because a key file
    // with no regular file at the commit has none.
    return !record || record.facts.version !== SUPPLY_CHAIN_VERSION || record.commitSha !== head || !record.facts.blobsRead;
  }

  fail(repoId: number, message: string): void {
    this.store.failSupplyChain(repoId, message, this.now().toISOString());
  }

  async inspect(view: CloneView): Promise<InspectOutcome> {
    const candidates = supplyChainCandidates(view.paths);
    const unread: string[] = [];
    const workflows = await this.readText(view, candidates.workflows, unread);
    const dockerfiles = await this.readText(view, candidates.dockerfiles, unread);
    const tooling = await this.readText(view, candidates.tooling);
    const { summaries, packages } = await this.readLockfiles(view, candidates.lockfiles);
    const blobs = await this.blobIds(view, [...candidates.keyFiles, ...candidates.dockerfiles]);

    const facts = supplyChainFacts({
      paths: view.paths,
      listingComplete: view.listingComplete,
      workflows,
      lockfiles: summaries,
      unread,
      dockerfiles,
      tooling,
      blobs,
    });
    this.store.saveSupplyChain(view.repoId, { commitSha: view.commitSha, readAt: this.now().toISOString(), facts }, packages);
    return blobs === null ? "partial" : "complete";
  }

  /**
   * The blob ids of the key files and Dockerfiles, read from the commit's tree so a key file is still never opened. A
   * git failure costs only the ids: null is returned, the facts are saved with a null blob for each and `blobsRead`
   * false, so those findings cannot be accepted, and `inspect` answers `partial`. Any other error is a bug or a failure
   * of the store and is raised.
   */
  private async blobIds(view: CloneView, paths: readonly string[]): Promise<Map<string, string> | null> {
    if (paths.length === 0) return new Map();
    try {
      return await view.blobIds(paths);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      this.log.warn(
        { err, repoId: view.repoId, paths: paths.length },
        "could not read the blob ids of the key files and Dockerfiles",
      );
      return null;
    }
  }

  /** The files that could be read. When `unread` is given, the paths that could not are added to it. */
  private async readText(view: CloneView, paths: readonly string[], unread?: string[]): Promise<CandidateFile[]> {
    const found: CandidateFile[] = [];
    for (const path of paths) {
      const content = await view.read(path, MAX_TEXT_BYTES);
      if (content === null) unread?.push(path);
      else found.push({ path, content });
    }
    return found;
  }

  /**
   * Each listed lockfile gets a summary. One that cannot be read, that would pass the total budget, or that is past
   * the first `MAX_LOCKFILES` is `unreadable`, so the OSV lookup keeps its alerts rather than closing them. The event
   * loop is yielded to after each parse, so a repository of large lockfiles does not hold the API unresponsive.
   */
  private async readLockfiles(
    view: CloneView,
    paths: readonly string[],
  ): Promise<{ summaries: LockfileSummary[]; packages: LockedPackage[] }> {
    const summaries: LockfileSummary[] = [];
    const packages: LockedPackage[] = [];
    let remaining = MAX_LOCKFILE_TOTAL_BYTES;
    for (const [index, path] of paths.entries()) {
      const content =
        index < MAX_LOCKFILES && remaining > 0 ? await view.read(path, Math.min(MAX_LOCKFILE_BYTES, remaining)) : null;
      if (content === null) {
        summaries.push(unreadable(path));
        continue;
      }
      remaining -= Buffer.byteLength(content);
      const read = readLockfile(path, content);
      summaries.push(read.summary);
      for (const pkg of read.packages) packages.push(pkg);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { summaries, packages };
  }
}
