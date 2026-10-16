import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { mockFetch } from "./test/render";
import { copy } from "./copy";

// A page that cannot draw itself, so the boundary around the routes has something to catch.
vi.mock("./pages/ReposPage", () => ({
  ReposPage: () => {
    throw new Error("secret internal detail");
  },
}));

beforeEach(() => {
  // React logs a render error it has caught; it is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("App page failures", () => {
  it("keeps the header usable when a page fails and shows the next page once the route changes", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/auth/me": { body: { mode: "oauth", user: { login: "ada", avatarUrl: "" }, error: null } },
      "GET /api/health": { body: { jira: false } },
      "GET /api/repos": { body: [] },
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/repos"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(copy.common.pageFailed)).toBeInTheDocument();
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument();

    // The failure belongs to the page that failed, so going elsewhere must not leave its message standing.
    await user.click(screen.getByRole("link", { name: copy.nav.home }));
    expect(await screen.findByRole("heading", { level: 1, name: copy.home.title })).toBeInTheDocument();
    expect(screen.queryByText(copy.common.pageFailed)).not.toBeInTheDocument();
  });

  it("shows the sign-in form after signing out from a page that failed", async () => {
    const user = userEvent.setup();
    let signedIn = true;
    mockFetch({
      "GET /api/auth/me": () => ({
        body: { mode: "oauth", user: signedIn ? { login: "ada", avatarUrl: "" } : null, error: null },
      }),
      "POST /api/auth/logout": () => {
        signedIn = false;
        return { status: 204 };
      },
      "GET /api/health": { body: { jira: false } },
      "GET /api/repos": { body: [] },
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/repos"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(copy.common.pageFailed)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.auth.signOut }));
    expect(await screen.findByRole("link", { name: copy.auth.signInButton })).toBeInTheDocument();
    expect(screen.queryByText(copy.common.pageFailed)).not.toBeInTheDocument();
  });
});
