/**
 * Reads the packages a lockfile pins, keeping only those it proves came from a public registry. Nothing else is ever
 * looked up outside the repository (ADR 0034). Lockfiles are untrusted text, so every reader is bounded, never throws,
 * and never uses a package name as a key on a plain object (a package called `__proto__` is just a name).
 */
import { baseName, isTestPath } from "./codeTooling.js";
import type { LockedEcosystem, LockedPackage, LockfileSummary } from "./securityTypes.js";

/** The most public packages one lockfile yields. Entries past it are still counted, and the summary says it is capped. */
export const MAX_LOCKED_PACKAGES = 20_000;

const MAX_LINE = 2_000;
const MAX_DEPTH = 64;
const NPM_REGISTRY = "https://registry.npmjs.org/";
const YARN_REGISTRIES = ["https://registry.yarnpkg.com/", NPM_REGISTRY];
const CRATES_REGISTRIES = new Set(["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]);

/** Lockfiles whose registry cannot be proved from their text, so they are recognised but never read. */
const UNSUPPORTED_NAMES = new Set(["pnpm-lock.yaml", "bun.lock", "bun.lockb", "go.sum", "composer.lock"]);

/** Base names of the lockfiles that mark a dependency set as pinned. */
export const LOCKFILE_NAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  ...UNSUPPORTED_NAMES,
];

const LOCKFILE_SET = new Set(LOCKFILE_NAMES);

/** True when the base name is a lockfile, unless it sits under a test directory (a fixture is not the project's own). */
export function isLockfile(path: string): boolean {
  return LOCKFILE_SET.has(baseName(path)) && !isTestPath(path);
}

/**
 * True for a lockfile worth reading, one whose registry can be proved from its text. pnpm, Bun, Go and Composer lockfiles
 * are lockfiles but not these.
 */
export function isReadableLockfile(path: string): boolean {
  return isLockfile(path) && !UNSUPPORTED_NAMES.has(baseName(path));
}

interface Collected {
  packages: LockedPackage[];
  found: number;
  publicPackages: number;
  capped: boolean;
}

const VERSION = /^\d[0-9A-Za-z.+_-]{0,99}$/;
const NAME = /^[^\s\p{Cc}]{1,214}$/u;

/** Gathers one lockfile's entries and its public packages, deduplicated by name and version, capped at the maximum. */
function collector(ecosystem: LockedEcosystem, lockfile: string) {
  const packages: LockedPackage[] = [];
  const seen = new Set<string>();
  let found = 0;
  let publicPackages = 0;
  return {
    /** Counts one entry, public or not. */
    entry: () => void found++,
    /** Records a public package; a name or version that is not plain text is dropped. */
    add(name: unknown, version: unknown): void {
      if (typeof name !== "string" || typeof version !== "string" || !NAME.test(name) || !VERSION.test(version)) return;
      const key = `${name}@${version}`;
      if (seen.has(key)) return;
      seen.add(key);
      publicPackages++;
      if (packages.length < MAX_LOCKED_PACKAGES) packages.push({ ecosystem, name, version, lockfile });
    },
    done: (): Collected => ({ packages, found, publicPackages, capped: publicPackages > packages.length }),
  };
}

type Reader = (path: string, content: string) => Collected | "malformed" | "not_supported";

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);

/** A property of parsed JSON, read only when it is the object's own so an inherited name can never answer. */
const own = (value: object, key: string): unknown =>
  Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

function parseObject(content: string): object | null {
  try {
    const value: unknown = JSON.parse(content);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const linesOf = (content: string): string[] => content.split("\n").map((line) => line.slice(0, MAX_LINE).trimEnd());

// ---- npm ------------------------------------------------------------------------------------------------------------

const readNpm: Reader = (path, content) => {
  const root = parseObject(content);
  if (!root) return "malformed";
  const found = collector("npm", path);
  const flat = own(root, "packages");
  if (isObject(flat)) {
    // Lockfile version 2 and 3: one entry per installed location.
    for (const [key, entry] of Object.entries(flat)) {
      const at = key.lastIndexOf("node_modules/");
      if (at < 0) continue; // the root project and workspace folders
      found.entry();
      if (!isObject(entry) || own(entry, "link") === true || own(entry, "inBundle") === true) continue;
      const resolved = own(entry, "resolved");
      if (typeof resolved !== "string" || !resolved.startsWith(NPM_REGISTRY)) continue;
      const alias = own(entry, "name");
      found.add(typeof alias === "string" && alias ? alias : key.slice(at + "node_modules/".length), own(entry, "version"));
    }
    return found.done();
  }
  const tree = own(root, "dependencies");
  if (!isObject(tree)) return "malformed";
  // Lockfile version 1: nested `dependencies`, walked without recursion so depth cannot overflow the stack.
  const stack: { node: object; depth: number }[] = [{ node: tree, depth: 0 }];
  for (let next = stack.pop(); next; next = stack.pop()) {
    for (const [name, entry] of Object.entries(next.node)) {
      if (!isObject(entry)) continue;
      found.entry();
      const nested = own(entry, "dependencies");
      if (isObject(nested) && next.depth < MAX_DEPTH) stack.push({ node: nested, depth: next.depth + 1 });
      if (own(entry, "bundled") === true || own(entry, "link") === true) continue;
      const resolved = own(entry, "resolved");
      if (typeof resolved !== "string" || !resolved.startsWith(NPM_REGISTRY)) continue;
      found.add(name, own(entry, "version")); // `file:`, `git+` and aliased versions are not plain versions and are dropped
    }
  }
  return found.done();
};

// ---- yarn -----------------------------------------------------------------------------------------------------------

/** The package a yarn v1 entry header names, from its first specifier; null for an alias, whose real name is elsewhere. */
function yarnName(header: string): string | null {
  const first = header
    .slice(0, -1)
    .split(",")[0]!
    .trim()
    .replace(/^["']|["']$/g, "");
  if (first.includes("@npm:")) return null;
  const at = first.lastIndexOf("@");
  return at > 0 ? first.slice(0, at) : null;
}

const readYarn: Reader = (path, content) => {
  const lines = linesOf(content);
  const head = lines.slice(0, 20);
  if (head.some((line) => line.startsWith("__metadata:"))) return "not_supported";
  if (!head.some((line) => line.includes("# yarn lockfile v1"))) return "malformed";
  const found = collector("npm", path);
  let current: { name: string | null; version: string | null; resolved: string | null } | null = null;
  const flush = () => {
    if (!current) return;
    found.entry();
    if (current.resolved && YARN_REGISTRIES.some((registry) => current!.resolved!.startsWith(registry))) {
      found.add(current.name, current.version);
    }
    current = null;
  };
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      flush();
      if (line.endsWith(":")) current = { name: yarnName(line), version: null, resolved: null };
      continue;
    }
    if (!current) continue;
    const version = /^ {2}version\s+"([^"]*)"/.exec(line);
    if (version) current.version = version[1]!;
    const resolved = /^ {2}resolved\s+"([^"]*)"/.exec(line);
    if (resolved) current.resolved = resolved[1]!;
  }
  flush();
  return found.done();
};

// ---- TOML lockfiles: Cargo, Poetry and uv ---------------------------------------------------------------------------

interface TomlPackage {
  name: string | null;
  version: string | null;
  /** The raw value of a `source = ...` key, or null. */
  source: string | null;
  /**
   * True when the package names a source in any form: a `source = ...` key with any value, inline table included,
   * a dotted key such as `source.type = ...`, or its own `[package.source]` table.
   */
  hasSource: boolean;
}

const quoted = (value: string): string | null => /^"([^"]*)"\s*$/.exec(value)?.[1] ?? null;

// TOML allows any key bare, in double quotes or in single quotes, with spaces around the dots of a dotted key.
const PACKAGE = String.raw`(?:package|"package"|'package')`;
const SOURCE = String.raw`(?:source|"source"|'source')`;
/** A key that names the package's source, whether it is set whole (`source =`) or dotted (`source.type =`). */
const SOURCE_KEY = new RegExp(String.raw`^${SOURCE}\s*[.=]`);
/** A table header for the package's source, such as `[package.source]` or `[package."source"]`. */
const SOURCE_TABLE = new RegExp(String.raw`^\[\s*${PACKAGE}\s*\.\s*${SOURCE}\s*[\].]`);
/** A table header inside the current package, such as `[package.dependencies]`, which keeps the package current. */
const PACKAGE_TABLE = new RegExp(String.raw`^\[\[?\s*${PACKAGE}\s*\.`);

/**
 * The `[[package]]` blocks of a lock file. Keys are read only from the package's own table, so a dependency that is
 * itself called `name` or `version` under `[package.dependencies]` cannot be mistaken for the package.
 */
function tomlPackages(content: string): TomlPackage[] | null {
  const lines = linesOf(content);
  if (!lines.some((line) => /^(\[\[package\]\]|\[metadata\]|version\s*=|package\s*=)/.test(line))) return null;
  const packages: TomlPackage[] = [];
  let current: TomlPackage | null = null;
  let inOwnTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inOwnTable = line === "[[package]]";
      if (inOwnTable) {
        current = { name: null, version: null, source: null, hasSource: false };
        packages.push(current);
      } else if (SOURCE_TABLE.test(line) && current) current.hasSource = true;
      else if (!PACKAGE_TABLE.test(line)) current = null;
      continue;
    }
    if (!inOwnTable || !current) continue;
    if (SOURCE_KEY.test(line)) current.hasSource = true;
    const key = /^(name|version|source)\s*=\s*(.*)$/.exec(line);
    if (!key) continue;
    if (key[1] === "name") current.name = quoted(key[2]!);
    else if (key[1] === "version") current.version = quoted(key[2]!);
    else current.source = key[2]!.trim();
  }
  return packages;
}

function readToml(ecosystem: LockedEcosystem, isPublic: (entry: TomlPackage) => boolean): Reader {
  return (path, content) => {
    const entries = tomlPackages(content);
    if (!entries) return "malformed";
    const found = collector(ecosystem, path);
    for (const entry of entries) {
      found.entry();
      if (isPublic(entry)) found.add(entry.name, entry.version);
    }
    return found.done();
  };
}

const readCargo = readToml("crates.io", ({ source }) => {
  const value = source === null ? null : quoted(source);
  return value !== null && CRATES_REGISTRIES.has(value);
});

/**
 * Poetry is the one reader that keeps an entry unless it proves otherwise, because poetry.lock gives a public package
 * no positive signal: a package from PyPI carries no `source`, and only one from a private index, a git URL, a path or
 * an archive names a source (with `type`, `url` and `reference`). Poetry writes that as a `[package.source]` table, but
 * TOML allows the same thing as an inline table (`source = { type = "legacy", ... }`) or as dotted keys
 * (`source.type = "legacy"`), so a package that names a source in any of these forms is private. Since every source
 * but PyPI is written down, nothing Poetry resolved from a private index is sent to OSV by this default.
 */
const readPoetry = readToml("PyPI", ({ hasSource }) => !hasSource);

const readUv = readToml("PyPI", ({ source }) => {
  const registry = source === null ? null : /^\{\s*registry\s*=\s*"([^"]*)"\s*\}$/.exec(source)?.[1];
  return registry === "https://pypi.org/simple";
});

// ---- Pipfile.lock ---------------------------------------------------------------------------------------------------

function hostOf(url: unknown): string | null {
  try {
    return typeof url === "string" ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

const readPipfile: Reader = (path, content) => {
  const root = parseObject(content);
  if (!root) return "malformed";
  const found = collector("PyPI", path);
  const meta = own(root, "_meta");
  const sources = isObject(meta) ? own(meta, "sources") : undefined;
  // Only when every index is PyPI itself can a pinned version be trusted to be PyPI's.
  const allPublic =
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((source) => isObject(source) && hostOf(own(source, "url")) === "pypi.org");
  for (const section of ["default", "develop"]) {
    const entries = own(root, section);
    if (!isObject(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      found.entry();
      const version = isObject(entry) ? own(entry, "version") : undefined;
      if (allPublic && typeof version === "string" && version.startsWith("==")) found.add(name, version.slice(2));
    }
  }
  return found.done();
};

// ---- Gemfile.lock ---------------------------------------------------------------------------------------------------

const readGemfile: Reader = (path, content) => {
  const lines = linesOf(content);
  if (!lines.some((line) => /^(GEM|GIT|PATH|PLATFORMS|DEPENDENCIES|BUNDLED WITH)\b/.test(line))) return "malformed";
  const found = collector("RubyGems", path);
  let section = "";
  let remotes: string[] = [];
  let specs: { name: string; version: string }[] = [];
  const flush = () => {
    if (section === "GEM" && remotes.length > 0 && remotes.every((remote) => remote === "https://rubygems.org/")) {
      for (const spec of specs) found.add(spec.name, spec.version);
    }
    remotes = [];
    specs = [];
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) {
      flush();
      section = line.trim();
      continue;
    }
    const remote = /^ {2}remote:\s*(\S+)/.exec(line);
    if (remote) remotes.push(remote[1]!);
    const spec = /^ {4}(\S+) \(([^)\s]+)\)$/.exec(line);
    if (!spec) continue;
    found.entry();
    // A platform suffix such as `-x86_64-linux` is not part of the version OSV knows.
    specs.push({ name: spec[1]!, version: spec[2]!.split("-")[0]! });
  }
  flush();
  return found.done();
};

// ---------------------------------------------------------------------------------------------------------------------

const READERS = new Map<string, Reader>([
  ["package-lock.json", readNpm],
  ["npm-shrinkwrap.json", readNpm],
  ["yarn.lock", readYarn],
  ["Cargo.lock", readCargo],
  ["poetry.lock", readPoetry],
  ["uv.lock", readUv],
  ["Pipfile.lock", readPipfile],
  ["Gemfile.lock", readGemfile],
]);

/**
 * True when every public package of the lockfile was kept for lookup: it was parsed and not capped. Only such a
 * lockfile can say that an alert it no longer yields is fixed.
 */
export const isLockfileComplete = (summary: LockfileSummary): boolean => summary.read === "parsed" && !summary.capped;

/**
 * The public-registry packages of one lockfile and a summary of how it read. Deduplicated by name and version and
 * capped at `MAX_LOCKED_PACKAGES`. Never throws: anything it cannot understand is `malformed`, and a lockfile whose
 * registry cannot be proved (pnpm, Yarn Berry, Bun, Go, Composer) is `not_supported` with no packages.
 */
export function readLockfile(path: string, content: string): { summary: LockfileSummary; packages: LockedPackage[] } {
  const summarise = (read: LockfileSummary["read"], packages = 0, publicPackages = 0, capped = false): LockfileSummary => ({
    path,
    read,
    packages,
    publicPackages,
    capped,
  });
  const reader = READERS.get(baseName(path));
  if (!reader) return { summary: summarise("not_supported"), packages: [] };
  if (content.trim() === "" || content.includes("\u0000")) return { summary: summarise("malformed"), packages: [] };
  try {
    const result = reader(path, content);
    if (result === "malformed" || result === "not_supported") return { summary: summarise(result), packages: [] };
    return {
      summary: summarise("parsed", result.found, result.publicPackages, result.capped),
      packages: result.packages,
    };
  } catch {
    return { summary: summarise("malformed"), packages: [] };
  }
}
