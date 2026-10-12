import { describe, expect, it } from "vitest";
import { copy } from "./copy";

/**
 * Sample arguments for the sentences that are built from values, so a wording rule reaches them as well. A function
 * that cannot be called with one set is tried with the next, and a set it does not suit simply yields nothing.
 */
const SAMPLES: unknown[][] = [
  [],
  [1, 2, 3],
  [2, 3, 4],
  [0, 1, null],
  ["name", "1 Jan 2026", "message"],
  [{ count: 2, thresholds: null, target: "left-pad", names: ["a", "b"] }],
  [{ count: 1, thresholds: { lowAlertAdviceDays: 90 } }],
];

/** Every plain string under a value, and the sentences that its functions build, so a wording rule covers the whole copy. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "function") {
    return SAMPLES.flatMap((args) => {
      try {
        return strings((value as (...a: unknown[]) => unknown)(...args));
      } catch {
        return [];
      }
    });
  }
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const all = strings(copy.security);
const c = copy.security;

describe("where to switch security features on", () => {
  it("never sends anyone to Settings, Code security, which GitHub has renamed", () => {
    expect(
      all.filter((text) => /Settings,? (then )?(and then )?(choose )?Code security|choose Code security/.test(text)),
    ).toEqual([]);
  });

  it.each([
    "enable_dependabot",
    "enable_security_updates",
    "enable_push_protection",
    "enable_private_reporting",
    "enable_code_scanning",
  ] as const)("names Advanced Security in the Security section of the sidebar for %s", (kind) => {
    expect(c.fix[kind].steps[0]).toContain("Settings");
    expect(c.fix[kind].steps[0]).toContain("Advanced Security");
    expect(c.fix[kind].steps[0]).toContain("Security section of the sidebar");
  });

  it("names Advanced Security where the sources and the Dependabot explanation say how to switch on", () => {
    for (const text of [
      c.sources.enable.dependabot,
      c.sources.enable.code_scanning,
      c.sources.enable.secret_scanning,
      c.dependabotAlerts.source(".github/dependabot.yml"),
      c.dependabotAlerts.steps[0]!,
      c.fix.check_secret_scanning.steps[0]!,
    ]) {
      expect(text).toContain("Advanced Security");
    }
    expect(c.dependabotAlerts.steps[0]).toContain("Security section of the sidebar");
  });
});

describe("what a pull request from a fork can reach", () => {
  it("says pull requests from forks get no secrets and a read-only token, in the steps and the glossary", () => {
    const words = "pull requests from forks get no secrets and only a read-only token";
    expect(c.fix.fix_pr_head_checkout.steps.join(" ")).toContain(words);
    expect(c.glossary.terms.find((t) => t.term === "pull_request_target")!.meaning).toContain(words);
  });

  it("no longer says pull_request simply runs without secrets", () => {
    expect(all.filter((text) => /runs without secrets/.test(text))).toEqual([]);
  });
});

describe("leaked files", () => {
  it.each(["remove_key_files", "review_weak_key_files"] as const)(
    "tells the reader that %s stay in the history and to stop tracking them",
    (kind) => {
      const text = c.fix[kind].steps.join(" ");
      expect(text).toContain("git rm --cached");
      expect(text).toMatch(/history/);
    },
  );

  it("says plainly that anything ever committed is leaked and must be rotated", () => {
    expect(c.fix.remove_key_files.steps.join(" ")).toMatch(/leaked and rotate it/);
  });
});

describe("the dashboard's own wording", () => {
  it("uses no em or en dash anywhere in the security copy, including the sentences built from values", () => {
    // Guards the check itself: the sentences of a function are part of what is searched.
    expect(all).toContain(c.checks.secretExposed.bad(2));
    expect(all).toContain(c.page.alertsStale("name"));
    expect(all.filter((text) => /[–—]/.test(text))).toEqual([]);
  });

  it("claims only that Dependabot was not found switched off, as core also meets the check when Dependabot could not be read", () => {
    // With Dependabot answering no_access and the OSV lookup off, nothing is known to be watching the dependencies.
    expect(c.checks.dependenciesUnwatched.good).toBe("Dependabot alerts were not found to be switched off.");
    expect(c.checks.dependenciesUnwatched.good).not.toMatch(/watching/);
  });

  it("says a plural count of exposed secrets with a plural verb throughout", () => {
    expect(c.checks.secretExposed.bad(1)).toBe("1 exposed secret is still active or has been made public.");
    expect(c.checks.secretExposed.bad(3)).toBe("3 exposed secrets are still active or have been made public.");
  });

  it("names GitHub Code Security as a need on a private repository for code scanning and dependency review", () => {
    expect(c.fix.enable_code_scanning.steps.join(" ")).toContain("GitHub Code Security");
    expect(c.fix.add_dependency_review.steps.join(" ")).toContain("GitHub Code Security");
    expect(c.fix.add_static_analysis.steps.join(" ")).toContain("GitHub Code Security");
  });
});
