import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ACCEPTED_HEADING_ID, focusAcceptedHeading, setAcceptNotice, useAcceptNotice } from "./acceptNotice";

function Reader({ repoId = 1, onRender }: { repoId?: number; onRender?: (text: string | null) => void }) {
  const notice = useAcceptNotice(repoId);
  onRender?.(notice?.text ?? null);
  return <p data-sequence={notice?.sequence}>{notice?.text ?? "nothing"}</p>;
}

afterEach(() =>
  act(() => {
    setAcceptNotice(1, null);
    setAcceptNotice(2, null);
  }),
);

describe("the accept notice", () => {
  it("tells every reader when it is set and when it is cleared", () => {
    render(<Reader />);
    expect(screen.getByText("nothing")).toBeInTheDocument();
    act(() => setAcceptNotice(1, "Accepted."));
    expect(screen.getByText("Accepted.")).toBeInTheDocument();
    act(() => setAcceptNotice(1, null));
    expect(screen.getByText("nothing")).toBeInTheDocument();
  });

  it("holds a message for one repository and shows it to no other", () => {
    render(<Reader repoId={2} />);
    act(() => setAcceptNotice(1, "Accepted."));
    expect(screen.getByText("nothing")).toBeInTheDocument();
    act(() => setAcceptNotice(2, "Removed."));
    expect(screen.getByText("Removed.")).toBeInTheDocument();
  });

  it("gives the same words a new sequence each time they are set, so a repeat is a new message", () => {
    render(<Reader />);
    act(() => setAcceptNotice(1, "Accepted."));
    const first = screen.getByText("Accepted.").getAttribute("data-sequence");
    act(() => setAcceptNotice(1, "Accepted."));
    expect(screen.getByText("Accepted.").getAttribute("data-sequence")).not.toBe(first);
  });

  it("tells nobody when clearing a message that is not there", () => {
    const seen = vi.fn();
    render(<Reader onRender={seen} />);
    seen.mockClear();
    act(() => setAcceptNotice(1, null));
    expect(seen).not.toHaveBeenCalled();
    expect(screen.getByText("nothing")).toBeInTheDocument();
  });

  it("tells a reader once when a message is cleared that was there", () => {
    const seen = vi.fn();
    render(<Reader onRender={seen} />);
    act(() => setAcceptNotice(1, "Accepted."));
    seen.mockClear();
    act(() => setAcceptNotice(1, null));
    expect(seen).toHaveBeenLastCalledWith(null);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("stops telling a reader that has left, and goes on telling one that stays", () => {
    const left = vi.fn();
    const stays = vi.fn();
    const { unmount } = render(<Reader onRender={left} />);
    render(<Reader onRender={stays} />);
    unmount();
    left.mockClear();
    stays.mockClear();
    act(() => setAcceptNotice(1, "Later."));
    expect(left).not.toHaveBeenCalled();
    expect(stays).toHaveBeenLastCalledWith("Later.");
  });
});

describe("focusAcceptedHeading", () => {
  it("moves focus to the heading when there is one, and does nothing when there is none", () => {
    const before = document.activeElement;
    focusAcceptedHeading();
    expect(document.activeElement).toBe(before);
    render(
      <h2 id={ACCEPTED_HEADING_ID} tabIndex={-1}>
        Accepted findings
      </h2>,
    );
    focusAcceptedHeading();
    expect(screen.getByRole("heading", { name: "Accepted findings" })).toHaveFocus();
  });
});
