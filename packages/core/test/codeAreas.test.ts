import { describe, expect, it } from "vitest";
import { areaLocator, areaOf, codeAreas, type CodeArea } from "../src/codeAreas.js";

const paths = (files: string[], layout: Parameters<typeof codeAreas>[1]) =>
  codeAreas(files, layout).areas.map((a) => `${a.kind}:${a.path}`);

describe("codeAreas with declared workspaces", () => {
  const files = [
    "apps/api/src/a.ts",
    "apps/api/test/a.test.ts",
    "apps/web/src/w.tsx",
    "packages/core/src/c.ts",
    "docs/site.js",
    "scripts/build.js",
    "vite.config.ts",
  ];
  const manifests = [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/core/package.json",
    "docs/package.json",
  ];

  it("makes the matching manifests workspaces and groups the rest by top-level folder", () => {
    expect(paths(files, { manifests, workspaces: ["apps/*", "packages/*"] })).toEqual([
      "root:.",
      "workspace:apps/api",
      "workspace:apps/web",
      "folder:docs",
      "workspace:packages/core",
      "folder:scripts",
    ]);
  });

  it("reports the mode as workspace", () => {
    expect(codeAreas(files, { manifests, workspaces: ["apps/*", "packages/*"] }).mode).toBe("workspace");
  });

  it("leaves out a workspace excluded by a negated pattern", () => {
    expect(paths(files, { manifests, workspaces: ["apps/*", "packages/*", "!apps/web"] })).toContain("folder:apps");
    expect(paths(files, { manifests, workspaces: ["apps/*", "packages/*", "!apps/web"] })).not.toContain("workspace:apps/web");
  });

  it("keeps only the outermost of nested directories that a pattern matches", () => {
    const nested = ["packages/core/src/c.ts", "packages/core/fixtures-free/x/y.ts", "packages/ui/src/u.ts"];
    const manifests = [
      "package.json",
      "packages/core/package.json",
      "packages/core/fixtures-free/x/package.json",
      "packages/ui/package.json",
    ];
    expect(paths(nested, { manifests, workspaces: ["packages/**"] })).toEqual([
      "workspace:packages/core",
      "workspace:packages/ui",
    ]);
  });

  it("falls back to the manifests found when no declared pattern matches one", () => {
    expect(paths(files, { manifests, workspaces: ["nothing/*"] })).toContain("workspace:apps/api");
  });
});

describe("codeAreas with several manifests and no declaration", () => {
  const files = ["services/billing/main.go", "services/billing/util/u.go", "services/orders/main.go", "tools/gen/gen.go"];

  it("treats each manifest directory as a workspace, outermost only", () => {
    const manifests = ["go.mod", "services/billing/go.mod", "services/billing/util/go.mod", "services/orders/go.mod"];
    expect(paths(files, { manifests, workspaces: null })).toEqual([
      "workspace:services/billing",
      "workspace:services/orders",
      "folder:tools",
    ]);
  });

  it("uses folder mode when a single manifest sits in a documentation folder", () => {
    const only = ["src/app/a.ts", "src/lib/b.ts", "docs/site/x.js"];
    const result = codeAreas(only, { manifests: ["package.json", "docs/package.json"], workspaces: null });
    expect(result.mode).toBe("folder");
    expect(result.areas.map((a) => a.path)).toEqual(["docs", "src/app", "src/lib"]);
  });

  it("ignores manifests under test and fixture directories, and in folders with no code", () => {
    const manifests = [
      "test/fixtures/app/package.json",
      "fixtures/x/package.json",
      "spec/y/package.json",
      "empty/package.json",
      "real/package.json",
    ];
    const input = [
      "test/fixtures/app/a.ts",
      "fixtures/x/b.ts",
      "spec/y/c.ts",
      "empty/readme.md",
      "real/r.ts",
      "src/a/a.ts",
      "src/b/b.ts",
    ];
    const result = codeAreas(input, { manifests, workspaces: null });
    // Only `real` is a candidate, which is one manifest, so folder mode decides.
    expect(result.mode).toBe("folder");
    expect(result.areas.map((a) => a.path)).toContain("src/a");
  });
});

describe("codeAreas in folder mode", () => {
  const none = { manifests: ["package.json"], workspaces: null };

  it("splits src into its folders and puts what is left beside them", () => {
    const files = ["src/app/a.ts", "src/app/b.ts", "src/lib/c.ts", "src/lib/d.ts", "src/index.ts", "tests/x.test.ts"];
    // Five source files, two in each child, so 2/5 is below 80% and the descent stops at src.
    expect(paths(files, none)).toEqual(["folder:src", "folder:src/app", "folder:src/lib", "folder:tests"]);
  });

  it("descends through a Python package directory", () => {
    const files = [
      "src/widgets/__init__.py",
      "src/widgets/api/a.py",
      "src/widgets/api/b.py",
      "src/widgets/core/c.py",
      "src/widgets/core/d.py",
      "tests/test_a.py",
    ];
    expect(paths(files, none)).toEqual(["folder:src", "folder:src/widgets/api", "folder:src/widgets/core", "folder:tests"]);
  });

  it("descends through a Java source tree", () => {
    const files = [
      "src/main/java/com/acme/web/W.java",
      "src/main/java/com/acme/web/X.java",
      "src/main/java/com/acme/db/D.java",
      "src/main/java/com/acme/db/E.java",
      "src/test/java/com/acme/web/WTest.java",
    ];
    expect(paths(files, none)).toEqual(["folder:src", "folder:src/main/java/com/acme/db", "folder:src/main/java/com/acme/web"]);
  });

  it("descends at exactly 80% of the source and not below it", () => {
    const at = ["src/app/x/a.ts", "src/app/x/b.ts", "src/app/y/c.ts", "src/app/y/d.ts", "src/lib/e.ts"];
    expect(paths(at, none)).toEqual(["folder:src", "folder:src/app/x", "folder:src/app/y"]);
    const under = ["src/app/x/a.ts", "src/app/x/b.ts", "src/app/y/c.ts", "src/lib/e.ts"];
    expect(paths(under, none)).toEqual(["folder:src/app", "folder:src/lib"]);
  });

  it("stops above a folder that has no source folders of its own", () => {
    expect(paths(["src/pkg/a.py", "src/pkg/b.py"], none)).toEqual(["folder:src/pkg"]);
  });

  it("starts at the root when there is no src folder", () => {
    expect(paths(["api/a.ts", "web/b.ts", "web/c.ts", "main.ts"], none)).toEqual(["root:.", "folder:api", "folder:web"]);
  });

  it("returns only the root area for a repository of files at the top", () => {
    expect(paths(["a.ts", "b.ts"], none)).toEqual(["root:."]);
  });

  it("returns nothing for no files", () => {
    expect(codeAreas([], none)).toEqual({ mode: "folder", areas: [] });
  });

  it("does not let fixtures or tests decide where to descend", () => {
    const files = ["src/a/a.ts", "src/b/b.ts", "src/fixtures/x/1.ts", "src/fixtures/x/2.ts", "src/fixtures/x/3.ts"];
    const result = codeAreas(files, none).areas.map((a) => a.path);
    expect(result).toEqual(expect.arrayContaining(["src/a", "src/b"]));
  });

  it("stops descending after ten levels", () => {
    const deep = (n: number) => `${Array.from({ length: n }, (_, i) => `d${i}`).join("/")}/f.ts`;
    // A single chain of 14 directories with a leaf beside the last, so every level holds all the source.
    const files = [deep(14), `${deep(14).replace("/f.ts", "")}/g/h.ts`];
    const result = codeAreas(files, none).areas.map((a) => a.path);
    // Ten descents leave the base at d0/.../d9, so its one child d10 is the area rather than anything deeper.
    expect(result).toEqual(["d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10"]);
  });
});

describe("codeAreas before snapshot version 6", () => {
  it("runs the folder rules over the given paths and says the mode is unknown", () => {
    const result = codeAreas(["apps/api/a.ts", "apps/web/b.ts", "apps/web/c.ts"], null);
    expect(result.mode).toBe("unknown");
    expect(result.areas.map((a) => a.path)).toEqual(["apps/api", "apps/web"]);
  });
});

describe("every file belongs to exactly one area", () => {
  const files = ["apps/api/a.ts", "apps/api/sub/b.ts", "tools/t.ts", "root.ts", "docs/x/y.js", "docs/z.js"];
  const { areas } = codeAreas(files, {
    manifests: ["apps/api/package.json", "apps/api/sub/package.json", "docs/x/package.json"],
    workspaces: null,
  });

  it.each(files)("places %s", (file) => {
    expect(areaOf(file, areas)).not.toBeNull();
  });

  it("chooses the longest matching prefix", () => {
    const nested: CodeArea[] = [
      { path: "apps", kind: "folder" },
      { path: "apps/api", kind: "workspace" },
    ];
    expect(areaOf("apps/api/src/a.ts", nested)).toBe("apps/api");
    expect(areaOf("apps/web/a.ts", nested)).toBe("apps");
    expect(areaOf("apps/apiary/a.ts", nested)).toBe("apps");
  });

  it("gives files at the top to the root area, and returns null when there is none", () => {
    expect(areaLocator([{ path: ".", kind: "root" }])("a.ts")).toBe(".");
    expect(areaLocator([{ path: "apps", kind: "folder" }])("a.ts")).toBeNull();
    expect(areaLocator([{ path: "apps", kind: "folder" }])("libs/a.ts")).toBeNull();
  });
});
