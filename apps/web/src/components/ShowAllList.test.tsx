import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copy } from "../copy";
import { ShowAllList } from "./ShowAllList";

const items = (limit: number) => (
  <ul>
    {Array.from({ length: limit }, (_, i) => (
      <li key={i}>item</li>
    ))}
  </ul>
);

const startPrint = () => act(() => void window.dispatchEvent(new Event("beforeprint")));

describe("ShowAllList", () => {
  it("shows the limit and the rest behind a button", async () => {
    const user = userEvent.setup();
    render(
      <ShowAllList total={7} limit={3}>
        {items}
      </ShowAllList>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: copy.space.showAll(7) }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("prints every entry by default, as the other pages do", () => {
    render(
      <ShowAllList total={7} limit={3}>
        {items}
      </ShowAllList>,
    );
    startPrint();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("prints only what the screen shows when told not to print everything, with a line for the rest", () => {
    render(
      <ShowAllList total={7} limit={3} printAll={false}>
        {items}
      </ShowAllList>,
    );
    startPrint();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(copy.space.printMore(4))).toHaveClass("print-only");
  });

  it("uses the note it is given for the printed line", () => {
    render(
      <ShowAllList total={7} limit={3} printAll={false} printNote={(n) => `${n} left`}>
        {items}
      </ShowAllList>,
    );
    expect(screen.getByText("4 left")).toBeInTheDocument();
  });

  it("prints no line when the whole list fits", () => {
    render(
      <ShowAllList total={3} limit={3} printAll={false}>
        {items}
      </ShowAllList>,
    );
    expect(screen.queryByText(/more, listed/)).not.toBeInTheDocument();
  });
});
