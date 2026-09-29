import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent, formatWeek, isoDaysAgo } from "./format";
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
