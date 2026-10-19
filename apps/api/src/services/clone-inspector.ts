/**
 * What an inspector sees of a clone: its commit, the listing of its files and a way to read one, capped. The listing
 * is the one code health already took, so a clone is listed once however many readers want it. The view is valid only
 * until `inspect` returns, because the clone is removed after.
 */
export interface CloneView {
  repoId: number;
  commitSha: string;
  /** POSIX paths relative to the clone, regular files only, as `WorkspaceReader.list` returns them. */
  paths: readonly string[];
  /**
   * False when the walk that made `paths` was cut short or skipped a directory it could not read, so a file missing from
   * it may still exist. An inspector must not take a missing file to mean a deleted one.
   */
  listingComplete: boolean;
  /** The file's text, or null when it is missing, a link, not a regular file or larger than `maxBytes`. */
  read(path: string, maxBytes: number): Promise<string | null>;
  /**
   * The git blob id of each path at the commit, from the tree and never from the file, so it is safe to ask for a file
   * the inspector must not open. A path that is not a regular file is left out. It raises when the tree cannot be read.
   */
  blobIds(paths: readonly string[]): Promise<Map<string, string>>;
}

/**
 * `partial` when the facts were saved but something the inspector wanted could not be read, so the caller counts the
 * inspection as an attempt for the head, which bounds how often the clone is read again, and stores no failure.
 */
export type InspectOutcome = "complete" | "partial";

/**
 * Something that reads facts from a clone that code health has already made (ADR 0032), so security facts cost no
 * second clone.
 *
 * - `isStale` says whether the facts held for `repoId` need reading again for `head`, the branch's current commit. It
 *   is asked when the head has not moved since the last code snapshot, and a true answer makes code health clone once
 *   just to call `inspect`, without analysing or saving a code snapshot.
 * - `fail` records, beside the facts the inspector holds, that an inspection of the clone failed, with a message that is
 *   safe to show; the next good `inspect` clears it. It is best effort and may throw, and the caller logs that.
 * - `inspect` answers `partial` when it saved facts but could not read all it needed, and may throw. The caller logs it and carries on, so a failure here never costs the code snapshot.
 * - An inspector never runs anything from the clone and never reads outside the view.
 */
export interface CloneInspector {
  isStale(repoId: number, head: string): boolean;
  inspect(view: CloneView): Promise<InspectOutcome>;
  fail(repoId: number, message: string): void;
}
