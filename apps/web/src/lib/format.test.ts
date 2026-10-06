import { describe, expect, it } from "vitest";
import {
  durationUnit,
  formatDate,
  formatDateTime,
  formatDuration,
  formatDurationIn,
  formatNumber,
  formatPercent,
  formatWeek,
  isoDaysAgo,
  placesNeeded,
} from "./format";
import { copy } from "../copy";

describe("formatDuration", () => {
  it("shows whole minutes under an hour", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(0.25)).toBe("15 min");
    expect(formatDuration(0.999)).toBe("60 min");
  });

  it("shows hours to one decimal from one hour up to 48 hours", () => {
    expect(formatDuration(1)).toBe("1.0 h");
    expect(formatDuration(5.26)).toBe("5.3 h");
    expect(formatDuration(47.9)).toBe("47.9 h");
  });

  it("shows days to one decimal from 48 hours", () => {
    expect(formatDuration(48)).toBe("2.0 days");
    expect(formatDuration(24 * 10.25)).toBe("10.3 days");
  });

  it("treats a missing or invalid value as no data and clamps negatives", () => {
    expect(formatDuration(null)).toBe(copy.common.notAvailable);
    expect(formatDuration(undefined)).toBe(copy.common.notAvailable);
    expect(formatDuration(Number.NaN)).toBe(copy.common.notAvailable);
    expect(formatDuration(-3)).toBe("0 min");
  });
});

describe("durationUnit", () => {
  it("chooses the unit formatDuration writes a value in", () => {
    expect(durationUnit(0.5)).toBe("min");
    expect(durationUnit(1)).toBe("h");
    expect(durationUnit(47.9)).toBe("h");
    expect(durationUnit(48)).toBe("days");
    expect(durationUnit(-2)).toBe("min");
  });
});

describe("formatDurationIn", () => {
  it("writes whole hours and whole days without a trailing .0", () => {
    expect(formatDurationIn(24)).toBe("24 h");
    expect(formatDurationIn(1)).toBe("1 h");
    expect(formatDurationIn(168)).toBe("7 days");
    expect(formatDurationIn(30.5)).toBe("30.5 h");
    expect(formatDurationIn(200)).toBe("8.3 days"); // 200 / 24 = 8.33
    expect(formatDurationIn(0.5)).toBe("30 min");
  });

  it("writes an amount in the unit it is given, so a gap matches its value", () => {
    expect(formatDurationIn(32, "days")).toBe("1.3 days"); // 32 / 24 = 1.33
    expect(formatDurationIn(24, "days")).toBe("1 day");
    expect(formatDurationIn(0.5, "h")).toBe("0.5 h");
    expect(formatDurationIn(0.25, "min")).toBe("15 min");
  });

  it("treats a missing or invalid value as no data and clamps negatives", () => {
    expect(formatDurationIn(null)).toBe(copy.common.notAvailable);
    expect(formatDurationIn(Number.NaN, "h")).toBe(copy.common.notAvailable);
    expect(formatDurationIn(-3)).toBe("0 min");
  });
});

describe("placesNeeded", () => {
  it.each([
    [9.4, 0, 1, 1], // a tenth matters
    [10, 0, 1, 0],
    [9.999999999999998, 0, 1, 0], // 0.25 - 0.15 in floating point, which is 10 to one place
    [5.17, 1, 1, 1],
    [3, 1, 2, 1], // never fewer than the minimum
    [0.02, 1, 1, 2], // one place would show zero, so it takes another
    [0.0001, 0, 1, 4],
    [0, 0, 1, 0],
  ])("needs the right places for %s between %s and %s", (value, min, max, expected) => {
    expect(placesNeeded(value, min, max)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it("rounds a share to a whole percentage", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.254)).toBe("25%");
    expect(formatPercent(0.255)).toBe("26%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe(copy.common.notAvailable);
  });
});

describe("formatNumber", () => {
  it("groups thousands and limits decimals", () => {
    expect(formatNumber(1234.567, 1)).toBe("1,234.6");
    expect(formatNumber(2, 2)).toBe("2");
    expect(formatNumber(null)).toBe(copy.common.notAvailable);
  });
});

describe("dates", () => {
  it("formats a calendar date and a week label in UTC", () => {
    expect(formatDate("2026-03-03")).toBe("3 Mar 2026");
    expect(formatDate("2026-03-03T23:30:00Z")).toBe("3 Mar 2026");
    expect(formatWeek("2026-03-02")).toBe("2 Mar");
    expect(formatWeek("nonsense")).toBe("nonsense");
    expect(formatDate(null)).toBe(copy.common.notAvailable);
    expect(formatDateTime(null)).toBe(copy.common.notAvailable);
    expect(formatDateTime("2026-03-03T10:00:00Z")).toContain("2026");
  });

  it("computes a UTC day a number of days ago", () => {
    const now = new Date("2026-03-31T22:00:00Z");
    expect(isoDaysAgo(0, now)).toBe("2026-03-31");
    expect(isoDaysAgo(30, now)).toBe("2026-03-01");
  });
});
