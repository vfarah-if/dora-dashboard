import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  const now = new Date("2026-10-06T12:00:00Z");

  it("stops either date being picked after today", () => {
    render(<DateRangeControls value={value} onChange={vi.fn()} now={now} />);
    expect(screen.getByLabelText(copy.range.from)).toHaveAttribute("max", "2026-10-06");
    expect(screen.getByLabelText(copy.range.to)).toHaveAttribute("max", "2026-10-06");
  });

  it("keeps the start no later than the end when the end is before today", () => {
    render(<DateRangeControls value={{ ...value, from: "2026-09-01", to: "2026-09-20" }} onChange={vi.fn()} now={now} />);
    expect(screen.getByLabelText(copy.range.from)).toHaveAttribute("max", "2026-09-20");
    expect(screen.getByLabelText(copy.range.to)).toHaveAttribute("min", "2026-09-01");
  });

  it("uses today instead of a typed date that is in the future", () => {
    const onChange = vi.fn();
    render(<DateRangeControls value={value} onChange={onChange} now={now} />);
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "2026-12-25" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: "2026-10-06" });
    fireEvent.change(screen.getByLabelText(copy.range.to), { target: { value: "2027-01-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, to: "2026-10-06" });
  });

  it("passes on a date that is not in the future, and a cleared one", () => {
    const onChange = vi.fn();
    render(<DateRangeControls value={{ ...value, from: "2026-09-01" }} onChange={onChange} now={now} />);
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "2026-09-15" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: "2026-09-15" });
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: null });
  });
});
