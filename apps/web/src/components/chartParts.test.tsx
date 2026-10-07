import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BarShapeProps } from "recharts";
import { categoryAxisProps, CHART_HEIGHT, ChartTooltip, endLabel, weekZoom, WeeklyCountBar } from "./chartParts";

describe("ChartTooltip", () => {
  it("lists each numeric value with the formatted label and hides when inactive", () => {
    const payload = [
      { name: "acme/widgets", value: 5, color: "var(--series-1)", dataKey: "r1" },
      { name: "acme/gadgets", value: null, color: "var(--series-2)", dataKey: "r2" },
    ];
    const { rerender, container } = render(
      <ChartTooltip
        active
        label="2026-01-05"
        payload={payload}
        formatLabel={(l) => `Week of ${l}`}
        formatValue={(v) => `${v} h`}
      />,
    );
    expect(screen.getByText("Week of 2026-01-05")).toBeInTheDocument();
    expect(screen.getByText("5 h")).toBeInTheDocument();
    expect(screen.queryByText("acme/gadgets")).not.toBeInTheDocument();
    rerender(<ChartTooltip active={false} label="x" payload={payload} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("endLabel", () => {
  it("draws text only at the last point of a line", () => {
    const Label = endLabel("widgets", 2);
    const { container } = render(
      <svg>
        <Label x={10} y={20} index={1} />
        <Label x={30} y={40} index={2} />
      </svg>,
    );
    const texts = container.querySelectorAll("text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toHaveTextContent("widgets");
    expect(texts[0]).toHaveAttribute("stroke", "none");
  });
});

describe("categoryAxisProps", () => {
  it("sizes the axis to the longest name and leaves short names whole", () => {
    const { width, tickFormatter } = categoryAxisProps(["widgets", "gadgets-service"]);
    expect(width).toBe(15 * 7 + 12);
    expect(tickFormatter("gadgets-service")).toBe("gadgets-service");
  });

  it("keeps a floor for very short names", () => {
    expect(categoryAxisProps(["a"]).width).toBe(60);
    expect(categoryAxisProps([]).width).toBe(60);
  });

  it("caps the width and cuts longer names with an ellipsis so they stay inside the card", () => {
    const long = "a-very-long-repository-name-that-will-not-fit";
    const { width, tickFormatter } = categoryAxisProps([long, "widgets"]);
    expect(width).toBe(200);
    const shown = tickFormatter(long);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBe(Math.floor((200 - 12) / 7));
    expect(tickFormatter("widgets")).toBe("widgets");
  });
});

describe("weekZoom", () => {
  it("adds no slider when every week fits", () => {
    expect(weekZoom(26)).toBeNull();
  });

  it("opens a long chart on the latest 26 weeks and makes room for the slider", () => {
    const zoom = weekZoom(110)!;
    expect(zoom.brush).toMatchObject({ dataKey: "week", startIndex: 84, endIndex: 109 });
    expect(zoom.height).toBeGreaterThan(CHART_HEIGHT);
    expect(zoom.brush.tickFormatter("2026-03-23")).toBe("23 Mar");
  });
});

describe("WeeklyCountBar", () => {
  const bar = (partial: boolean) =>
    ({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      fill: "var(--series-1)",
      payload: { week: "2026-03-09", partial },
    }) as unknown as BarShapeProps;

  it("draws a whole week's count at full strength with no outline", () => {
    const { container } = render(
      <svg>
        <WeeklyCountBar {...bar(false)} />
      </svg>,
    );
    const path = container.querySelector("path");
    expect(path).toHaveAttribute("fill", "var(--series-1)");
    expect(path).not.toHaveAttribute("fill-opacity");
    expect(path).not.toHaveAttribute("stroke");
  });

  it("draws a part week's count lighter, inside an outline in the series colour", () => {
    const { container } = render(
      <svg>
        <WeeklyCountBar {...bar(true)} />
      </svg>,
    );
    const path = container.querySelector("path");
    expect(path).toHaveAttribute("fill", "var(--series-1)");
    expect(path).toHaveAttribute("fill-opacity", "0.35");
    expect(path).toHaveAttribute("stroke", "var(--series-1)");
  });
});
