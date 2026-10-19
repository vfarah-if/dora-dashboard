import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, UpstreamError } from "../src/core/errors.js";
import { GitCheckout, type Exec, type ExecOptions } from "../src/infrastructure/git/git-checkout.js";

const TOKEN = "ghs_secret_token_value";
const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef".repeat(4);

/** One `ls-tree -z` entry: mode, type, id, a tab, the path and a NUL. */
const entry = (mode: string, type: string, id: string, path: string) => `${mode} ${type} ${id}\t${path}\0`;

describe("GitCheckout.blobIds", () => {
  const calls: { args: string[]; options: ExecOptions }[] = [];
  const roots: string[] = [];
  let tree = (_paths: string[]): string => "";
  let failure: unknown = null;

  /** Answers `rev-parse` with a commit and `ls-tree` with whatever `tree` says for the paths asked. */
  const exec: Exec = async (_file, args, options) => {
    calls.push({ args, options });
    if (failure) throw failure;
    if (args.includes("rev-parse")) return { stdout: "deadbeef\n", stderr: "" };
    if (args.includes("ls-tree")) return { stdout: tree(args.slice(args.indexOf("--") + 1)), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const checkout = async () => {
    const root = mkdtempSync(join(tmpdir(), "dora-test-"));
    roots.push(root);
    const clone = await new GitCheckout("https://github.com", exec, root).checkout(TOKEN, "acme", "widgets", "main");
    calls.length = 0;
    return clone;
  };

  afterEach(() => {
    calls.length = 0;
    failure = null;
    tree = () => "";
    roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
  });

  it("runs ls-tree on HEAD with literal pathspecs, the paths after a double dash and no token anywhere", async () => {
    tree = () => entry("100644", "blob", SHA1, ".env");
    const clone = await checkout();

    const found = await clone.blobIds([".env", "api/Dockerfile"]);

    expect(found).toEqual(new Map([[".env", SHA1]]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "--literal-pathspecs",
      "-C",
      clone.dir,
      "ls-tree",
      "-r",
      "-z",
      "HEAD",
      "--",
      ".env",
      "api/Dockerfile",
    ]);
    expect(calls[0]!.options.timeout).toBe(60_000);
    expect(calls[0]!.options.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
    for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
      expect(calls[0]!.options.env[key]).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain(TOKEN);
  });

  it("never reads a file: the only git commands are ls-tree and the ones that made the checkout", async () => {
    const clone = await checkout();
    await clone.blobIds([".env"]);
    expect(calls.map((c) => c.args.find((a) => ["ls-tree", "cat-file", "show", "archive", "checkout"].includes(a)))).toEqual([
      "ls-tree",
    ]);
  });

  it("asks in batches of 100 paths and joins the answers", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `d${i}/.env`);
    tree = (asked) =>
      asked.map((path, i) => entry("100644", "blob", SHA1.slice(0, 38) + String(i % 10).padStart(2, "0"), path)).join("");
    const clone = await checkout();

    const found = await clone.blobIds(paths);

    expect(calls.map((c) => c.args.length - 8)).toEqual([100, 100, 50]);
    expect(found.size).toBe(250);
    expect(found.get("d0/.env")).toBe(`${SHA1.slice(0, 38)}00`);
    expect(found.get("d249/.env")).toBe(`${SHA1.slice(0, 38)}09`);
  });

  it("asks nothing for no paths", async () => {
    const clone = await checkout();
    expect(await clone.blobIds([])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("keeps regular files of either mode and skips links, submodules, trees and anything not a blob id", async () => {
    tree = () =>
      [
        entry("100644", "blob", SHA1, "a.pem"),
        entry("100755", "blob", SHA1, "b.key"),
        entry("120000", "blob", SHA1, "link.pem"),
        entry("160000", "commit", SHA1, "vendor"),
        entry("040000", "tree", SHA1, "dir"),
        entry("100644", "blob", "abc123", "short.pem"),
        entry("100644", "blob", SHA1.toUpperCase(), "upper.pem"),
        "garbage without a tab\0",
        "",
      ].join("");
    const clone = await checkout();

    const found = await clone.blobIds(["a.pem", "b.key", "link.pem", "vendor", "dir", "short.pem", "upper.pem"]);

    expect([...found]).toEqual([
      ["a.pem", SHA1],
      ["b.key", SHA1],
    ]);
  });

  it("accepts a SHA-256 object id", async () => {
    tree = () => entry("100644", "blob", SHA256, "id_rsa");
    const clone = await checkout();
    expect(await clone.blobIds(["id_rsa"])).toEqual(new Map([["id_rsa", SHA256]]));
  });

  it("keeps a path with a space, a newline or a quote exactly, which -z leaves unquoted", async () => {
    const odd = ["my keys/id rsa", 'say "hi".pem', "line\nbreak.pem"];
    tree = () => odd.map((path) => entry("100644", "blob", SHA1, path)).join("");
    const clone = await checkout();
    expect([...(await clone.blobIds(odd)).keys()]).toEqual(odd);
  });

  it("leaves out an entry for a path that was not asked, such as what lies under a directory", async () => {
    tree = () => entry("100644", "blob", SHA1, "asked.pem") + entry("100644", "blob", SHA1, "asked/under.pem");
    const clone = await checkout();
    expect([...(await clone.blobIds(["asked.pem"])).keys()]).toEqual(["asked.pem"]);
  });

  it("raises an UpstreamError, naming no token, when git fails, so the caller can save the facts without ids", async () => {
    const clone = await checkout();
    failure = Object.assign(new Error(`Command failed: git ${TOKEN}`), { stderr: "fatal: not a tree object" });

    const error = await clone.blobIds([".env"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).toContain("not a tree object");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("gives a failure its own message, and not the clone's, even when git says something was not found", async () => {
    const clone = await checkout();
    failure = Object.assign(new Error("Command failed"), { stderr: "fatal: path 'x' not found in the tree" });

    const error = await clone.blobIds([".env"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toMatch(/^The blob ids of the key files could not be read from the clone/);
    expect((error as Error).message).toContain("not found in the tree");
  });
});
