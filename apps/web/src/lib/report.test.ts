import { describe, expect, it } from "vitest";
import { reportFileName } from "./report";

describe("reportFileName", () => {
  it("joins the subject, a label and the day as one lower-case slug", () => {
    expect(reportFileName("acme/widgets", "2026-09-29")).toBe("acme-widgets-delivery-report-2026-09-29");
  });

  it("collapses runs of punctuation and spaces and trims the ends", () => {
    expect(reportFileName("  Acme/Widgets vs acme/gadgets!! ", "2026-01-05")).toBe(
      "acme-widgets-vs-acme-gadgets-delivery-report-2026-01-05",
    );
  });
});
