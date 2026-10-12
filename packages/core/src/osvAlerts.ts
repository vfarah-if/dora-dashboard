/**
 * Turns OSV.dev's answers about locked dependencies into the same alert shape Dependabot's alerts have, and keeps their
 * history between crawls (ADR 0034). OSV has no alert of its own, so "opened" is the crawl that first found a finding
 * and "closed" the crawl that no longer did. Pure: the caller supplies the answers and the time.
 */
import { worseSeverity } from "./securityAlerts.js";
import { compareText } from "./stats.js";
import { compareVersions } from "./versions.js";
import type { DependencyAlert, LockedPackage, Severity, Vulnerability } from "./securityTypes.js";

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

/**
 * The lowest fixed version above the locked one. A pre-release is below its own release, so for `2.0.0-beta.1` the
 * release `2.0.0` counts as a fix. When the locked version cannot be placed at all, or only pre-release fixes exist,
 * the fixed versions are still offered rather than dropped, which would advise replacing a package that can be
 * upgraded: the lowest that compare with each other, else the first in text order.
 */
function patchedAbove(locked: string, fixed: readonly string[]): string | null {
  const exact = compareVersions(locked, locked) !== null;
  const base = exact ? locked : releaseOf(locked);
  let best: string | null = null;
  if (base !== null) {
    for (const version of fixed) {
      const order = compareVersions(version, base);
      if (order === null || order < (exact ? 1 : 0)) continue;
      if (best === null || (compareVersions(version, best) ?? 0) < 0) best = version;
    }
  }
  if (best !== null || exact || fixed.length === 0) return best;
  return [...fixed].sort((a, b) => compareVersions(a, b) ?? compareText(a, b))[0] ?? null;
}

/**
 * One alert per advisory per package. `results[i]` holds the vulnerabilities found for `packages[i]`. Each advisory and
 * its aliases form one finding, named by its GHSA id when there is one and otherwise by the lowest id. The same
 * advisory on two versions of one package in one lockfile is a single alert, since the key does not name the version.
 */
export function osvFindings(
  packages: readonly LockedPackage[],
  results: readonly (readonly Vulnerability[])[],
  now: string,
): DependencyAlert[] {
  const alerts = new Map<string, DependencyAlert>();
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

/**
 * The full set of OSV alerts after a crawl. A finding seen again keeps the `createdAt` of its first sighting while it
 * stays open. A fixed one that returns is open again with `createdAt` set to the reopen time: an alert has no field for
 * the gap, so keeping the first sighting would make the weekly replay show it open through the weeks it was fixed, and a
 * returning vulnerability starts its fix-by clock again. A stored open alert that is not found is closed as `not_found`
 * when its lockfile no longer exists (deleted or renamed, so nothing can find it again) or when its lockfile was read
 * this time and did not hold it. A lockfile that exists but was not read says nothing, so its alerts are kept.
 */
export function reconcileOsvAlerts(
  stored: readonly DependencyAlert[],
  found: readonly DependencyAlert[],
  at: { now: string; lockfilesRead: ReadonlySet<string>; lockfilesPresent: ReadonlySet<string> },
): DependencyAlert[] {
  const current = new Map<string, DependencyAlert>();
  for (const alert of found) if (!current.has(alert.key)) current.set(alert.key, alert);
  const kept = new Set<string>();
  const result: DependencyAlert[] = [];
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
    } else if (
      old.state === "open" &&
      (!at.lockfilesPresent.has(old.dependency.manifestPath) || at.lockfilesRead.has(old.dependency.manifestPath))
    ) {
      result.push({ ...old, state: "fixed", closedAt: at.now, closeReason: "not_found" });
    } else {
      result.push(old);
    }
  }
  for (const alert of current.values()) if (!kept.has(alert.key)) result.push(alert);
  return result;
}
