import { describe, expect, it } from "vitest";
import { distributionIsEmpty, distributionRows, locationLabel, shortSha } from "./codeHealth";

describe("code health helpers", () => {
  it("shortens a sha to seven characters", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });

  it("keeps only the label and count of each bucket", () => {
    const rows = distributionRows({ distribution: [{ label: "1 to 5", min: 1, max: 5, count: 3 }] });
    expect(rows).toEqual([{ label: "1 to 5", count: 3 }]);
  });

  it("recognises an empty distribution", () => {
    expect(distributionIsEmpty([{ label: "a", count: 0 }])).toBe(true);
    expect(
      distributionIsEmpty([
        { label: "a", count: 0 },
        { label: "b", count: 1 },
      ]),
    ).toBe(false);
  });

  it("joins file and line", () => {
    expect(locationLabel({ file: "src/a.ts", startLine: 42 })).toBe("src/a.ts:42");
  });
});
