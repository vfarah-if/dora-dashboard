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
      return { dir, commitSha: stdout.trim(), dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
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
  private async run(args: string[], options: ExecOptions, secrets: string[]) {
    try {
      return await this.exec("git", args, options);
    } catch (error) {
      const failure = error as { stderr?: unknown; killed?: boolean };
      if (failure.killed) {
        throw new UpstreamError(`git was stopped after ${Math.round(options.timeout / 60_000)} minute(s) without finishing`, 504);
      }
      const raw = failure.stderr;
      let detail = (typeof raw === "string" && raw.trim() ? raw.trim() : "git could not be run").slice(0, 500);
      for (const secret of secrets) if (secret) detail = detail.split(secret).join("***");
      if (/not found|could not find remote branch|repository .* does not exist/i.test(detail)) {
        throw new NotFoundError(`The branch or repository could not be cloned: ${detail}`);
      }
      throw new UpstreamError(`git failed: ${detail}`, 502);
    }
  }
}
