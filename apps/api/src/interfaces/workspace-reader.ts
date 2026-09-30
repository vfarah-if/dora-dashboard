/**
 * Read-only access to the files of a checkout. It exists so that tooling facts (linter and CI configuration)
 * can be read without ever running anything from the repository being analysed (ADR 0013).
 *
 * Contract every implementation must honour:
 * - `list` returns POSIX paths relative to `dir`, regular files only, never following a symbolic link. It skips
 *   directories named `.git`, `node_modules`, `vendor`, `dist` and `build` at any depth, skips a directory it
 *   cannot read, and stops at a fixed number of entries and a fixed depth.
 * - `read` returns the file's text, or null when it is missing, a symbolic link (or below one), not a regular file, or larger
 *   than `maxBytes`. A path that would leave `dir` raises `ValidationError`.
 */
export interface WorkspaceReader {
  list(dir: string): Promise<string[]>;
  read(dir: string, path: string, maxBytes: number): Promise<string | null>;
}
