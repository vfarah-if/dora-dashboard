/**
 * Turns OSV.dev's answers about locked dependencies into the same alert shape Dependabot's alerts have, and keeps their
 * history between crawls (ADR 0034). OSV has no alert of its own, so "opened" is the crawl that first found a finding
 * and "closed" the crawl that no longer did. Pure: the caller supplies the answers and the time.
 */
import { worseSeverity } from "./securityAlerts.js";
import { compareText } from "./stats.js";
import { compareVersions } from "./versions.js";
import type { LockedPackage, OsvAlert, Severity, SupplyChainFacts, Vulnerability } from "./securityTypes.js";

const lowest = (ids: readonly string[]): string => ids.reduce((a, b) => (b < a ? b : a));

/** Records that name the same advisory, directly or through aliases, are one group. */
function groupByAlias(vulnerabilities: readonly Vulnerability[]): { ids: Set<string>; records: Vulnerability[] }[] {
  const groups: { ids: Set<string>; records: Vulnerability[] }[] = [];
  for (const record of vulnerabilities) {
    const ids = [record.id, ...record.aliases];
    const joined = { ids: new Set(ids), records: [record] };
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      if (ids.some((id) => group.ids.has(id))) {
        group.ids.forEach((id) => joined.ids.add(id));
        joined.records = [...group.records, ...joined.records];
        groups.splice(i, 1);
      }
    }
    groups.push(joined);
  }
  return groups;
}

/**
 * The worst severity among the records that publish one, else unknown. An alias record that publishes none, such as a
 * PYSEC or RUSTSEC twin of a GitHub advisory, says nothing about the advisory, so it must not raise a low one to
 * unknown, which `SEVERITY_RANK` puts above low.
 */
function worst(severities: readonly Severity[]): Severity {
  const published: Severity[] = severities.filter((severity) => severity !== "unknown");
  return published.length === 0 ? "unknown" : published.reduce(worseSeverity);
}

/** A version's leading dotted release, what kind of version follows from the rest, and the rest itself. */
type Placed = { release: string; kind: "release" | "after" | "pre"; suffix: string };

/**
 * Where a version sits, from its leading dotted release, such as `2.0.0` in `2.0.0rc1`, `2.0.0-beta.1` or `7.1.0.rc1`,
 * and what follows it. `release` is a plain release. `after` sorts after its release but does not fix it, which covers
 * semver build metadata and a PEP 440 local version after `+`, and a PEP 440 post-release such as `.post1`. `pre` is
 * every other suffix, a pre-release in every ecosystem looked up, such as `-rc.1`, `rc1`, `.dev0`, `a1` and RubyGems'
 * `.rc1`. Null when the version has no release that compares, such as `nightly`.
 */
function placeOf(version: string): Placed | null {
  const trimmed = version.trim();
  const release = /^v?\d+(?:\.\d+)*/.exec(trimmed)?.[0];
  if (release === undefined || compareVersions(release, release) === null) return null;
  const suffix = trimmed.slice(release.length);
  if (suffix === "") return { release, kind: "release", suffix };
  return { release, kind: /^(?:\+|\.?post)/i.test(suffix) ? "after" : "pre", suffix };
}

/** How PEP 440 orders the words of a pre-release; semver's `alpha`, `beta` and `rc` fall in the same order. */
const PRE_WORD: Record<string, number> = { dev: 0, a: 1, alpha: 1, b: 2, beta: 2, c: 3, pre: 3, preview: 3, rc: 3 };

/**
 * How two pre-release suffixes of one release compare, such as `-beta.5` and `-rc.2`, or `rc1` and `.dev0`, word by
 * word and number by number, with a missing number read as 0. Null when they cannot be ordered, such as two words that
 * are not in `PRE_WORD`, or a word against a number.
 */
function comparePre(a: string, b: string): number | null {
  const parts = (suffix: string) => suffix.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0";
    const y = right[i] ?? "0";
    if (x === y) continue;
    const xNumber = /^\d/.test(x);
    if (xNumber !== /^\d/.test(y)) return null;
    if (xNumber) return Math.sign(Number(x) - Number(y));
    const xWord = PRE_WORD[x];
    const yWord = PRE_WORD[y];
    if (xWord === undefined || yWord === undefined || xWord === yWord) return null;
    return Math.sign(xWord - yWord);
  }
  return 0;
}

/**
 * How two versions order: by their releases where both can be placed, then a pre-release before any other version of
 * its release, then two pre-releases by `comparePre`, and in text order wherever that leaves a tie.
 */
function byPlace(a: string, b: string): number {
  const x = placeOf(a);
  const y = placeOf(b);
  if (x === null || y === null) return compareText(a, b);
  const byRelease = compareVersions(x.release, y.release)!;
  if (byRelease !== 0) return byRelease;
  if (x.kind === "pre" && y.kind !== "pre") return -1;
  if (y.kind === "pre" && x.kind !== "pre") return 1;
  const byPre = x.kind === "pre" ? (comparePre(x.suffix, y.suffix) ?? 0) : 0;
  return byPre || compareText(a, b);
}

/** The lowest of the versions, by their releases where those compare, then by pre-release, then in text order. */
const lowestVersion = (versions: readonly string[]): string | null => [...versions].sort(byPlace)[0] ?? null;

/**
 * The lowest fixed version above the locked one, never one below it. A version is placed by its leading release
 * whatever follows it, so `2.0.0rc1` and `7.1.0.rc1` are pre-releases of `2.0.0` and `7.1.0`.
 *
 * - A plain release, or one that sorts after its release (`2.0.0+build.5`, `2023.3.post1`), takes the lowest release
 *   strictly above its own. A pre-release fix is not offered, as nothing shows how it compares, and nothing is offered
 *   when no release qualifies.
 * - A pre-release is below its own release, so for `2.0.0-beta.1` the release `2.0.0` counts as a fix, and a release
 *   below `2.0.0`, such as a backport to an older line, never does. When no release fixes it, a pre-release fix is
 *   offered when its release is above the locked one's, or when it is a later pre-release of the same release, such as
 *   `1.0.0-rc.1` for `1.0.0-beta`, since dropping it would advise replacing a package that can be upgraded.
 * - A locked version that cannot be placed at all, such as `nightly`, is offered the lowest fix, by release and then in
 *   text order.
 */
function patchedAbove(locked: string, fixed: readonly string[]): string | null {
  const place = placeOf(locked);
  if (place === null) return lowestVersion(fixed);
  const releases = fixed.filter((version) => {
    const order = compareVersions(version, place.release);
    return order !== null && order >= (place.kind === "pre" ? 0 : 1);
  });
  if (releases.length > 0 || place.kind !== "pre") return lowestVersion(releases);
  return lowestVersion(
    fixed.filter((version) => {
      const fix = placeOf(version);
      if (fix === null || fix.kind !== "pre") return false;
      const order = compareVersions(fix.release, place.release)!;
      return order > 0 || (order === 0 && (comparePre(fix.suffix, place.suffix) ?? 0) > 0);
    }),
  );
}

/**
 * The identity of a locked package in one lockfile, as OSV alerts name it: the version is left out, because an alert's
 * key does not name it either. Used to say which packages a lookup answered.
 */
export const osvPackageKey = (pkg: Pick<LockedPackage, "ecosystem" | "name" | "lockfile">): string =>
  JSON.stringify([pkg.ecosystem, pkg.name, pkg.lockfile]);

/**
 * One alert per advisory per package. `results[i]` holds the vulnerabilities found for `packages[i]`, or null when the
 * package was not answered in full, which yields nothing for it. Each advisory and its aliases form one finding, named
 * by its GHSA id when there is one and otherwise by the lowest id. The same advisory on two versions of one package in
 * one lockfile is a single alert, since the key does not name the version.
 */
export function osvFindings(
  packages: readonly LockedPackage[],
  results: readonly (readonly Vulnerability[] | null)[],
  now: string,
): OsvAlert[] {
  const alerts = new Map<string, OsvAlert>();
  packages.forEach((pkg, i) => {
    for (const group of groupByAlias(results[i] ?? [])) {
      const ids = [...group.ids];
      const ghsa = ids.filter((id) => id.startsWith("GHSA-"));
      const id = lowest(ghsa.length > 0 ? ghsa : ids);
      const key = `${id}|${pkg.ecosystem}|${pkg.name}|${pkg.lockfile}`;
      if (alerts.has(key)) continue;
      const cves = ids.filter((alias) => alias.startsWith("CVE-"));
      const titled = group.records.find((record) => record.id === id && record.summary) ?? group.records.find((r) => r.summary);
      alerts.set(key, {
        key,
        source: "osv",
        state: "open",
        createdAt: now,
        closedAt: null,
        closeReason: null,
        title: titled?.summary ?? id,
        url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
        severity: worst(group.records.map((record) => record.severity)),
        dependency: {
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          manifestPath: pkg.lockfile,
          scope: null,
          relationship: null,
          lockedVersion: pkg.version,
          patchedVersion: patchedAbove(
            pkg.version,
            group.records.flatMap((record) => record.fixedVersions),
          ),
          vulnerableRange: null,
          advisoryId: id,
          cveId: cves.length > 0 ? lowest(cves) : null,
          epss: null,
          cvssScore: null,
          cwes: [],
        },
      });
    }
  });
  return [...alerts.values()];
}

/** What one crawl's lookup covered, so `reconcileOsvAlerts` closes only what it could have found again. */
export interface OsvCoverage {
  now: string;
  /** Lockfiles read in full this time: parsed, and not capped (see `isLockfileComplete`). */
  lockfilesRead: ReadonlySet<string>;
  /**
   * Every lockfile in the latest supply chain record, read or not, or null when that record's listing of the clone
   * stopped short, so no lockfile can be shown to be gone. `presentLockfiles` gives the right value for a record.
   */
  lockfilesPresent: ReadonlySet<string> | null;
  /**
   * Packages, by `osvPackageKey`, that a lockfile holds but that were not looked up or not answered in full this time:
   * withheld because their scope may name a private registry, past the lookup's package cap, or cut short by the
   * database. Their alerts are left as they were.
   */
  unanswered: ReadonlySet<string>;
}

/** The lockfiles a supply chain record shows to exist, or null when its listing of the clone stopped short. */
export function presentLockfiles(facts: Pick<SupplyChainFacts, "lockfiles" | "listingComplete">): ReadonlySet<string> | null {
  return facts.listingComplete ? new Set(facts.lockfiles.map((lockfile) => lockfile.path)) : null;
}

/**
 * The full set of OSV alerts after a crawl. A finding seen again keeps the `createdAt` of its first sighting while it
 * stays open. A fixed one that returns is open again with `createdAt` set to the reopen time: an alert has no field for
 * the gap, so keeping the first sighting would make the weekly replay show it open through the weeks it was fixed, and a
 * returning vulnerability starts its fix-by clock again. A stored open alert that is not found is closed as `not_found`
 * when its lockfile no longer exists (deleted or renamed, so nothing can find it again), or when its lockfile was read
 * in full this time and its package was either answered or is no longer in it. A lockfile that exists but was not read
 * in full says nothing, and nor does a package that was not answered, so their alerts are kept. When the listing of the
 * clone stopped short, a lockfile it does not hold may still exist, so only a lockfile that was listed and read in full
 * can close an alert.
 */
export function reconcileOsvAlerts(stored: readonly OsvAlert[], found: readonly OsvAlert[], at: OsvCoverage): OsvAlert[] {
  const current = new Map<string, OsvAlert>();
  for (const alert of found) if (!current.has(alert.key)) current.set(alert.key, alert);
  const kept = new Set<string>();
  const result: OsvAlert[] = [];
  const closes = ({ dependency: { ecosystem, name, manifestPath } }: OsvAlert) =>
    (at.lockfilesPresent !== null && !at.lockfilesPresent.has(manifestPath)) ||
    (at.lockfilesRead.has(manifestPath) && !at.unanswered.has(osvPackageKey({ ecosystem, name, lockfile: manifestPath })));
  for (const old of stored) {
    const again = current.get(old.key);
    if (again) {
      kept.add(old.key);
      result.push({
        ...again,
        dependency: { ...again.dependency },
        createdAt: old.state === "open" ? old.createdAt : at.now,
        state: "open",
        closedAt: null,
        closeReason: null,
      });
    } else if (old.state === "open" && closes(old)) {
      result.push({ ...old, state: "fixed", closedAt: at.now, closeReason: "not_found" });
    } else {
      result.push(old);
    }
  }
  for (const alert of current.values()) if (!kept.has(alert.key)) result.push(alert);
  return result;
}
