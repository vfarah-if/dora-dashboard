import { describe, expect, it } from "vitest";
import { fromFirstActive, initialWindow } from "./weekly";

describe("fromFirstActive", () => {
  const weeks = [{ n: 0 }, { n: 0 }, { n: 3 }, { n: 0 }, { n: 1 }];

  it("drops the empty weeks before the first active one and keeps later gaps", () => {
    expect(fromFirstActive(weeks, (w) => w.n > 0)).toEqual([{ n: 3 }, { n: 0 }, { n: 1 }]);
  });

  it("returns every week when none is active", () => {
    expect(fromFirstActive(weeks, () => false)).toEqual(weeks);
  });

  it("returns every week when the first is already active", () => {
    expect(fromFirstActive(weeks, () => true)).toHaveLength(5);
  });
});

describe("initialWindow", () => {
  it("needs no window when every week fits", () => {
    expect(initialWindow(26)).toBeNull();
    expect(initialWindow(0)).toBeNull();
  });

  it("opens on the latest weeks when there are more than fit", () => {
    expect(initialWindow(110)).toEqual({ startIndex: 84, endIndex: 109 });
  });

  it("honours a smaller visible count", () => {
    expect(initialWindow(10, 4)).toEqual({ startIndex: 6, endIndex: 9 });
  });
});
