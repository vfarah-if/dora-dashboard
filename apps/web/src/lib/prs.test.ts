import { describe, expect, it } from "vitest";
import { filterByAuthor, prAuthors } from "./prs";
import { report } from "../test/fixtures";

const base = report().prs[0]!;
const prs = [
  { ...base, number: 1, author: "bea" },
  { ...base, number: 2, author: "ade" },
  { ...base, number: 3, author: "bea" },
  { ...base, number: 4, author: null },
  { ...base, number: 5, author: "cal" },
];

describe("prAuthors", () => {
  it("counts each named author, most active first and ties by login", () => {
    expect(prAuthors(prs)).toEqual([
      { login: "bea", count: 2 },
      { login: "ade", count: 1 },
      { login: "cal", count: 1 },
    ]);
  });

  it("is empty when there are no pull requests", () => {
    expect(prAuthors([])).toEqual([]);
  });
});

describe("filterByAuthor", () => {
  it("keeps only the chosen author's pull requests", () => {
    expect(filterByAuthor(prs, "bea").map((pr) => pr.number)).toEqual([1, 3]);
  });

  it("keeps everything when no author is chosen", () => {
    expect(filterByAuthor(prs, null)).toBe(prs);
  });
});
