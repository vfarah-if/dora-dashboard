import { describe, expect, it } from "vitest";
import { LOCKFILE_NAMES, MAX_LOCKED_PACKAGES, isLockfile, isReadableLockfile, readLockfile } from "../src/lockfiles.js";

const npm = "https://registry.npmjs.org";
const json = (value: unknown) => JSON.stringify(value);

describe("isLockfile", () => {
  it.each([
    "package-lock.json",
    "web/npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "services/api/Pipfile.lock",
    "Gemfile.lock",
    "go.sum",
  ])("recognises %s", (path) => {
    expect(isLockfile(path)).toBe(true);
  });

  it.each(["package.json", "lock.json", "docs/yarn.lock.md", "Cargo.toml", "requirements.txt", "src/package-lock.json.bak"])(
    "does not recognise %s",
    (path) => {
      expect(isLockfile(path)).toBe(false);
    },
  );

  it.each(["test/package-lock.json", "packages/a/__tests__/yarn.lock", "spec/fixtures/Gemfile.lock"])(
    "ignores %s under a test directory",
    (path) => {
      expect(isLockfile(path)).toBe(false);
    },
  );

  it("lists every name it recognises", () => {
    expect(LOCKFILE_NAMES).toContain("pnpm-lock.yaml");
    expect(LOCKFILE_NAMES.every((name) => isLockfile(name))).toBe(true);
  });
});

describe("isReadableLockfile", () => {
  it("excludes the kinds whose registry cannot be proved", () => {
    expect(isReadableLockfile("pnpm-lock.yaml")).toBe(false);
    expect(isReadableLockfile("go.sum")).toBe(false);
    expect(isReadableLockfile("package-lock.json")).toBe(true);
  });
});

describe("readLockfile for package-lock.json", () => {
  const v3 = json({
    lockfileVersion: 3,
    packages: {
      "": { name: "acme-widgets", version: "1.0.0" },
      "node_modules/lodash": { version: "4.17.21", resolved: `${npm}/lodash/-/lodash-4.17.21.tgz` },
      "node_modules/@babel/core": { version: "7.24.0", resolved: `${npm}/@babel/core/-/core-7.24.0.tgz` },
      "node_modules/@babel/core/node_modules/semver": { version: "6.3.1", resolved: `${npm}/semver/-/semver-6.3.1.tgz` },
      "node_modules/@acme/internal": {
        version: "2.0.0",
        resolved: "https://npm.acme.example/@acme/internal/-/internal-2.0.0.tgz",
      },
      "node_modules/acme-widgets": { resolved: "packages/core", link: true },
      "node_modules/bundled-thing": {
        version: "1.0.0",
        inBundle: true,
        resolved: `${npm}/bundled-thing/-/bundled-thing-1.0.0.tgz`,
      },
      "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/acme/from-git.git#abc" },
      "node_modules/sneaky": { version: "1.0.0", resolved: "https://registry.npmjs.org.evil.example/sneaky/-/sneaky-1.0.0.tgz" },
      "packages/core": { name: "@acme/core", version: "1.0.0" },
    },
  });

  it("keeps public registry entries and scoped names whole", () => {
    const { packages } = readLockfile("package-lock.json", v3);
    expect(packages).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.21", lockfile: "package-lock.json" },
      { ecosystem: "npm", name: "@babel/core", version: "7.24.0", lockfile: "package-lock.json" },
      { ecosystem: "npm", name: "semver", version: "6.3.1", lockfile: "package-lock.json" },
    ]);
  });

  it("counts every installed entry but not the root or a workspace folder", () => {
    // lodash, @babel/core, semver, @acme/internal, the link, bundled-thing, from-git and sneaky are eight entries; three are public.
    expect(readLockfile("package-lock.json", v3).summary).toEqual({
      path: "package-lock.json",
      read: "parsed",
      packages: 8,
      publicPackages: 3,
    });
  });

  it("reads the real name of an aliased package", () => {
    const aliased = json({
      packages: {
        "node_modules/my-string-width": {
          name: "string-width",
          version: "4.2.3",
          resolved: `${npm}/string-width/-/string-width-4.2.3.tgz`,
        },
      },
    });
    expect(readLockfile("package-lock.json", aliased).packages.map((p) => p.name)).toEqual(["string-width"]);
  });

  it("deduplicates a package installed at two depths with the same version", () => {
    const twice = json({
      packages: {
        "node_modules/a/node_modules/ms": { version: "2.1.3", resolved: `${npm}/ms/-/ms-2.1.3.tgz` },
        "node_modules/ms": { version: "2.1.3", resolved: `${npm}/ms/-/ms-2.1.3.tgz` },
        "node_modules/b/node_modules/ms": { version: "2.0.0", resolved: `${npm}/ms/-/ms-2.0.0.tgz` },
      },
    });
    const { packages, summary } = readLockfile("package-lock.json", twice);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["ms@2.1.3", "ms@2.0.0"]);
    expect(summary).toMatchObject({ packages: 3, publicPackages: 2 });
  });

  it("reads lockfile version 1 recursively and skips bundled, local and git entries", () => {
    const v1 = json({
      lockfileVersion: 1,
      dependencies: {
        express: {
          version: "4.18.2",
          resolved: `${npm}/express/-/express-4.18.2.tgz`,
          dependencies: { qs: { version: "6.11.0", resolved: `${npm}/qs/-/qs-6.11.0.tgz` } },
        },
        bundled: { version: "1.0.0", bundled: true, resolved: `${npm}/bundled/-/bundled-1.0.0.tgz` },
        local: { version: "file:../local" },
        gitdep: { version: "git+https://github.com/acme/gitdep.git#abc", resolved: "git+https://github.com/acme/gitdep.git#abc" },
        private: { version: "3.0.0", resolved: "https://npm.acme.example/private/-/private-3.0.0.tgz" },
      },
    });
    const { packages, summary } = readLockfile("npm-shrinkwrap.json", v1);
    expect(packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual(["express@4.18.2", "qs@6.11.0"]);
    expect(summary).toMatchObject({ read: "parsed", packages: 6, publicPackages: 2 });
  });

  it("does not follow nested dependencies deeper than its bound", () => {
    let nested: Record<string, unknown> = { leaf: { version: "1.0.0", resolved: `${npm}/leaf/-/leaf-1.0.0.tgz` } };
    for (let i = 0; i < 200; i++)
      nested = { [`p${i}`]: { version: "1.0.0", resolved: `${npm}/p${i}/-/p${i}-1.0.0.tgz`, dependencies: nested } };
    const { packages } = readLockfile("package-lock.json", json({ dependencies: nested }));
    expect(packages.length).toBeLessThan(200);
    expect(packages.length).toBeGreaterThan(50);
  });

  it("treats a package named __proto__ as an ordinary name", () => {
    const text = `{"packages":{"node_modules/__proto__":{"version":"1.0.0","resolved":"${npm}/__proto__/-/__proto__-1.0.0.tgz"}},"__proto__":{"polluted":true}}`;
    const { packages } = readLockfile("package-lock.json", text);
    expect(packages).toEqual([{ ecosystem: "npm", name: "__proto__", version: "1.0.0", lockfile: "package-lock.json" }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not let a __proto__ key stand in for a missing packages section", () => {
    const { summary } = readLockfile("package-lock.json", '{"__proto__":{"packages":{}}}');
    expect(summary.read).toBe("malformed");
  });

  it("drops entries whose version is not plain text", () => {
    const odd = json({
      packages: {
        "node_modules/a": { version: "npm:b@1.0.0", resolved: `${npm}/b/-/b-1.0.0.tgz` },
        "node_modules/c": { version: 5, resolved: `${npm}/c/-/c-5.tgz` },
        "node_modules/d": { resolved: `${npm}/d/-/d-1.tgz` },
        "node_modules/e": "not an object",
      },
    });
    const { packages, summary } = readLockfile("package-lock.json", odd);
    expect(packages).toEqual([]);
    expect(summary).toMatchObject({ read: "parsed", packages: 4, publicPackages: 0 });
  });

  it("stops at the package cap but still counts the rest", () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < MAX_LOCKED_PACKAGES + 5; i++)
      entries[`node_modules/p${i}`] = { version: "1.0.0", resolved: `${npm}/p${i}/-/p${i}-1.0.0.tgz` };
    const { packages, summary } = readLockfile("package-lock.json", json({ packages: entries }));
    expect(packages).toHaveLength(MAX_LOCKED_PACKAGES);
    expect(summary).toMatchObject({ packages: MAX_LOCKED_PACKAGES + 5, publicPackages: MAX_LOCKED_PACKAGES + 5 });
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["an object with no dependency section", "{}"],
    ["an empty file", ""],
    ["a file of whitespace", "  \n"],
    ["a binary file", '{"packages":{}}\u0000'],
  ])("reports %s as malformed", (_, content) => {
    const { summary, packages } = readLockfile("package-lock.json", content);
    expect(summary).toEqual({ path: "package-lock.json", read: "malformed", packages: 0, publicPackages: 0 });
    expect(packages).toEqual([]);
  });
});

describe("readLockfile for yarn.lock", () => {
  const v1 = [
    "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    "# yarn lockfile v1",
    "",
    "",
    '"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":',
    '  version "7.12.13"',
    '  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#abc"',
    "  dependencies:",
    '    "@babel/highlight" "^7.12.13"',
    "",
    "lodash@^4.17.21:",
    '  version "4.17.21"',
    '  resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz#def"',
    "",
    '"@acme/private@^1.0.0":',
    '  version "1.0.0"',
    '  resolved "https://npm.acme.example/@acme/private/-/private-1.0.0.tgz"',
    "",
    '"string-width-cjs@npm:string-width@^4.2.0":',
    '  version "4.2.3"',
    '  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz"',
    "",
    "from-git@acme/from-git:",
    '  version "1.0.0"',
    '  resolved "git+https://github.com/acme/from-git.git#abc"',
    "",
  ].join("\n");

  it("keeps entries resolved on either public registry, with scoped names whole", () => {
    const { packages, summary } = readLockfile("yarn.lock", v1);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["@babel/code-frame@7.12.13", "lodash@4.17.21"]);
    expect(summary).toEqual({ path: "yarn.lock", read: "parsed", packages: 5, publicPackages: 2 });
  });

  it("reads Windows line endings", () => {
    expect(readLockfile("yarn.lock", v1.replace(/\n/g, "\r\n")).packages).toHaveLength(2);
  });

  it("answers not_supported for Yarn Berry", () => {
    const berry =
      '# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n\n"lodash@npm:^4.17.21":\n  version: 4.17.21\n';
    expect(readLockfile("yarn.lock", berry)).toEqual({
      summary: { path: "yarn.lock", read: "not_supported", packages: 0, publicPackages: 0 },
      packages: [],
    });
  });

  it("reports a file with neither marker as malformed", () => {
    expect(readLockfile("yarn.lock", "lodash@^4:\n  version 1\n").summary.read).toBe("malformed");
  });
});

describe("readLockfile for Cargo.lock", () => {
  const cargo = [
    "# This file is automatically @generated by Cargo.",
    "version = 3",
    "",
    "[[package]]",
    'name = "acme-widgets"',
    'version = "0.1.0"',
    "dependencies = [",
    ' "serde",',
    "]",
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.197"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "abc"',
    "",
    "[[package]]",
    'name = "tokio"',
    'version = "1.36.0"',
    'source = "sparse+https://index.crates.io/"',
    "",
    "[[package]]",
    'name = "internal"',
    'version = "0.3.0"',
    'source = "registry+https://crates.acme.example/index"',
    "",
    "[[package]]",
    'name = "from-git"',
    'version = "0.1.0"',
    'source = "git+https://github.com/acme/from-git#abc"',
    "",
    "[metadata]",
    'name = "not a package"',
  ].join("\n");

  it("keeps crates.io sources and never sends a workspace crate or other registry", () => {
    const { packages, summary } = readLockfile("Cargo.lock", cargo);
    expect(packages).toEqual([
      { ecosystem: "crates.io", name: "serde", version: "1.0.197", lockfile: "Cargo.lock" },
      { ecosystem: "crates.io", name: "tokio", version: "1.36.0", lockfile: "Cargo.lock" },
    ]);
    expect(summary).toMatchObject({ packages: 5, publicPackages: 2 });
  });

  it("reports text with no package tables as malformed", () => {
    expect(readLockfile("Cargo.lock", "just some words").summary.read).toBe("malformed");
  });
});

describe("readLockfile for poetry.lock", () => {
  const poetry = [
    "[[package]]",
    'name = "requests"',
    'version = "2.31.0"',
    'description = "Python HTTP for Humans."',
    "",
    "[package.dependencies]",
    'name = ">=1"',
    'version = ">=2"',
    "",
    "[[package]]",
    'name = "acme-internal"',
    'version = "1.2.0"',
    "",
    "[package.source]",
    'type = "legacy"',
    'url = "https://pypi.acme.example/simple"',
    "",
    "[[package]]",
    'name = "urllib3"',
    'version = "2.2.1"',
    "",
    "[metadata]",
    'lock-version = "2.0"',
  ].join("\n");

  it("keeps a PyPI package, which has no positive signal in poetry.lock, and drops every package with a source table", () => {
    // Poetry writes `[package.source]` for a private index, a git URL, a path or an archive, and nothing for PyPI.
    const lock = [
      "[[package]]",
      'name = "requests"',
      'version = "2.31.0"',
      "",
      "[[package]]",
      'name = "private-lib"',
      'version = "1.0.0"',
      "",
      "[package.source]",
      'type = "legacy"',
      'url = "https://pypi.acme.example/simple"',
      'reference = "acme"',
      "",
      "[[package]]",
      'name = "from-git"',
      'version = "0.3.0"',
      "",
      "[package.source]",
      'type = "git"',
      'url = "https://git.acme.example/widgets/from-git.git"',
      'reference = "main"',
      'resolved_reference = "0123456789abcdef0123456789abcdef01234567"',
      "",
      "[[package]]",
      'name = "local-lib"',
      'version = "0.1.0"',
      "",
      "[package.source]",
      'type = "directory"',
      'url = "../local-lib"',
      "",
      "[metadata]",
      'lock-version = "2.0"',
    ].join("\n");
    const { packages, summary } = readLockfile("poetry.lock", lock);
    expect(packages.map((p) => p.name)).toEqual(["requests"]);
    expect(summary).toMatchObject({ packages: 4, publicPackages: 1 });
  });

  it("keeps packages with no source table and ignores keys of sub tables", () => {
    const { packages, summary } = readLockfile("poetry.lock", poetry);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["requests@2.31.0", "urllib3@2.2.1"]);
    expect(packages[0]!.ecosystem).toBe("PyPI");
    expect(summary).toMatchObject({ packages: 3, publicPackages: 2 });
  });
});

describe("readLockfile for uv.lock", () => {
  const uv = [
    "version = 1",
    "",
    "[[package]]",
    'name = "certifi"',
    'version = "2024.2.2"',
    'source = { registry = "https://pypi.org/simple" }',
    "dependencies = [",
    '    { name = "idna" },',
    "]",
    "",
    "[[package]]",
    'name = "acme-internal"',
    'version = "1.0.0"',
    'source = { registry = "https://pypi.acme.example/simple" }',
    "",
    "[[package]]",
    'name = "acme-widgets"',
    'version = "0.1.0"',
    'source = { virtual = "." }',
  ].join("\n");

  it("keeps only the pypi.org registry", () => {
    const { packages, summary } = readLockfile("uv.lock", uv);
    expect(packages).toEqual([{ ecosystem: "PyPI", name: "certifi", version: "2024.2.2", lockfile: "uv.lock" }]);
    expect(summary).toMatchObject({ packages: 3, publicPackages: 1 });
  });
});

describe("readLockfile for Pipfile.lock", () => {
  const pipfile = (sources: unknown) =>
    json({
      _meta: { sources },
      default: { requests: { version: "==2.31.0" }, local: { path: "." }, loose: { version: ">=1.0" } },
      develop: { pytest: { version: "==8.1.1" } },
    });

  it("keeps pinned versions of default and develop when every source is pypi.org", () => {
    const { packages, summary } = readLockfile("Pipfile.lock", pipfile([{ url: "https://pypi.org/simple", name: "pypi" }]));
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["requests@2.31.0", "pytest@8.1.1"]);
    expect(summary).toMatchObject({ packages: 4, publicPackages: 2 });
  });

  it("keeps nothing when any source is another host", () => {
    const sources = [{ url: "https://pypi.org/simple" }, { url: "https://pypi.acme.example/simple" }];
    expect(readLockfile("Pipfile.lock", pipfile(sources)).packages).toEqual([]);
  });

  it.each([
    ["no sources", undefined],
    ["an empty source list", []],
    ["a source without a url", [{ name: "pypi" }]],
    ["an unparseable url", [{ url: "not a url" }]],
  ])("keeps nothing for %s", (_, sources) => {
    expect(readLockfile("Pipfile.lock", pipfile(sources)).packages).toEqual([]);
  });

  it("reports invalid json as malformed", () => {
    expect(readLockfile("Pipfile.lock", "{").summary.read).toBe("malformed");
  });
});

describe("readLockfile for Gemfile.lock", () => {
  const gemfile = [
    "GIT",
    "  remote: https://github.com/acme/forked.git",
    "  revision: abc",
    "  specs:",
    "    forked (1.0.0)",
    "",
    "GEM",
    "  remote: https://rubygems.org/",
    "  specs:",
    "    nokogiri (1.16.2-x86_64-linux)",
    "      racc (~> 1.4)",
    "    rake (13.1.0)",
    "",
    "GEM",
    "  remote: https://gems.acme.example/",
    "  specs:",
    "    acme-gem (2.0.0)",
    "",
    "PATH",
    "  remote: .",
    "  specs:",
    "    acme-widgets (0.1.0)",
    "",
    "PLATFORMS",
    "  ruby",
    "",
    "BUNDLED WITH",
    "   2.5.6",
  ].join("\n");

  it("keeps specs of a rubygems.org GEM block and strips a platform suffix", () => {
    const { packages, summary } = readLockfile("Gemfile.lock", gemfile);
    expect(packages).toEqual([
      { ecosystem: "RubyGems", name: "nokogiri", version: "1.16.2", lockfile: "Gemfile.lock" },
      { ecosystem: "RubyGems", name: "rake", version: "13.1.0", lockfile: "Gemfile.lock" },
    ]);
    expect(summary).toMatchObject({ packages: 5, publicPackages: 2 });
  });

  it("keeps nothing from a GEM block that also names another remote", () => {
    const mixed = "GEM\n  remote: https://rubygems.org/\n  remote: https://gems.acme.example/\n  specs:\n    rake (13.1.0)\n";
    expect(readLockfile("Gemfile.lock", mixed).packages).toEqual([]);
  });

  it("reports text with no section as malformed", () => {
    expect(readLockfile("Gemfile.lock", "hello").summary.read).toBe("malformed");
  });
});

describe("readLockfile for lockfiles it cannot prove", () => {
  it.each(["pnpm-lock.yaml", "go.sum", "bun.lockb", "composer.lock", "deep/pnpm-lock.yaml"])(
    "answers not_supported for %s",
    (path) => {
      expect(readLockfile(path, "lockfileVersion: '9.0'\n")).toEqual({
        summary: { path, read: "not_supported", packages: 0, publicPackages: 0 },
        packages: [],
      });
    },
  );

  it("answers not_supported for a file that is not a lockfile at all", () => {
    expect(readLockfile("README.md", "# hello").summary.read).toBe("not_supported");
  });
});

describe("readLockfile never throws", () => {
  it.each(LOCKFILE_NAMES)("returns a summary for hostile %s content", (name) => {
    for (const content of ["\u0000\u0001", "[[package]]\nname", "{".repeat(5000), "x".repeat(10_000)]) {
      expect(() => readLockfile(name, content)).not.toThrow();
    }
  });
});
