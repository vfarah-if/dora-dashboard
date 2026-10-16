import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "../api/client";
import { copy } from "../copy";
import { ErrorState, Skeleton } from "./States";

describe("ErrorState", () => {
  it.each([400, 404])("hides Try again for a %s, which asking again cannot change", (status) => {
    render(<ErrorState error={new ApiError(status, "bad request")} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("bad request");
    expect(screen.queryByRole("button", { name: copy.common.retry })).not.toBeInTheDocument();
  });

  it.each([401, 408, 429, 502, 0])("offers Try again for a %s", (status) => {
    render(<ErrorState error={new ApiError(status, "later")} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("offers Try again for an error that is not from the API", () => {
    render(<ErrorState error={new Error("boom")} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: copy.common.retry })).toBeInTheDocument();
  });

  it("shows no button when there is nothing to retry", () => {
    render(<ErrorState error={new ApiError(502, "later")} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a given message in place of the error's own text", () => {
    render(<ErrorState error={new Error("raw detail")} message="A house message" />);
    expect(screen.getByText("A house message")).toBeInTheDocument();
    expect(screen.queryByText("raw detail")).not.toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("announces its loading text politely", () => {
    render(<Skeleton label="Loading things" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading things");
  });

  it("leaves a decorative placeholder out of what a screen reader is told", () => {
    const { container } = render(<Skeleton decorative />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container).not.toHaveTextContent(copy.common.loading);
  });
});
