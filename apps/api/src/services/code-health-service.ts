import {
  CODE_SNAPSHOT_VERSION,
  WORKSPACE_FILES,
  codeHealth,
  detectTooling,
  isCodeFile,
  isManifest,
  toolingCandidates,
  workspacePatterns,
  type CandidateFile,
  type CodeHealthRange,
  type CodeHealthResponse,
  type CodeLayout,
  type CodeSnapshot,
  type Repo,
  type ToolingFacts,
} from "@dora-dashboard/core";
import { AppError, NotFoundError } from "../core/errors.js";
import type { AnalyserReach, CodeAnalyser } from "../interfaces/code-analyser.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { Checkout, SourceCheckout } from "../interfaces/source-checkout.js";
import type { Listing, WorkspaceReader } from "../interfaces/workspace-reader.js";
import { ANALYSER_MISSING, ANALYSIS_OFF, codeSnapshotState } from "./code-snapshot-state.js";
import type { CloneInspector } from "./clone-inspector.js";
import { validateDateRange } from "./date-range.js";

const MAX_CONFIG_BYTES = 256 * 1024;
/** The most code files kept on a snapshot, so a very large repository cannot make one row without bound. */
const MAX_FILES = 200_000;
const MAX_MANIFESTS = 20_000;

/** What reading a clone's files yields. `files` and `layout` are absent when the listing could not be read. */
interface CloneFacts {
  tooling: ToolingFacts | null;
  files?: string[];
  layout?: CodeLayout;
}

export { ANALYSER_MISSING, ANALYSIS_OFF };

/** What is stored when an inspection fails, since the cause may name a path or an address; the detail is in the log. */
export const CLONE_FAILURE = "The repository could not be cloned to read its workflows and dependencies. See the API log.";
export const LISTING_FAILURE =
  "The files of the clone could not be listed to read its workflows and dependencies. See the API log.";
export const INSPECTION_FAILURE = "The workflows and dependencies of the clone could not be read. See the API log.";
/**
 * Two attempts in all for one head, counting the first, and then no more by `inspectIfStale` until the head moves. A crawl
 * that analyses the code inspects the clone whatever the count.
 */
const MAX_INSPECTION_ATTEMPTS = 2;

/** Clones a repository's deploy branch, measures its functions, keeps the result and discards the clone. */
export class CodeHealthService {
  /**
   * Inspections that failed, by repository: the head they were tried on and how many times. In memory, so a process
   * restart tries again, but a persistently failing one does not clone the repository on every crawl.
   */
  private readonly failedInspections = new Map<number, { head: string; attempts: number }>();

  constructor(
    private readonly store: RepoStore,
    private readonly checkout: SourceCheckout | null,
    private readonly analyser: CodeAnalyser | null,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
    /** Reads linter, formatter and CI configuration from the clone. Without it, snapshots carry no tooling facts and no grade. */
    private readonly reader: WorkspaceReader | null = null,
    /**
     * Reads further facts from the clone while it exists (ADR 0032). It needs `reader` as well, to list and read files;
     * without one it is never called.
     */
    private readonly inspector: CloneInspector | null = null,
  ) {}

  /**
   * Never throws for an analysis problem; the problem is stored on the snapshot for the report to explain.
   * Unless `force` is set, a branch whose head is the commit already analysed is not cloned again.
   */
  async analyse(token: string, repoId: number, force = false): Promise<CodeSnapshot> {
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);

    const outcome = await this.measure(token, repo, force);
    if (outcome.unchanged) return outcome.unchanged;
    this.store.saveCodeSnapshot(repoId, outcome.snapshot);
    return outcome.snapshot;
  }

  /** The last successful figures, with `lastError` when a newer attempt failed; `error` only if none ever succeeded. */
  report(repoId: number, range: CodeHealthRange = {}): CodeHealthResponse {
    validateDateRange(range);
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
    const state = codeSnapshotState(this.store, repoId);
    if (state.status !== "ok") return state.status === "none" ? { status: "none" } : { status: "error", ...state.failure };
    const report = codeHealth(state.good, this.store.pullRequests(repoId), range);
    return state.lastError ? { ...report, lastError: state.lastError } : report;
  }

  private failed(error: string): CodeSnapshot {
    return {
      commitSha: "",
      analysedAt: this.now().toISOString(),
      functions: [],
      error,
      snapshotVersion: CODE_SNAPSHOT_VERSION,
    } as CodeSnapshot;
  }

  private async measure(
    token: string,
    repo: Repo,
    force: boolean,
  ): Promise<{ snapshot: CodeSnapshot; unchanged?: CodeSnapshot }> {
    const { checkout, analyser } = this;
    try {
      if (!checkout || !analyser) return { snapshot: this.failed(ANALYSIS_OFF) };
      // The combined analyser never reports "none" today, since it can always measure scripts. This message now mainly
      // comes back from snapshots stored before ADR 0025, when lizard was required for everything.
      const reach = await analyser.reach();
      if (reach === "none") {
        // Supply chain facts need no analyser, so the inspector still runs when there is a reader for it.
        await this.inspectIfStale(token, repo, checkout);
        return { snapshot: this.failed(ANALYSER_MISSING) };
      }
      const { unchanged, head } = force
        ? { unchanged: null, head: null }
        : await this.unchangedSnapshot(token, repo, reach, checkout);
      if (unchanged && head) {
        // The code is as it was measured, but the inspector may want the clone for what it reads.
        await this.inspectIfStale(token, repo, checkout, head);
        return { snapshot: unchanged, unchanged };
      }
      return { snapshot: await this.analyseClone(token, repo, checkout, analyser) };
    } catch (error) {
      this.log.warn({ err: error, repoId: repo.id }, "code analysis failed");
      return { snapshot: this.failed(error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * The stored snapshot when the branch head is still the commit it measured, so the repository is not cloned again.
   * A snapshot from an older version lacks data the current one records, so it is analysed again at the same head. So
   * is one that left files unmeasured once every tool is found, or installing lizard would change nothing. While a tool
   * is still missing the snapshot stands, so the repository is not cloned on every crawl.
   */
  private async unchangedSnapshot(
    token: string,
    repo: Repo,
    reach: AnalyserReach,
    checkout: SourceCheckout,
  ): Promise<{ unchanged: CodeSnapshot | null; head: string | null }> {
    const none = { unchanged: null, head: null };
    const previous = this.store.latestCodeSnapshot(repo.id);
    if (!previous || previous.error || previous.snapshotVersion !== CODE_SNAPSHOT_VERSION) return none;
    if ((previous.unmeasuredFiles ?? 0) > 0 && reach === "full") return none;
    const head = await checkout.headSha(token, repo.owner, repo.name, repo.deployBranch).catch((err: unknown) => {
      this.log.warn({ err, repoId: repo.id }, "could not read the branch head; analysing anyway");
      return null;
    });
    return head && head === previous.commitSha ? { unchanged: previous, head } : none;
  }

  /** Whether an inspection of `head` has already failed as often as it may before the head moves. */
  private givenUp(repoId: number, head: string): boolean {
    const failed = this.failedInspections.get(repoId);
    return failed?.head === head && failed.attempts >= MAX_INSPECTION_ATTEMPTS;
  }

  /**
   * Notes the outcome of an inspection for `head`. A failure is counted, so it is not attempted more than
   * `MAX_INSPECTION_ATTEMPTS` times for one head, and recorded beside the supply chain facts with a message that names no
   * path or address, so the page can say the facts are older than the code. A good inspection clears the count; the
   * store clears the recorded failure when it saves the facts.
   */
  private recordInspection(repoId: number, head: string, failure: string | null): void {
    if (failure === null) {
      this.failedInspections.delete(repoId);
      return;
    }
    const before = this.failedInspections.get(repoId);
    this.failedInspections.set(repoId, { head, attempts: before?.head === head ? before.attempts + 1 : 1 });
    try {
      this.inspector?.fail(repoId, failure);
    } catch (err) {
      this.log.warn({ err, repoId }, "could not record the failed inspection");
    }
  }

  /**
   * Clones for the inspector alone when it says its facts for the branch head are stale, and nothing was analysed.
   * `head` is read when not given. A head that cannot be read is left for the next crawl.
   */
  private async inspectIfStale(token: string, repo: Repo, checkout: SourceCheckout, known?: string): Promise<void> {
    const { inspector, reader } = this;
    if (!inspector || !reader) return;
    const head =
      known ??
      (await checkout.headSha(token, repo.owner, repo.name, repo.deployBranch).catch((err: unknown) => {
        this.log.warn({ err, repoId: repo.id }, "could not read the branch head to inspect it");
        return null;
      }));
    if (!head) return;
    // Stored facts that cannot be read are stale, so the inspection writes them again. Asking must never fail the analysis.
    let stale = true;
    try {
      stale = inspector.isStale(repo.id, head);
    } catch (err) {
      this.log.warn({ err, repoId: repo.id }, "could not tell whether the supply chain facts are stale; reading them again");
    }
    if (!stale || this.givenUp(repo.id, head)) return;
    await this.inspectOnly(token, repo, checkout, inspector, head);
  }

  /**
   * Clones the branch only so the inspector can read it, for a head whose code is already measured or cannot be
   * measured. Nothing is analysed and no code snapshot is saved. Whatever fails is logged and a later crawl tries again,
   * until `MAX_INSPECTION_ATTEMPTS` is reached for the head, because the stored snapshot is still right.
   */
  private async inspectOnly(
    token: string,
    repo: Repo,
    checkout: SourceCheckout,
    inspector: CloneInspector,
    head: string,
  ): Promise<void> {
    let clone: Checkout;
    try {
      clone = await checkout.checkout(token, repo.owner, repo.name, repo.deployBranch);
    } catch (err) {
      this.log.warn({ err, repoId: repo.id }, "could not clone the branch to inspect it");
      this.recordInspection(repo.id, head, CLONE_FAILURE);
      return;
    }
    try {
      await this.inspect(inspector, clone, repo.id, this.listing(clone.dir, repo.id));
    } finally {
      await clone.dispose().catch((err: unknown) => this.log.warn({ err, repoId: repo.id }, "could not remove the checkout"));
    }
  }

  /** The clone's file listing, taken on first use and shared by everything that wants it. Null when it cannot be had. */
  private listing(dir: string, repoId: number): () => Promise<Listing | null> {
    let pending: Promise<Listing | null> | null = null;
    return () => (pending ??= this.listClone(dir, repoId));
  }

  private async listClone(dir: string, repoId: number): Promise<Listing | null> {
    const { reader } = this;
    if (!reader) return null;
    try {
      return await reader.listing(dir);
    } catch (err) {
      this.log.warn({ err, repoId }, "could not read the repository's tooling files");
      return null;
    }
  }

  /**
   * Runs the inspector on the listing. It has its own try/catch, so a failure never reaches the analysis. The outcome
   * is recorded against the clone's commit, which is what limits a failing inspection to a retry per head.
   */
  private async inspect(
    inspector: CloneInspector,
    clone: Checkout,
    repoId: number,
    listing: () => Promise<Listing | null>,
  ): Promise<void> {
    const { reader } = this;
    if (!reader) return;
    try {
      const listed = await listing();
      if (listed === null) return this.recordInspection(repoId, clone.commitSha, LISTING_FAILURE);
      await inspector.inspect({
        repoId,
        commitSha: clone.commitSha,
        paths: listed.paths,
        listingComplete: listed.complete,
        read: (path, maxBytes) => reader.read(clone.dir, path, maxBytes),
      });
      this.recordInspection(repoId, clone.commitSha, null);
    } catch (err) {
      // A bug in the inspection or a failure of the store is not one the person can act on, so it stands out in the log.
      if (err instanceof AppError) this.log.warn({ err, repoId }, "could not inspect the clone");
      else this.log.error({ err, repoId }, "could not inspect the clone unexpectedly");
      this.recordInspection(repoId, clone.commitSha, INSPECTION_FAILURE);
    }
  }

  private recordCloneFailure(repoId: number): void {
    try {
      this.inspector?.fail(repoId, CLONE_FAILURE);
    } catch (err) {
      this.log.warn({ err, repoId }, "could not record the failed clone");
    }
  }

  /** Clones the branch, measures it and reads its tooling, and removes the clone whatever happens. */
  private async analyseClone(token: string, repo: Repo, checkout: SourceCheckout, analyser: CodeAnalyser): Promise<CodeSnapshot> {
    let clone: Checkout;
    try {
      clone = await checkout.checkout(token, repo.owner, repo.name, repo.deployBranch);
    } catch (err) {
      // The failure reaches the code snapshot as before, but the security page must not go on showing the previous
      // commit's workflow and lockfile facts as read with no warning.
      this.recordCloneFailure(repo.id);
      throw err;
    }
    try {
      const listing = this.listing(clone.dir, repo.id);
      if (this.inspector) await this.inspect(this.inspector, clone, repo.id, listing);
      const { functions, partlyMeasured, unmeasuredFiles } = await analyser.analyse(clone.dir);
      if (unmeasuredFiles > 0) {
        this.log.warn(
          { repoId: repo.id, unmeasuredFiles },
          "some source files were left unmeasured because their analysis tool was not found",
        );
      }
      const { tooling, files, layout } = await this.readClone(clone.dir, repo.id, (await listing())?.paths ?? null);
      return {
        commitSha: clone.commitSha,
        analysedAt: this.now().toISOString(),
        functions,
        partlyMeasured,
        unmeasuredFiles,
        error: null,
        tooling,
        ...(files && layout ? { files, layout } : {}),
        snapshotVersion: CODE_SNAPSHOT_VERSION,
      };
    } finally {
      // A clean-up failure must not throw away a finished analysis.
      await clone.dispose().catch((err: unknown) => this.log.warn({ err, repoId: repo.id }, "could not remove the checkout"));
    }
  }

  /**
   * Reads configuration files only, from the listing taken once for the clone: the tooling candidates and the root
   * files that declare workspaces. A listing that fails costs the grade and the areas, not the complexity figures; a
   * file that cannot be read costs only what it would have told us.
   */
  private async readClone(dir: string, repoId: number, paths: string[] | null): Promise<CloneFacts> {
    const { reader } = this;
    if (!reader || paths === null) return { tooling: null };
    const files = paths.filter(isCodeFile).sort().slice(0, MAX_FILES);
    const manifests = paths.filter(isManifest).sort().slice(0, MAX_MANIFESTS);
    const present = new Set(paths);
    const candidates = toolingCandidates(paths);
    const declarations = WORKSPACE_FILES.filter((f) => present.has(f));
    // A file wanted by both, such as the root package.json, is read once.
    const read = await this.readAll(reader, dir, [...new Set([...candidates, ...declarations])]);
    const tooling = this.collect(read, candidates, repoId, "tooling", (found) => detectTooling(found));
    const workspaces = this.collect(read, declarations, repoId, "workspace declaration", workspacePatterns);
    return { tooling, files, layout: { manifests, workspaces } };
  }

  /** The result of `use` over the files asked for, or null, with a log, when any of them failed to read. */
  private collect<T>(
    read: Map<string, string | Error | null>,
    wanted: readonly string[],
    repoId: number,
    what: string,
    use: (files: CandidateFile[]) => T,
  ): T | null {
    const found: CandidateFile[] = [];
    for (const path of wanted) {
      const content = read.get(path) ?? null;
      if (content instanceof Error) {
        this.log.warn({ err: content, repoId }, `could not read the repository's ${what} files`);
        return null;
      }
      if (content !== null) found.push({ path, content });
    }
    return use(found);
  }

  private async readAll(
    reader: WorkspaceReader,
    dir: string,
    paths: readonly string[],
  ): Promise<Map<string, string | Error | null>> {
    const read = new Map<string, string | Error | null>();
    for (const path of paths) {
      read.set(
        path,
        await reader
          .read(dir, path, MAX_CONFIG_BYTES)
          .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      );
    }
    return read;
  }
}
