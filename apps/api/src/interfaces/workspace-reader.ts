/** The files of a checkout, and whether the walk that found them saw every directory it meant to. */
export interface Listing {
  paths: string[];
  complete: boolean;
}

/**
 * Read-only access to the files of a checkout. It exists so that tooling facts (linter and CI configuration) and
 * source files can be read without ever running anything from the repository being analysed (ADR 0013).
 *
 * Contract every implementation must honour:
 * - `list` returns POSIX paths relative to `dir`, regular files only, never following a symbolic link. It skips
 *   directories named `.git`, `node_modules`, `vendor`, `dist` and `build` at any depth, skips a directory it
 *   cannot read, and stops at a fixed number of entries and a fixed depth, which an implementation reports
 *   when it cuts the listing short, since the files left out are never measured.
 * - `listing` is `list` with whether the walk was complete. It is not when it stopped at the entry or depth limit, or when a
 *   directory could not be read, because a file may then be missing from the paths without being deleted.
 * - `read` returns the file's text, or null when it is missing, a symbolic link (or below one), not a regular file, or larger
 *   than `maxBytes`. A path that would leave `dir` raises `ValidationError`.
 */
export interface WorkspaceReader {
  list(dir: string): Promise<string[]>;
  listing(dir: string): Promise<Listing>;
  read(dir: string, path: string, maxBytes: number): Promise<string | null>;
}
