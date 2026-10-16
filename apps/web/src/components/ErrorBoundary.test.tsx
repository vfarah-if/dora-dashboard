import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { ErrorBoundary } from "./ErrorBoundary";
import { copy } from "../copy";

let broken = true;

function Fragile() {
  if (broken) throw new Error("secret internal detail");
  return <p>All well</p>;
}

function Shell() {
  const { pathname, search } = useLocation();
  return (
    <>
      <nav aria-label="Menu">
        <Link to="/other">Other page</Link>
        <Link to="/?page=2">Next page</Link>
      </nav>
      <main>
        <ErrorBoundary resetKey={pathname + search}>
          <Fragile />
        </ErrorBoundary>
      </main>
    </>
  );
}

function ShellWith({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  return <ErrorBoundary resetKey={pathname + search}>{children}</ErrorBoundary>;
}

beforeEach(() => {
  broken = true;
  // React logs a caught render error; it is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("shows the house message, never the raw error, and leaves the menu in place", () => {
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(copy.common.pageFailed);
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeInTheDocument();
  });

  it("shows the page again after Try again once the fault has gone", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    broken = false;
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(screen.getByText("All well")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts afresh when the route changes", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken = false;
    await user.click(screen.getByRole("link", { name: "Other page" }));
    expect(screen.getByText("All well")).toBeInTheDocument();
  });

  it("starts afresh when only the search changes", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken = false;
    await user.click(screen.getByRole("link", { name: "Next page" }));
    expect(screen.getByText("All well")).toBeInTheDocument();
  });

  it("keeps the page mounted, with its state, when only the path changes", async () => {
    broken = false;
    let mounts = 0;
    function Counted() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <p>Counted page</p>;
    }
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <nav>
          <Link to="/repos/2">Second</Link>
        </nav>
        <ShellWith>
          <Counted />
        </ShellWith>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("link", { name: "Second" }));
    expect(mounts).toBe(1);
  });
});
