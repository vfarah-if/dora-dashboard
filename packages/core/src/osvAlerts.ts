/**
 * Turns OSV.dev's answers about locked dependencies into the same alert shape Dependabot's alerts have, and keeps their
 * history between crawls (ADR 0034). OSV has no alert of its own, so "opened" is the crawl that first found a finding
 * and "closed" the crawl that no longer did. Pure: the caller supplies the answers and the time.
 */
import { worseSeverity } from "./securityAlerts.js";
import { compareText } from "./stats.js";
import { compareVersions } from "./versions.js";
import type { LockedPackage, LockfileSummary, OsvAlert, Severity, Vulnerability } from "./securityTypes.js";

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

const worst = (severities: readonly Severity[]): Severity => severities.reduce(worseSeverity, "low" as Severity);

/** The numeric part of a pre-release such as `2.0.0-beta.1`, or null for anything else. */
const releaseOf = (version: string): string | null => /^(v?\d+(?:\.\d+)*)[-+]/.exec(version.trim())?.[1] ?? null;

/** The lowest of the versions: by their releases where those compare, then in text order. */
const lowestVersion = (versions: readonly string[]): string | null =>
  [...versions].sort(
    (a, b) => (compareVersions(releaseOf(a) ?? a, releaseOf(b) ?? b) ?? 0) || (compareVersions(a, b) ?? compareText(a, b)),
  )[0] ?? null;

/**
 * The lowest fixed version above the locked one, never one below it. A pre-release is below its own release, so for
 * `2.0.0-beta.1` the release `2.0.0` counts as a fix. When the locked version is a pre-release and no release fixes it,
 * a pre-release fix whose release is at or above the locked one's is offered, such as `1.0.0-rc.1` for `1.0.0-beta`,
 * since dropping it would advise replacing a package that can be upgraded. When the locked version is a plain release,
 * a pre-release fix is not offered, because the two do not compare. When the locked version cannot be placed at all,
 * the lowest fix is offered, by release and then in text order.
 */
function patchedAbove(locked: string, fixed: readonly string[]): string | null {
  const exact = compareVersions(locked, locked) !== null;
  const base = exact ? locked : releaseOf(locked);
  if (base === null) return lowestVersion(fixed);
  let best: string | null = null;
  for (const version of fixed) {
    const order = compareVersions(version, base);
    if (order === null || order < (exact ? 1 : 0)) continue;
    if (best === null || (compareVersions(version, best) ?? 0) < 0) best = version;
  }
  if (best !== null || exact) return best;
  return lowestVersion(
    fixed.filter((version) => {
      const release = releaseOf(version);
      return release !== null && (compareVersions(release, base) ?? -1) >= 0;
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

/**
 * The lockfiles a supply chain record shows to exist, or null when its listing of the clone stopped short. A record
 * stored before `listingComplete` was added has no such field and is read as cut short, so it never closes an alert
 * as deleted.
 */
export function presentLockfiles(facts: {
  lockfiles: readonly Pick<LockfileSummary, "path">[];
  listingComplete?: boolean;
}): ReadonlySet<string> | null {
  return facts.listingComplete === true ? new Set(facts.lockfiles.map((lockfile) => lockfile.path)) : null;
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
