import { describe, expect, it } from "vitest";
import { copy } from "./copy";

/** Every plain string under a value, so a wording rule can be checked across the whole security copy. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
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
  it("uses no em or en dash anywhere in the security copy", () => {
    expect(all.filter((text) => /[–—]/.test(text))).toEqual([]);
  });

  it("names GitHub Code Security as a need on a private repository for code scanning and dependency review", () => {
    expect(c.fix.enable_code_scanning.steps.join(" ")).toContain("GitHub Code Security");
    expect(c.fix.add_dependency_review.steps.join(" ")).toContain("GitHub Code Security");
    expect(c.fix.add_static_analysis.steps.join(" ")).toContain("GitHub Code Security");
  });
});
