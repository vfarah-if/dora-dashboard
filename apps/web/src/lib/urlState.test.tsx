import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoute } from "../test/render";
import { isoDaysAgo } from "./format";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { useRangeParams, useTextParam } from "./urlState";

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

describe("useTextParam", () => {
  function TextProbe() {
    const [area, setArea] = useTextParam("area");
    return (
      <>
        <p>{`area is ${area ?? "unset"}`}</p>
        <button onClick={() => setArea("apps/api")}>set</button>
        <button onClick={() => setArea(null)}>clear</button>
      </>
    );
  }

  it("reads the value from the address, or null when there is none", () => {
    renderRoute(<TextProbe />, { route: "/?area=packages%2Fcore" });
    expect(screen.getByText("area is packages/core")).toBeInTheDocument();
  });

  it("sets and clears the value without touching other parameters", async () => {
    const user = userEvent.setup();
    function Both() {
      const { search } = useLocation();
      return (
        <>
          <TextProbe />
          <p>{`search ${search}`}</p>
        </>
      );
    }
    renderRoute(<Both />, { route: "/?from=2026-01-01" });
    expect(screen.getByText("area is unset")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(screen.getByText("search ?from=2026-01-01&area=apps%2Fapi")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByText("search ?from=2026-01-01")).toBeInTheDocument();
  });
});
