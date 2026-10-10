import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { Header } from "./Header";
import { mockFetch } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const auth = { mode: "gh-cli" as const, user: { login: "ada", avatarUrl: "" }, error: null };

function show(route: string) {
  mockFetch({ "GET /api/health": { body: {} }, "GET /api/repos": { body: [repo()] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Header auth={auth} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tab = (name: string) => screen.getByRole("link", { name });

describe("Header code analysis tab", () => {
  it("offers the tab between Repositories and Review queue, pointing at the list", () => {
    show("/repos");
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf(copy.nav.codeAnalysis)).toBe(links.indexOf(copy.nav.repositories) + 1);
    expect(tab(copy.nav.codeAnalysis)).toHaveAttribute("href", "/code");
  });

  it("is lit on the list page and Repositories is not", () => {
    show("/code");
    expect(tab(copy.nav.codeAnalysis)).toHaveClass("active");
    expect(tab(copy.nav.repositories)).not.toHaveClass("active");
  });

  it("is lit on a repository's code analysis page, where Repositories steps aside", () => {
    show("/repos/1/code");
    expect(tab(copy.nav.codeAnalysis)).toHaveClass("active");
    expect(tab(copy.nav.repositories)).not.toHaveClass("active");
  });

  it("leaves Repositories lit on the repository page itself", () => {
    show("/repos/1");
    expect(tab(copy.nav.repositories)).toHaveClass("active");
    expect(tab(copy.nav.codeAnalysis)).not.toHaveClass("active");
  });
});
