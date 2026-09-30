import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { mockFetch } from "./test/render";
import { copy } from "./copy";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App sign-in gate", () => {
  it("offers GitHub sign-in in OAuth mode", async () => {
    mockFetch({ "GET /api/auth/me": { body: { mode: "oauth", user: null, error: null } } });
    renderApp();
    const link = await screen.findByRole("link", { name: copy.auth.signInButton });
    expect(link).toHaveAttribute("href", "/api/auth/github/login");
  });

  it("tells the user to run gh auth login in CLI mode and shows the error", async () => {
    mockFetch({ "GET /api/auth/me": { body: { mode: "gh-cli", user: null, error: "gh is not authenticated" } } });
    renderApp();
    expect(await screen.findByText("gh is not authenticated")).toBeInTheDocument();
    expect(screen.getByText(copy.auth.ghCliCommand)).toBeInTheDocument();
  });

  it("shows the signed-in user, toggles the theme and signs out in OAuth mode", async () => {
    const user = userEvent.setup();
    let signedOut = false;
    mockFetch({
      "GET /api/auth/me": () => ({
        body: { mode: "oauth", user: signedOut ? null : { login: "ada", avatarUrl: "https://example.com/a.png" }, error: null },
      }),
      "GET /api/repos": { body: [] },
      "POST /api/auth/logout": () => {
        signedOut = true;
        return { status: 204 };
      },
    });
    renderApp();
    expect(await screen.findByText("ada")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: copy.home.title })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: copy.nav.repositories }));
    expect(await screen.findByRole("heading", { level: 1, name: copy.repos.title })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.theme.toDark }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: copy.theme.toLight }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByRole("button", { name: copy.auth.signOut }));
    expect(await screen.findByRole("link", { name: copy.auth.signInButton })).toBeInTheDocument();
  });

  it("shows an error when the API cannot be reached", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    renderApp();
    expect(await screen.findByText(copy.common.networkFailed)).toBeInTheDocument();
  });
});
