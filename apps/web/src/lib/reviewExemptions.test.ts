import { describe, expect, it } from "vitest";
import type { ReviewExemptionDefaults } from "@dora-dashboard/core";
import { exemptionProblem, inputsFor, rulesFromInputs } from "./reviewExemptions";

const limits: ReviewExemptionDefaults["limits"] = { titleWords: 4, labels: 4, length: 20 };
const entries = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(", ");

describe("the limits on a reviewed elsewhere list", () => {
  // The API accepts exactly the limit, so the form must too, and refuse only what the API would refuse.
  it.each([
    { count: 4, problem: null },
    { count: 5, problem: "tooMany" },
  ])("gives $problem for $count entries against a limit of four", ({ count, problem }) => {
    expect(exemptionProblem(entries(count), 4, limits)).toBe(problem);
  });

  it.each([
    { length: 20, problem: null },
    { length: 21, problem: "tooLong" },
  ])("gives $problem for an entry of $length characters against a limit of 20", ({ length, problem }) => {
    expect(exemptionProblem("a".repeat(length), 4, limits)).toBe(problem);
  });

  it("counts an entry repeated with other capitals once, and ignores blanks", () => {
    expect(exemptionProblem("a, A, , b, c, d", 4, limits)).toBeNull();
  });

  it("refuses an entry holding a control character", () => {
    expect(exemptionProblem("fine, bad\u0007word", 4, limits)).toBe("control");
    expect(exemptionProblem("bad\u007fword", 4, limits)).toBe("control");
  });

  it("asks title words, but not labels, to hold a letter or a digit", () => {
    expect(exemptionProblem("sync, ###", 4, limits, true)).toBe("noWord");
    expect(exemptionProblem("sync, ###", 4, limits)).toBeNull();
    expect(exemptionProblem("sync, v2, été", 4, limits, true)).toBeNull();
  });

  it("gives no problem for an empty box", () => {
    expect(exemptionProblem("", 4, limits, true)).toBeNull();
  });
});

describe("the two boxes of the reviewed elsewhere editor", () => {
  it("starts from the override when there is one and from the defaults when there is not", () => {
    const defaults = { titleWords: ["sync"], labels: ["vendored"] };
    expect(inputsFor({ titleWords: ["mirror"], labels: [] }, defaults)).toEqual({ titleWords: "mirror", labels: "" });
    expect(inputsFor(null, defaults)).toEqual({ titleWords: "sync", labels: "vendored" });
    expect(inputsFor(null, undefined)).toEqual({ titleWords: "", labels: "" });
  });

  it("always sends both lists, so a box left empty clears that kind", () => {
    expect(rulesFromInputs({ titleWords: "Sync, mirror", labels: "" })).toEqual({ titleWords: ["Sync", "mirror"], labels: [] });
  });
});
