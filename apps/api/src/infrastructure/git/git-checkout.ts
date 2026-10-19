import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NotFoundError, UpstreamError } from "../../core/errors.js";
import type { Checkout, SourceCheckout } from "../../interfaces/source-checkout.js";

export interface ExecOptions {
  env: NodeJS.ProcessEnv;
  /** Milliseconds before the process is killed with SIGKILL. */
  timeout: number;
}

export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, options) =>
  promisify(execFile)(file, args, { ...options, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 });

const CLONE_TIMEOUT_MS = 5 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 60_000;
const PREFIX = "dora-checkout-";
/** Paths per `ls-tree`, so the command line stays far below the operating system's limit however many files are asked for. */
const BLOB_BATCH = 100;
/** A regular file's entry from `ls-tree -z`: mode, type, a SHA-1 or SHA-256 object id, a tab and the path. */
const TREE_ENTRY = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/;

/** Refuses local transports and redirects, so a crafted URL or response cannot reach anything but the host. */
const SAFE_CONFIG = ["-c", "protocol.file.allow=never", "-c", "http.followRedirects=false"];

/**
 * Shallow, single-branch clone with the `git` binary. No shell is involved. The token travels only in the child's
 * environment, so it is absent from argv (visible in `ps`), from the URL and from the clone's `.git/config`.
 */
export class GitCheckout implements SourceCheckout {
  constructor(
    private readonly baseUrl = "https://github.com",
    private readonly exec: Exec = defaultExec,
    private readonly tempRoot: string = tmpdir(),
  ) {}

  async headSha(token: string, owner: string, name: string, branch: string): Promise<string> {
    const { env, secrets } = this.authEnv(token);
    const { stdout } = await this.run(
      [...SAFE_CONFIG, "ls-remote", "--", this.url(owner, name), `refs/heads/${branch}`],
      { env, timeout: LS_REMOTE_TIMEOUT_MS },
      secrets,
    );
    const line = stdout.split("\n").find((l) => l.split("\t")[1]?.trim() === `refs/heads/${branch}`);
    const sha = line?.split("\t")[0]?.trim();
    if (!sha) throw new NotFoundError(`The branch ${branch} was not found in ${owner}/${name}`);
    return sha;
  }

  async checkout(token: string, owner: string, name: string, branch: string): Promise<Checkout> {
    const root = await mkdtemp(join(this.tempRoot, PREFIX));
    const dir = join(root, "repo");
    const dispose = () => rm(root, { recursive: true, force: true });
    try {
      const { env, secrets } = this.authEnv(token);
      await this.run(
        [
          ...SAFE_CONFIG,
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          "--branch",
          branch,
          "--",
          this.url(owner, name),
          dir,
        ],
        { env, timeout: CLONE_TIMEOUT_MS },
        secrets,
      );
      const { stdout } = await this.run(
        ["-C", dir, "rev-parse", "HEAD"],
        { env: this.baseEnv(), timeout: LS_REMOTE_TIMEOUT_MS },
        secrets,
      );
      return { dir, commitSha: stdout.trim(), dispose, blobIds: (paths) => this.blobIds(dir, paths) };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /**
   * `git ls-tree` reads tree objects only, so neither this code nor git opens a file's content, and the trees of HEAD are
   * present in a depth 1 clone. `--literal-pathspecs` stops a path being read as a pattern. No token is passed. Only
   * regular files are kept, so a link or a submodule that shares a name is not taken for one.
   */
  private async blobIds(dir: string, paths: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let from = 0; from < paths.length; from += BLOB_BATCH) {
      const batch = paths.slice(from, from + BLOB_BATCH);
      const asked = new Set(batch);
      // `run` reads "not found" in stderr as a missing branch or repository, which this command never means, so a
      // failure here is always an upstream one.
      const { stdout } = await this.run(
        ["--literal-pathspecs", "-C", dir, "ls-tree", "-r", "-z", "HEAD", "--", ...batch],
        { env: this.baseEnv(), timeout: LS_REMOTE_TIMEOUT_MS },
        [],
        "The blob ids of the key files could not be read from the clone",
      );
      for (const entry of stdout.split("\0")) {
        const match = TREE_ENTRY.exec(entry);
        // A path that names a directory would list what is under it, which was not asked for.
        if (match && asked.has(match[3]!)) found.set(match[3]!, match[2]!);
      }
    }
    return found;
  }

  /** Removes checkouts a crash left behind. Call once at start-up, before any checkout is made. */
  async sweepStale(): Promise<number> {
    const stale = (await readdir(this.tempRoot)).filter((entry) => entry.startsWith(PREFIX));
    await Promise.all(stale.map((entry) => rm(join(this.tempRoot, entry), { recursive: true, force: true })));
    return stale.length;
  }

  private url(owner: string, name: string): string {
    return `${this.baseUrl}/${owner}/${name}.git`;
  }

  private baseEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  }

  // ADR 0011: the token stays in the child's environment, never in argv, the URL or .git/config.
  private authEnv(token: string): { env: NodeJS.ProcessEnv; secrets: string[] } {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const env = {
      ...this.baseEnv(),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
    return { env, secrets: [token, basic] };
  }

  /** Errors from `execFile` quote the whole command line, so build our own message with secrets removed. */
  private async run(args: string[], options: ExecOptions, secrets: string[], failure?: string) {
    try {
      return await this.exec("git", args, options);
    } catch (error) {
      const failed = error as { stderr?: unknown; killed?: boolean };
      if (failed.killed) {
        throw new UpstreamError(`git was stopped after ${Math.round(options.timeout / 60_000)} minute(s) without finishing`, 504);
      }
      const raw = failed.stderr;
      let detail = (typeof raw === "string" && raw.trim() ? raw.trim() : "git could not be run").slice(0, 500);
      for (const secret of secrets) if (secret) detail = detail.split(secret).join("***");
      if (failure !== undefined) throw new UpstreamError(`${failure}: ${detail}`, 502);
      if (/not found|could not find remote branch|repository .* does not exist/i.test(detail)) {
        throw new NotFoundError(`The branch or repository could not be cloned: ${detail}`);
      }
      throw new UpstreamError(`git failed: ${detail}`, 502);
    }
  }
}
