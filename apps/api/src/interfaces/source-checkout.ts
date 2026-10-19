/** A working copy of a repository on local disk. The caller must `dispose` it, whatever happens. */
export interface Checkout {
  dir: string;
  commitSha: string;
  dispose(): Promise<void>;
  /**
   * The git blob id of each path at the checked-out commit, read from the commit's tree and never from the file, so a
   * file that must not be opened is still identified (ADR 0032). A path that is not a regular file at that commit, such
   * as a link or a submodule, or is missing, is left out. It raises when the tree cannot be read.
   */
  blobIds(paths: readonly string[]): Promise<Map<string, string>>;
}

/**
 * Fetches the source of one branch so that it can be analysed. A checkout is shallow and temporary.
 * A repository or branch the credential cannot read raises `NotFoundError` or `UpstreamError`.
 * Implementations must never place the token in a URL, a log line or an error message.
 */
export interface SourceCheckout {
  /** The commit the branch currently points at, read without cloning. */
  headSha(token: string, owner: string, name: string, branch: string): Promise<string>;
  checkout(token: string, owner: string, name: string, branch: string): Promise<Checkout>;
}
