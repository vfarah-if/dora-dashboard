import { describe, expect, it } from "vitest";
import { compareVersions, highestVersion } from "../src/versions.js";

describe("compareVersions", () => {
  it.each([
    ["1.2.10", "1.2.9", 1],
    ["1.2.9", "1.2.10", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.2.3", "1.2.3", 0],
    ["v1.2.3", "1.2.3", 0],
    ["1.2", "1.2.0", 0],
    ["1.2", "1.2.1", -1],
    // The shorter version on the right, whose missing part must count as zero too.
    ["1.2.1", "1.2", 1],
    ["1.2.0", "1.2", 0],
    ["1", "0.9.9", 1],
    [" 1.0.0 ", "1.0.0", 0],
  ])("orders %s against %s as %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each(["1.0.0-beta.1", "1.0.0rc1", "latest", "", "1..2", "1.2.x", "v", "1.0.0+build"])("answers null for %j", (odd) => {
    expect(compareVersions(odd, "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", odd)).toBeNull();
  });
});

describe("compareVersions with components too large to hold exactly", () => {
  const huge = `1${"0".repeat(400)}`;

  it("answers null instead of NaN for a component that overflows to Infinity", () => {
    expect(compareVersions(huge, huge)).toBeNull();
    expect(compareVersions("1.0.0", `1.${huge}`)).toBeNull();
  });

  it("answers null for an integer beyond 2^53, which cannot be compared exactly", () => {
    expect(compareVersions("9007199254740993", "9007199254740992")).toBeNull();
  });

  it("still compares the largest safe integer", () => {
    expect(compareVersions("9007199254740991", "9007199254740990")).toBe(1);
  });

  it("lets highestVersion give up on such a version rather than return a wrong one", () => {
    expect(highestVersion(["1.0.0", huge])).toBeNull();
  });
});

describe("highestVersion", () => {
  it("returns the highest when every pair compares", () => {
    expect(highestVersion(["1.2.9", "1.2.10", "1.1.99"])).toBe("1.2.10");
  });

  it("returns the only version of a one item list", () => {
    expect(highestVersion(["3.4.5"])).toBe("3.4.5");
  });

  it("returns null for an empty list", () => {
    expect(highestVersion([])).toBeNull();
  });

  it("returns null when one version is a pre-release", () => {
    expect(highestVersion(["1.0.0", "2.0.0-rc.1"])).toBeNull();
  });

  it("returns null when the only version does not compare", () => {
    expect(highestVersion(["1.0.0-beta"])).toBeNull();
  });

  it("keeps the first of two equal versions", () => {
    expect(highestVersion(["v1.0.0", "1.0.0"])).toBe("v1.0.0");
  });
});
