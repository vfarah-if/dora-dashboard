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

  it("shows today at once when a future date is typed into a field already at today", () => {
    const onChange = vi.fn();
    const atToday = { ...value, from: "2026-10-06", to: "2026-10-06" };
    render(<DateRangeControls value={atToday} onChange={onChange} now={now} />);
    for (const label of [copy.range.to, copy.range.from]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "2099-01-01" } });
      expect(input.value).toBe("2026-10-06");
    }
    for (const [call] of onChange.mock.calls) {
      expect(call.from <= "2026-10-06" && call.to <= "2026-10-06").toBe(true);
    }
  });

  it("clears the end when the start typed in is after it", () => {
    const onChange = vi.fn();
    render(<DateRangeControls value={{ ...value, from: "2026-09-01", to: "2026-09-20" }} onChange={onChange} now={now} />);
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "2026-09-25" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: "2026-09-25", to: null });
  });

  it("clears the start when the end typed in is before it", () => {
    const onChange = vi.fn();
    render(<DateRangeControls value={{ ...value, from: "2026-09-10", to: "2026-09-20" }} onChange={onChange} now={now} />);
    fireEvent.change(screen.getByLabelText(copy.range.to), { target: { value: "2026-09-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: null, to: "2026-09-01" });
  });

  it("passes on a date that is not in the future, and a cleared one", () => {
    const onChange = vi.fn();
    render(<DateRangeControls value={{ ...value, from: "2026-09-01" }} onChange={onChange} now={now} />);
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "2026-09-15" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: "2026-09-15" });
    fireEvent.change(screen.getByLabelText(copy.range.from), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, from: null });
  });

  describe("typing a year", () => {
    const both = { ...value, from: "2026-01-01", to: "2026-09-20" };

    it("does not report a half-typed year, so the other date is left alone", () => {
      const onChange = vi.fn();
      render(<DateRangeControls value={both} onChange={onChange} now={now} />);
      const to = screen.getByLabelText(copy.range.to) as HTMLInputElement;
      for (const partial of ["0002-09-20", "0020-09-20", "0202-09-20"]) {
        fireEvent.change(to, { target: { value: partial } });
        expect(to.value).toBe(partial);
      }
      expect(onChange).not.toHaveBeenCalled();
    });

    it("releases the start when the year is complete and the date precedes it", () => {
      const onChange = vi.fn();
      render(<DateRangeControls value={both} onChange={onChange} now={now} />);
      const to = screen.getByLabelText(copy.range.to);
      fireEvent.change(to, { target: { value: "0202-09-20" } });
      fireEvent.change(to, { target: { value: "2025-09-20" } });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith({ ...value, from: null, to: "2025-09-20" });
    });

    it("keeps the start when the complete year puts the end after it", () => {
      const onChange = vi.fn();
      render(<DateRangeControls value={both} onChange={onChange} now={now} />);
      fireEvent.change(screen.getByLabelText(copy.range.to), { target: { value: "2026-09-25" } });
      expect(onChange).toHaveBeenLastCalledWith({ ...both, to: "2026-09-25" });
    });

    it("shows the held value again on leaving a field with an incomplete year", () => {
      const onChange = vi.fn();
      render(<DateRangeControls value={both} onChange={onChange} now={now} />);
      const to = screen.getByLabelText(copy.range.to) as HTMLInputElement;
      fireEvent.change(to, { target: { value: "0202-09-20" } });
      fireEvent.blur(to);
      expect(to.value).toBe("2026-09-20");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("follows the value when it changes from outside, such as a preset", () => {
      const { rerender } = render(<DateRangeControls value={both} onChange={vi.fn()} now={now} />);
      rerender(<DateRangeControls value={{ ...both, to: "2026-09-30" }} onChange={vi.fn()} now={now} />);
      expect((screen.getByLabelText(copy.range.to) as HTMLInputElement).value).toBe("2026-09-30");
    });
  });
});
