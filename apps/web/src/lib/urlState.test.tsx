import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoute } from "../test/render";
import { isoDaysAgo } from "./format";
import { useRangeParams } from "./urlState";

function Probe() {
  const [range] = useRangeParams();
  return <p>{`${range.from ?? "none"} to ${range.to ?? "none"}`}</p>;
}

describe("useRangeParams", () => {
  const today = isoDaysAgo(0);

  it("reads a past range as given", () => {
    renderRoute(<Probe />, { route: "/?from=2026-01-01&to=2026-02-01" });
    expect(screen.getByText("2026-01-01 to 2026-02-01")).toBeInTheDocument();
  });

  it("brings a from or to later than today back to today", () => {
    renderRoute(<Probe />, { route: "/?from=2099-01-01&to=2099-02-01" });
    expect(screen.getByText(`${today} to ${today}`)).toBeInTheDocument();
  });

  it("ignores a malformed date", () => {
    renderRoute(<Probe />, { route: "/?from=tomorrow" });
    expect(screen.getByText("none to none")).toBeInTheDocument();
  });
});
