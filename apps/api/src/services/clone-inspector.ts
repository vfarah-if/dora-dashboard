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
  /** The file's text, or null when it is missing, a link, not a regular file or larger than `maxBytes`. */
  read(path: string, maxBytes: number): Promise<string | null>;
}

/**
 * Something that reads facts from a clone that code health has already made (ADR 0032), so security facts cost no
 * second clone.
 *
 * - `isStale` says whether the facts held for `repoId` need reading again for `head`, the branch's current commit. It
 *   is asked when the head has not moved since the last code snapshot, and a true answer makes code health clone once
 *   just to call `inspect`, without analysing or saving a code snapshot.
 * - `inspect` may throw. The caller logs it and carries on, so a failure here never costs the code snapshot.
 * - An inspector never runs anything from the clone and never reads outside the view.
 */
export interface CloneInspector {
  isStale(repoId: number, head: string): boolean;
  inspect(view: CloneView): Promise<void>;
}
