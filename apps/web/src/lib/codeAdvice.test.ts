import { describe, expect, it } from "vitest";
import { adviceFor, splitPartlyMeasured } from "./codeAdvice";
import { copy } from "../copy";

describe("adviceFor", () => {
  it("gives distinct advice for each shape and for a function within limits", () => {
    const shapes = ["component", "dense", "long", "branching", null] as const;
    const texts = shapes.map(adviceFor);
    expect(new Set(texts).size).toBe(5);
    expect(adviceFor(null)).toBe(copy.codeHealth.hotspots.adviceFor.within);
    for (const shape of ["component", "dense", "long", "branching"] as const) {
      expect(adviceFor(shape)).toBe(copy.codeHealth.hotspots.adviceFor[shape]);
    }
  });
});

describe("splitPartlyMeasured", () => {
  it("lists every file up to ten", () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.tsx`);
    expect(splitPartlyMeasured(files)).toEqual({ shown: files, rest: 0 });
  });

  it("lists the first ten and counts the rest", () => {
    const files = Array.from({ length: 13 }, (_, i) => `f${i}.tsx`);
    const { shown, rest } = splitPartlyMeasured(files);
    expect(shown).toEqual(files.slice(0, 10));
    expect(rest).toBe(3);
  });
});
