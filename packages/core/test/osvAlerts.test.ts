import { describe, expect, it } from "vitest";
import { osvFindings, reconcileOsvAlerts } from "../src/osvAlerts.js";
import { depAlert, lockedPackage, vulnerability } from "./security.js";

const NOW = "2026-03-01T00:00:00Z";
const EARLIER = "2026-01-01T00:00:00Z";

describe("osvFindings", () => {
  it("builds an open alert from one vulnerability, field by field", () => {
    const alerts = osvFindings([lockedPackage()], [[vulnerability()]], NOW);
    expect(alerts).toEqual([
      {
        key: "GHSA-35jh-r3h4-6jhm|npm|lodash|package-lock.json",
        source: "osv",
        state: "open",
        createdAt: NOW,
        closedAt: null,
        closeReason: null,
        title: "Command injection in lodash",
        url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
        severity: "high",
        dependency: {
          ecosystem: "npm",
          name: "lodash",
          manifestPath: "package-lock.json",
          scope: null,
          relationship: null,
          lockedVersion: "4.17.15",
          patchedVersion: "4.17.21",
          vulnerableRange: null,
          advisoryId: "GHSA-35jh-r3h4-6jhm",
          cveId: "CVE-2021-23337",
          epss: null,
          cvssScore: null,
          cwes: [],
        },
      },
    ]);
  });

  it("makes no alert for a package with no vulnerabilities or no answer", () => {
    expect(osvFindings([lockedPackage(), lockedPackage({ name: "ms" })], [[]], NOW)).toEqual([]);
  });

  it("groups a record and its alias record into one finding named by the GHSA id", () => {
    const ghsa = vulnerability({ id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2024-1"], summary: "From GitHub" });
    const pysec = vulnerability({ id: "PYSEC-2024-1", aliases: ["CVE-2024-1", "GHSA-aaaa-bbbb-cccc"], summary: "From PyPA" });
    const alerts = osvFindings(
      [lockedPackage({ ecosystem: "PyPI", name: "requests", lockfile: "poetry.lock" })],
      [[pysec, ghsa]],
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: "GHSA-aaaa-bbbb-cccc|PyPI|requests|poetry.lock",
      title: "From GitHub",
      url: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
      dependency: { advisoryId: "GHSA-aaaa-bbbb-cccc", cveId: "CVE-2024-1" },
    });
  });

  it("joins records that share only an alias, even when a third record links them", () => {
    const a = vulnerability({ id: "OSV-1", aliases: ["CVE-1"] });
    const b = vulnerability({ id: "OSV-2", aliases: ["CVE-2"] });
    const bridge = vulnerability({ id: "OSV-3", aliases: ["CVE-1", "CVE-2"] });
    expect(osvFindings([lockedPackage()], [[a, b, bridge]], NOW)).toHaveLength(1);
  });

  it("keeps unrelated records as separate findings", () => {
    const a = vulnerability({ id: "GHSA-aaaa-aaaa-aaaa", aliases: [] });
    const b = vulnerability({ id: "GHSA-bbbb-bbbb-bbbb", aliases: [] });
    expect(osvFindings([lockedPackage()], [[a, b]], NOW).map((alert) => alert.dependency.advisoryId)).toEqual([
      "GHSA-aaaa-aaaa-aaaa",
      "GHSA-bbbb-bbbb-bbbb",
    ]);
  });

  it("names a group with no GHSA id by its lowest id", () => {
    const a = vulnerability({ id: "PYSEC-2024-9", aliases: ["CVE-2024-7"] });
    const b = vulnerability({ id: "OSV-2024-3", aliases: ["CVE-2024-7"] });
    // Ids in the group: PYSEC-2024-9, OSV-2024-3 and CVE-2024-7. "CVE-2024-7" sorts first.
    expect(osvFindings([lockedPackage()], [[a, b]], NOW)[0]!.dependency.advisoryId).toBe("CVE-2024-7");
  });

  it("names a group of records with no aliases by its lowest id", () => {
    expect(
      osvFindings([lockedPackage()], [[vulnerability({ id: "RUSTSEC-2024-0002", aliases: [] })]], NOW)[0]!.dependency,
    ).toMatchObject({
      advisoryId: "RUSTSEC-2024-0002",
      cveId: null,
    });
  });

  it("prefers the lowest GHSA id when a group holds several", () => {
    const record = vulnerability({ id: "GHSA-zzzz-zzzz-zzzz", aliases: ["GHSA-aaaa-aaaa-aaaa"] });
    expect(osvFindings([lockedPackage()], [[record]], NOW)[0]!.dependency.advisoryId).toBe("GHSA-aaaa-aaaa-aaaa");
  });

  it("takes the lowest CVE alias as the CVE id", () => {
    const record = vulnerability({ aliases: ["CVE-2024-9", "CVE-2023-4"] });
    expect(osvFindings([lockedPackage()], [[record]], NOW)[0]!.dependency.cveId).toBe("CVE-2023-4");
  });

  it.each([
    [["low", "critical", "medium"], "critical"],
    [["medium", "high"], "high"],
    [["unknown", "low"], "unknown"],
    [["low", "unknown", "medium"], "medium"],
    [["unknown", "unknown"], "unknown"],
  ] as const)("takes the worst severity of %j, which is %s", (severities, expected) => {
    const records = severities.map((severity, i) => vulnerability({ id: `GHSA-${i}`, aliases: ["CVE-SAME"], severity }));
    expect(osvFindings([lockedPackage()], [records], NOW)[0]!.severity).toBe(expected);
  });

  it.each([
    ["the lowest fix above the locked version", "4.17.15", ["4.17.21", "4.17.16", "3.0.0"], "4.17.16"],
    ["a version that compares as ten, not two", "1.2.9", ["1.2.10", "1.2.11"], "1.2.10"],
    ["nothing when the locked version is already past every fix", "5.0.0", ["4.17.21"], null],
    ["nothing when the fix equals the locked version", "4.17.21", ["4.17.21"], null],
    ["nothing when there is no fix", "1.0.0", [], null],
    ["the release of a pre-release locked version", "1.0.0-beta", ["1.0.0"], "1.0.0"],
    ["the lowest release at or above a pre-release's own", "2.0.0-beta.1", ["1.9.0", "2.1.0", "2.0.0"], "2.0.0"],
    ["a build-metadata locked version as its release", "2.0.0+build.5", ["2.0.1", "1.0.0"], "2.0.1"],
    ["the fixes that compare, leaving out pre-releases", "1.0.0", ["2.0.0-rc.1", "3.0.0"], "3.0.0"],
    ["the lowest of the fixes when the locked version cannot be placed", "nightly", ["2.0.0", "1.5.0"], "1.5.0"],
    ["the first fix in text order when nothing compares", "nightly", ["2.0.0-rc.2", "2.0.0-rc.1"], "2.0.0-rc.1"],
    ["a pre-release fix when only pre-releases exist for a pre-release", "1.0.0-beta", ["1.0.0-rc.1"], "1.0.0-rc.1"],
  ])("offers %s", (_, locked, fixed, expected) => {
    const found = osvFindings([lockedPackage({ version: locked })], [[vulnerability({ fixedVersions: fixed })]], NOW);
    expect(found[0]!.dependency.patchedVersion).toBe(expected);
  });

  it("percent-encodes the advisory id in the link", () => {
    const record = vulnerability({ id: "GHSA-a/b?c#d", aliases: [] });
    expect(osvFindings([lockedPackage()], [[record]], NOW)[0]!.url).toBe("https://osv.dev/vulnerability/GHSA-a%2Fb%3Fc%23d");
  });

  it("takes the lowest fix across the records of one group", () => {
    const a = vulnerability({ id: "GHSA-a", aliases: ["CVE-X"], fixedVersions: ["4.17.21"] });
    const b = vulnerability({ id: "OSV-b", aliases: ["CVE-X"], fixedVersions: ["4.17.19"] });
    expect(osvFindings([lockedPackage()], [[a, b]], NOW)[0]!.dependency.patchedVersion).toBe("4.17.19");
  });

  it("falls back to the first summary, then to the id, for the title", () => {
    const named = vulnerability({ id: "OSV-1", aliases: ["CVE-1"], summary: "" });
    const other = vulnerability({ id: "OSV-2", aliases: ["CVE-1"], summary: "Second" });
    expect(osvFindings([lockedPackage()], [[named, other]], NOW)[0]!.title).toBe("Second");
    expect(osvFindings([lockedPackage()], [[vulnerability({ summary: "" })]], NOW)[0]!.title).toBe("GHSA-35jh-r3h4-6jhm");
  });

  it("finds the same advisory in two lockfiles as two alerts", () => {
    const packages = [lockedPackage(), lockedPackage({ lockfile: "web/package-lock.json" })];
    const alerts = osvFindings(packages, [[vulnerability()], [vulnerability()]], NOW);
    expect(alerts.map((a) => a.key)).toEqual([
      "GHSA-35jh-r3h4-6jhm|npm|lodash|package-lock.json",
      "GHSA-35jh-r3h4-6jhm|npm|lodash|web/package-lock.json",
    ]);
  });

  it("makes one alert when two versions of a package in one lockfile share an advisory", () => {
    const packages = [lockedPackage({ version: "4.17.15" }), lockedPackage({ version: "4.17.19" })];
    const alerts = osvFindings(packages, [[vulnerability()], [vulnerability()]], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dependency.lockedVersion).toBe("4.17.15");
  });

  it("ignores answers beyond the packages", () => {
    expect(osvFindings([], [[vulnerability()]], NOW)).toEqual([]);
  });
});

describe("reconcileOsvAlerts", () => {
  const stored = (overrides: Parameters<typeof depAlert>[0] = {}) =>
    depAlert({
      source: "osv",
      key: "k1",
      createdAt: EARLIER,
      ...overrides,
      dependency: { manifestPath: "package-lock.json", ...overrides.dependency },
    });
  /** Lockfiles read this time; each one read is present, and so is the stored alerts' own lockfile unless `gone`. */
  const read = (...paths: string[]) => ({
    now: NOW,
    lockfilesRead: new Set(paths),
    lockfilesPresent: new Set([...paths, "package-lock.json"]),
  });

  it("adds a finding that is new, opened now", () => {
    const fresh = stored({ key: "k2", createdAt: NOW });
    expect(reconcileOsvAlerts([], [fresh], read("package-lock.json"))).toEqual([fresh]);
  });

  it("keeps the first createdAt of a finding seen again, with the fresh details", () => {
    const again = stored({ createdAt: NOW, title: "Fresh title", dependency: { patchedVersion: "9.9.9" } });
    const [alert] = reconcileOsvAlerts([stored({ title: "Old title" })], [again], read("package-lock.json"));
    expect(alert).toMatchObject({
      key: "k1",
      createdAt: EARLIER,
      state: "open",
      title: "Fresh title",
      dependency: { patchedVersion: "9.9.9" },
    });
  });

  it("closes a stored open alert that was not found when its lockfile was read", () => {
    const [alert] = reconcileOsvAlerts([stored()], [], read("package-lock.json"));
    expect(alert).toMatchObject({ state: "fixed", closedAt: NOW, closeReason: "not_found", createdAt: EARLIER });
  });

  it("keeps a stored open alert unchanged when its lockfile was not read this time", () => {
    const old = stored();
    expect(reconcileOsvAlerts([old], [], read("web/package-lock.json"))).toEqual([old]);
  });

  it("keeps an alert that is already closed as it was", () => {
    const closed = stored({ state: "fixed", closedAt: "2026-02-01T00:00:00Z", closeReason: "not_found" });
    expect(reconcileOsvAlerts([closed], [], read("package-lock.json"))).toEqual([closed]);
  });

  it("returns the whole set: stored alerts in their order, then new ones", () => {
    const a = stored({ key: "a" });
    const b = stored({ key: "b" });
    const c = stored({ key: "c", createdAt: NOW });
    const result = reconcileOsvAlerts([a, b], [c, stored({ key: "b", createdAt: NOW })], read("package-lock.json"));
    expect(result.map((alert) => `${alert.key}:${alert.state}`)).toEqual(["a:fixed", "b:open", "c:open"]);
  });

  it("does not change the alerts it was given", () => {
    const old = stored();
    const snapshot = JSON.stringify(old);
    reconcileOsvAlerts([old], [], read("package-lock.json"));
    reconcileOsvAlerts([old], [stored({ createdAt: NOW })], read("package-lock.json"));
    expect(JSON.stringify(old)).toBe(snapshot);
  });

  it("uses the first of two found alerts with one key", () => {
    const first = stored({ key: "d", title: "first", createdAt: NOW });
    const second = stored({ key: "d", title: "second", createdAt: NOW });
    expect(reconcileOsvAlerts([], [first, second], read()).map((a) => a.title)).toEqual(["first"]);
  });
  it("closes an open alert whose lockfile is no longer present, even though it was not read", () => {
    const old = stored();
    const [alert] = reconcileOsvAlerts([old], [], {
      now: NOW,
      lockfilesRead: new Set(),
      lockfilesPresent: new Set(["web/package-lock.json"]),
    });
    expect(alert).toMatchObject({ state: "fixed", closedAt: NOW, closeReason: "not_found", createdAt: EARLIER });
  });

  it("keeps an open alert whose lockfile is present but was not read", () => {
    const old = stored();
    const at = { now: NOW, lockfilesRead: new Set<string>(), lockfilesPresent: new Set(["package-lock.json"]) };
    expect(reconcileOsvAlerts([old], [], at)).toEqual([old]);
  });

  it("closes only the alerts of the deleted lockfile and keeps the rest", () => {
    const kept = stored({ key: "a" });
    const gone = stored({ key: "b", dependency: { manifestPath: "old/package-lock.json" } });
    const at = { now: NOW, lockfilesRead: new Set<string>(), lockfilesPresent: new Set(["package-lock.json"]) };
    expect(reconcileOsvAlerts([kept, gone], [], at).map((a) => `${a.key}:${a.state}`)).toEqual(["a:open", "b:fixed"]);
  });

  it("starts a new span for a fixed alert that returns, with createdAt set to the reopen", () => {
    const closed = stored({ state: "fixed", closedAt: "2026-02-01T00:00:00Z", closeReason: "not_found" });
    const [alert] = reconcileOsvAlerts([closed], [stored({ createdAt: NOW })], read("package-lock.json"));
    expect(alert).toMatchObject({ state: "open", closedAt: null, closeReason: null, createdAt: NOW });
  });
});
