import { describe, expect, it } from "vitest";
import { reworkFigure } from "./dora";
import { rangeQuery } from "../api/hooks";
import { report } from "../test/fixtures";

describe("reworkFigure", () => {
  it("formats the rate and counts the deploys, with no band", () => {
    const base = report();
    const figure = reworkFigure({
      ...base,
      dora: { ...base.dora, changeFailure: { ...base.dora.changeFailure!, rework: { rate: 1 / 3, deploys: 1, total: 3 } } },
    });
    expect(figure.value).toBe("33%");
    expect(figure.detail).toBe("1 of 3 deploys shipped a revert or hotfix");
    expect(figure.band).toBeNull();
  });

  it("has no value when change failure is missing", () => {
    const base = report();
    expect(reworkFigure({ ...base, dora: { ...base.dora, changeFailure: null } }).value).toBeNull();
  });
});

describe("rangeQuery", () => {
  const range = { from: null, to: null, includeBots: false };
  it("sends the profile only when one is set", () => {
    expect(rangeQuery(range)).toBe("");
    expect(rangeQuery({ ...range, profile: null })).toBe("");
    expect(rangeQuery({ ...range, profile: "dora-2023" })).toBe("profile=dora-2023");
  });
});
