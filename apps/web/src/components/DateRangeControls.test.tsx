import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DateRangeControls } from "./DateRangeControls";
import { copy } from "../copy";

const value = { from: null, to: null, includeBots: false };

describe("DateRangeControls", () => {
  it("offers the bots switch by default", () => {
    render(<DateRangeControls value={value} onChange={vi.fn()} />);
    expect(screen.getByRole("switch", { name: copy.range.includeBots })).toBeInTheDocument();
  });

  it("leaves the bots switch out when asked", () => {
    render(<DateRangeControls value={value} onChange={vi.fn()} showBots={false} />);
    expect(screen.queryByRole("switch", { name: copy.range.includeBots })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.range.last30 })).toBeInTheDocument();
  });
});
