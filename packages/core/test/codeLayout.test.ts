import { describe, expect, it } from "vitest";
import { WORKSPACE_FILES, isManifest, matchesGlob, matchesWorkspaces, workspacePatterns } from "../src/codeLayout.js";

describe("isManifest", () => {
  it.each([
    "package.json",
    "apps/api/package.json",
    "crates/widgets/Cargo.toml",
    "go.mod",
    "svc/pyproject.toml",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "src/Widgets.Api/Widgets.Api.csproj",
    "Lib.fsproj",
    "libs/ui/project.json",
    "composer.json",
    "widgets.gemspec",
    "mix.exs",
    "pubspec.yaml",
    "Package.swift",
    "deno.json",
  ])("recognises %s", (path) => {
    expect(isManifest(path)).toBe(true);
  });

  it.each(["package-lock.json", "README.md", "src/package.json.bak", ".csproj", "tsconfig.json", "src/index.ts", "Cargo.lock"])(
    "does not recognise %s",
    (path) => {
      expect(isManifest(path)).toBe(false);
    },
  );

  it("names the three root files that can declare workspaces", () => {
    expect(WORKSPACE_FILES).toEqual(["package.json", "pnpm-workspace.yaml", "lerna.json"]);
  });
});

describe("workspacePatterns", () => {
  const file = (path: string, content: string) => ({ path, content });

  it("reads an array in package.json", () => {
    const json = JSON.stringify({ name: "widgets", workspaces: ["apps/*", "packages/*"] });
    expect(workspacePatterns([file("package.json", json)])).toEqual(["apps/*", "packages/*"]);
  });

  it("reads the packages of a workspaces object in package.json", () => {
    const json = JSON.stringify({ workspaces: { packages: ["libs/*"], nohoist: ["x"] } });
    expect(workspacePatterns([file("package.json", json)])).toEqual(["libs/*"]);
  });

  it("reads a pnpm block list, with quotes, comments and a negation", () => {
    const yaml = [
      "packages:",
      "  # the apps",
      "  - 'apps/*'",
      '  - "packages/**"  # shared',
      "  - '!**/test/**'",
      "",
      "catalog:",
      "  - nope",
    ].join("\n");
    expect(workspacePatterns([file("pnpm-workspace.yaml", yaml)])).toEqual(["apps/*", "packages/**", "!**/test/**"]);
  });

  it("reads a pnpm flow list on one line and over several", () => {
    expect(workspacePatterns([file("pnpm-workspace.yaml", "packages: ['a/*', \"b/*\"]\n")])).toEqual(["a/*", "b/*"]);
    expect(workspacePatterns([file("pnpm-workspace.yaml", "packages: [\n  a/*,\n  b/*\n]\nother: 1\n")])).toEqual(["a/*", "b/*"]);
  });

  it("reads a pnpm list written with CRLF line endings and no indentation", () => {
    expect(workspacePatterns([file("pnpm-workspace.yaml", "packages:\r\n- a/*\r\n- b/*\r\n")])).toEqual(["a/*", "b/*"]);
  });

  it("reads the packages of lerna.json", () => {
    expect(workspacePatterns([file("lerna.json", JSON.stringify({ packages: ["modules/*"] }))])).toEqual(["modules/*"]);
  });

  it("merges the files and removes repeats", () => {
    const patterns = workspacePatterns([
      file("package.json", JSON.stringify({ workspaces: ["a/*"] })),
      file("lerna.json", JSON.stringify({ packages: ["a/*", "b/*"] })),
    ]);
    expect(patterns).toEqual(["a/*", "b/*"]);
  });

  it("returns null when nothing is declared, whatever the file holds", () => {
    expect(workspacePatterns([])).toBeNull();
    expect(workspacePatterns([file("package.json", JSON.stringify({ name: "x" }))])).toBeNull();
    expect(workspacePatterns([file("package.json", "{ not json")])).toBeNull();
    expect(workspacePatterns([file("package.json", "42")])).toBeNull();
    expect(workspacePatterns([file("package.json", JSON.stringify({ workspaces: [] }))])).toBeNull();
    expect(workspacePatterns([file("pnpm-workspace.yaml", "onlyBuiltDependencies:\n  - esbuild\n")])).toBeNull();
    expect(workspacePatterns([file("packages/a/package.json", JSON.stringify({ workspaces: ["x"] }))])).toBeNull();
  });

  it("ignores entries that are not strings", () => {
    expect(workspacePatterns([file("package.json", JSON.stringify({ workspaces: ["a/*", 3, null, ""] }))])).toEqual(["a/*"]);
  });
});

describe("matchesGlob", () => {
  it.each([
    ["packages/core", "packages/*", true],
    ["packages/core/sub", "packages/*", false],
    ["packages", "packages/*", false],
    ["packages/core/sub", "packages/**", true],
    ["packages", "packages/**", true],
    ["a/b/c/d", "a/**/d", true],
    ["a/d", "a/**/d", true],
    ["a/b/c", "a/**/d", false],
    ["apps/web", "apps/w?b", true],
    ["apps/webs", "apps/w?b", false],
    ["apps/web-admin", "apps/web-*", true],
    ["apps/api", "apps/web-*", false],
    ["apps/api", "./apps/api/", true],
    ["apps/api", "apps/api", true],
    ["apps/api", "apps\\api", true],
    ["apps/api", "**", true],
    ["apps/api", "!apps/api", false],
    ["apps/web", "!apps/api", true],
    ["a/b", "{a,b}/b", false],
  ])("matches %s against %s as %s", (path, pattern, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });

  it("does not take long to refuse a hostile pattern", () => {
    const started = Date.now();
    expect(matchesGlob("a".repeat(60) + "/b", "*a*a*a*a*a*a*a*a*a*a*a*a*c/**/**/**/x")).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("matchesWorkspaces", () => {
  it("needs a positive match and no negation to apply", () => {
    const patterns = ["packages/*", "!packages/legacy"];
    expect(matchesWorkspaces("packages/core", patterns)).toBe(true);
    expect(matchesWorkspaces("packages/legacy", patterns)).toBe(false);
    expect(matchesWorkspaces("apps/web", patterns)).toBe(false);
  });

  it("matches nothing when only negations are given", () => {
    expect(matchesWorkspaces("apps/web", ["!apps/api"])).toBe(false);
  });
});
