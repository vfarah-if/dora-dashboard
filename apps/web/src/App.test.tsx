import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { mockFetch } from "./test/render";
import { repo } from "./test/fixtures";
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

  describe("Jira navigation", () => {
    const signedIn = { body: { mode: "oauth", user: { login: "ada", avatarUrl: "" }, error: null } };

    it("links to the Jira spaces only when health says Jira is on", async () => {
      mockFetch({ "GET /api/auth/me": signedIn, "GET /api/health": { body: { jira: true } }, "GET /api/repos": { body: [] } });
      renderApp();
      expect(await screen.findByRole("link", { name: copy.nav.jira })).toHaveAttribute("href", "/spaces");
    });

    it("leaves the link out when Jira is off", async () => {
      mockFetch({ "GET /api/auth/me": signedIn, "GET /api/health": { body: { jira: false } }, "GET /api/repos": { body: [] } });
      renderApp();
      await screen.findByText("ada");
      expect(screen.queryByRole("link", { name: copy.nav.jira })).not.toBeInTheDocument();
    });

    it("opens the spaces page from the link", async () => {
      const user = userEvent.setup();
      mockFetch({
        "GET /api/auth/me": signedIn,
        "GET /api/health": { body: { jira: true } },
        "GET /api/repos": { body: [] },
        "GET /api/spaces": { body: [] },
      });
      renderApp();
      await user.click(await screen.findByRole("link", { name: copy.nav.jira }));
      expect(await screen.findByRole("heading", { level: 1, name: copy.spaces.title })).toBeInTheDocument();
    });
  });

  describe("GitHub Issues navigation", () => {
    const signedIn = { body: { mode: "oauth", user: { login: "ada", avatarUrl: "" }, error: null } };
    const health = { body: { jira: false } };

    it("links to the GitHub Issues page when a repository has issues", async () => {
      mockFetch({
        "GET /api/auth/me": signedIn,
        "GET /api/health": health,
        "GET /api/repos": { body: [repo({ id: 1, issues: 0 }), repo({ id: 2, issues: 7 })] },
      });
      renderApp();
      expect(await screen.findByRole("link", { name: copy.nav.issues })).toHaveAttribute("href", "/issues");
    });

    it("leaves the link out when no repository has issues", async () => {
      mockFetch({ "GET /api/auth/me": signedIn, "GET /api/health": health, "GET /api/repos": { body: [repo({ issues: 0 })] } });
      renderApp();
      await screen.findByText("ada");
      await screen.findByRole("heading", { level: 1, name: copy.home.title });
      expect(screen.queryByRole("link", { name: copy.nav.issues })).not.toBeInTheDocument();
    });

    it("leaves the link out when the repositories cannot be read", async () => {
      mockFetch({
        "GET /api/auth/me": signedIn,
        "GET /api/health": health,
        "GET /api/repos": { status: 500, body: { error: "boom" } },
      });
      renderApp();
      await screen.findByText("ada");
      expect(screen.queryByRole("link", { name: copy.nav.issues })).not.toBeInTheDocument();
    });

    it("shows no link, and does not ask for repositories, while signed out", async () => {
      const fetchMock = mockFetch({
        "GET /api/auth/me": { body: { mode: "oauth", user: null, error: null } },
        "GET /api/health": health,
      });
      renderApp();
      await screen.findByRole("link", { name: copy.auth.signInButton });
      expect(screen.queryByRole("link", { name: copy.nav.issues })).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/repos"))).toBe(false);
    });

    it("sits next to the Jira link and opens the GitHub Issues page", async () => {
      const user = userEvent.setup();
      mockFetch({
        "GET /api/auth/me": signedIn,
        "GET /api/health": { body: { jira: true } },
        "GET /api/repos": { body: [repo({ issues: 7 })] },
      });
      renderApp();
      const jira = await screen.findByRole("link", { name: copy.nav.jira });
      const issues = await screen.findByRole("link", { name: copy.nav.issues });
      expect(jira.nextElementSibling).toBe(issues);
      await user.click(issues);
      expect(await screen.findByRole("heading", { level: 1, name: copy.issues.title })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.issues.openReport("acme/widgets") })).toHaveAttribute("href", "/issues/1");
    });
  });
});
