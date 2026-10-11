import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { ValidationError } from "../../core/errors.js";
import { noopLogger, type Logger } from "../../interfaces/logger.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";

/**
 * Directories skipped by name, at any depth: `.git` is the clone's own data, and the rest are dependencies and
 * build output that can be enormous and never hold the configuration or source we look for.
 */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "vendor", "dist", "build"]);

export interface ReaderLimits {
  /** Files and directories visited before the walk stops. */
  maxEntries: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: ReaderLimits = { maxEntries: 200_000, maxDepth: 30 };

/**
 * The entries of a directory under `root`, or null when one below the root cannot be read, which costs its own files
 * and not the whole listing. A root that cannot be read raises, as an empty listing would pass for an empty checkout.
 */
async function entriesOf(root: string, relative: string): Promise<Dirent[] | null> {
  try {
    return await readdir(relative ? resolve(root, relative) : root, { withFileTypes: true });
  } catch (error) {
    if (!relative) throw new Error("The checkout could not be listed", { cause: error });
    return null;
  }
}

/** The path of an entry relative to the root of the listing, always with `/`. */
const childPath = (relative: string, name: string): string => (relative ? `${relative}/${name}` : name);

/** Reads files with `node:fs` only. Nothing is executed, symbolic links are never followed. */
export class FsWorkspaceReader implements WorkspaceReader {
  /** The last directory whose listing was cut short, so one analysis listing it several times warns once. */
  private lastCut: string | null = null;

  constructor(
    private readonly limits: ReaderLimits = DEFAULT_LIMITS,
    private readonly log: Logger = noopLogger,
  ) {}

  async list(dir: string): Promise<string[]> {
    const root = resolve(dir);
    const found: string[] = [];
    let visited = 0;
    let cutBy: string | null = null;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > this.limits.maxDepth) {
        cutBy ??= `depth of ${this.limits.maxDepth} directories`;
        return;
      }
      const entries = await entriesOf(root, relative);
      if (entries === null) return;
      for (const entry of entries) {
        if (++visited > this.limits.maxEntries) {
          cutBy ??= `${this.limits.maxEntries} entries`;
          return;
        }
        const path = childPath(relative, entry.name);
        // Dirent reports the link itself, not its target, so a symlink is neither a file nor a directory here.
        if (entry.isFile()) found.push(path);
        else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, depth + 1);
      }
    };
    await walk("", 0);
    // The files left out decide which source is measured, so a cut listing is worth saying once.
    if (cutBy && this.lastCut !== root) {
      this.lastCut = root;
      this.log.warn(
        { dir: root, limit: cutBy, listed: found.length },
        "the file listing stopped at its limit, so some files were left out",
      );
    }
    return found.sort();
  }

  async read(dir: string, path: string, maxBytes: number): Promise<string | null> {
    const root = resolve(dir);
    const full = insideRoot(root, path);
    try {
      if (!(await isPlainFile(root, path))) return null;
      if (!(await resolvesInside(root, full))) return null;
      return await readCapped(full, maxBytes);
    } catch (error) {
      // A file that is not there is null. Any other failure, such as a file this process may not read, rejects as the
      // port says, so a caller never mistakes it for a file that is not there.
      if (isAbsent(error)) return null;
      throw error;
    }
  }
}

/** A backslash separates segments only where it is the platform's separator; elsewhere it is part of a file name. */
const segmentsOf = (path: string): string[] => path.split(sep === "\\" ? /[/\\]/ : "/");

/** The absolute path of `path` under `root`, or `ValidationError` when it is absolute, has `..`, or has a NUL byte. */
function insideRoot(root: string, path: string): string {
  const escapes = isAbsolute(path) || path.includes("\0") || segmentsOf(path).includes("..");
  const full = resolve(root, path);
  if (escapes || !full.startsWith(root + sep)) throw new ValidationError("That path is outside the checkout");
  return full;
}

/** True when the real location of `full`, after any links, is still inside the real root. */
async function resolvesInside(root: string, full: string): Promise<boolean> {
  return (await realpath(full)).startsWith((await realpath(root)) + sep);
}

/**
 * The file's text, or null when it is not a regular file or is larger than `maxBytes`. O_NOFOLLOW closes the gap
 * between the earlier checks and the open; O_NONBLOCK stops a pipe from hanging it.
 */
async function readCapped(full: string, maxBytes: number): Promise<string | null> {
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * True when the path names a regular file and neither it nor any directory above it (inside the clone) is a symbolic
 * link, even one that stays inside. Judging the kind here, before the open, means a socket or a pipe is never opened.
 * A path with no segments names no file, so it is false too.
 */
async function isPlainFile(root: string, path: string): Promise<boolean> {
  let current = root;
  let kind: Stats | null = null;
  for (const part of segmentsOf(path).filter(Boolean)) {
    current = resolve(current, part);
    kind = await lstat(current);
    if (kind.isSymbolicLink()) return false;
  }
  return kind !== null && kind.isFile();
}

/**
 * Failures that mean there is no file to read: it, or a directory above it, is missing (`ENOENT`, `ENOTDIR`), or it
 * became a symbolic link after it was checked, which `O_NOFOLLOW` refuses (`ELOOP`).
 */
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

const isAbsent = (error: unknown): boolean => error instanceof Error && ABSENT.has((error as NodeJS.ErrnoException).code ?? "");
