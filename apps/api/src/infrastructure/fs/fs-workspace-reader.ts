import { constants } from "node:fs";
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
      let entries;
      try {
        entries = await readdir(relative ? resolve(root, relative) : root, { withFileTypes: true });
      } catch {
        return; // An unreadable directory costs its own files, not the whole listing.
      }
      for (const entry of entries) {
        if (++visited > this.limits.maxEntries) {
          cutBy ??= `${this.limits.maxEntries} entries`;
          return;
        }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
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
      if (await hasLinkOnTheWay(root, path)) return null;
      if (!(await resolvesInside(root, full))) return null;
      return await readCapped(full, maxBytes);
    } catch {
      return null;
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

/** True when the file or any directory above it (inside the clone) is a symbolic link, even one that stays inside. */
async function hasLinkOnTheWay(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const part of segmentsOf(path).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}
