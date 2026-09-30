import { describe, expect, it } from "vitest";
import type { AuthorChoice } from "@dora-dashboard/core";
import { everyoneLeftOut, excludedInRange, excludeEveryone, toggleAuthor } from "./authorFilter";

const choices: AuthorChoice[] = [
  { author: "bea", opened: 20, excluded: false },
  { author: "ade", opened: 5, excluded: false },
];

describe("toggleAuthor", () => {
  it("adds an unticked author and removes a ticked one, keeping the rest", () => {
    expect(toggleAuthor(["zed"], "ade", false)).toEqual(["zed", "ade"]);
    expect(toggleAuthor(["zed", "ade"], "ade", true)).toEqual(["zed"]);
    expect(toggleAuthor(["ade"], "ade", false)).toEqual(["ade"]);
  });
});

describe("excludeEveryone", () => {
  it("leaves out every author on offer without losing or repeating earlier exclusions", () => {
    expect(excludeEveryone(["zed", "ade"], choices)).toEqual(["zed", "ade", "bea"]);
  });
});

describe("excludedInRange", () => {
  it("lists only the excluded authors who opened pull requests in this range, in menu order", () => {
    expect(excludedInRange(choices, ["zed", "ade", "bea"])).toEqual(["bea", "ade"]);
    expect(excludedInRange(choices, [])).toEqual([]);
  });
});

describe("everyoneLeftOut", () => {
  it("is true only when authors are on offer and all of them are left out", () => {
    expect(everyoneLeftOut(choices, ["bea", "ade"])).toBe(true);
    expect(everyoneLeftOut(choices, ["bea"])).toBe(false);
    expect(everyoneLeftOut([], [])).toBe(false);
  });
});
