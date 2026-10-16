import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { Header } from "./Header";
import { mockFetch } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const auth = { mode: "gh-cli" as const, user: { login: "ada", avatarUrl: "" }, error: null };

function renderHeader(route: string) {
  mockFetch({ "GET /api/health": { body: {} }, "GET /api/repos": { body: [repo()] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Header auth={auth} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const show = (route: string) => void renderHeader(route);

const tab = (name: string) => screen.getByRole("link", { name });
/** What a screen reader is told, which has to agree with what is lit. */
const announced = (root: HTMLElement = document.body) =>
  within(root)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page" && link.closest("nav"))
    .map((link) => link.textContent);

describe("Header brand link", () => {
  it("does not light up on the home page beside the Why it matters tab", () => {
    show("/");
    const current = [...document.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(screen.getByRole("link", { name: copy.appName })).not.toHaveAttribute("aria-current");
  });
});

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
    expect(announced()).toEqual([copy.nav.codeAnalysis]);
  });

  it("leaves Repositories lit on the repository page itself", () => {
    show("/repos/1");
    expect(tab(copy.nav.repositories)).toHaveClass("active");
    expect(tab(copy.nav.codeAnalysis)).not.toHaveClass("active");
  });
});

describe("Header security tab", () => {
  const lit = () => screen.getAllByRole("link").filter((link) => link.classList.contains("active") && link.closest("nav"));

  it("sits directly after Code analysis and points at the list", () => {
    show("/repos");
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf(copy.nav.security)).toBe(links.indexOf(copy.nav.codeAnalysis) + 1);
    expect(tab(copy.nav.security)).toHaveAttribute("href", "/security");
  });

  it("is lit on the list page and nowhere else is", () => {
    show("/security");
    expect(lit().map((l) => l.textContent)).toEqual([copy.nav.security]);
  });

  it("is lit on a repository's security page, where Repositories steps aside", () => {
    show("/repos/1/security");
    expect(lit().map((l) => l.textContent)).toEqual([copy.nav.security]);
    expect(announced()).toEqual([copy.nav.security]);
    expect(tab(copy.nav.repositories)).not.toHaveAttribute("aria-current");
  });

  it("announces the list pages and the repository page as current, one tab at a time", () => {
    const { unmount } = renderHeader("/security");
    expect(announced()).toEqual([copy.nav.security]);
    unmount();
    const second = renderHeader("/repos/1");
    expect(announced()).toEqual([copy.nav.repositories]);
    second.unmount();
    renderHeader("/code");
    expect(announced()).toEqual([copy.nav.codeAnalysis]);
  });

  it("lights only Code analysis on the code page and only Repositories on the repository page", () => {
    const { unmount } = renderHeader("/repos/1/code");
    expect(lit().map((l) => l.textContent)).toEqual([copy.nav.codeAnalysis]);
    unmount();
    renderHeader("/repos/1");
    expect(lit().map((l) => l.textContent)).toEqual([copy.nav.repositories]);
  });
});

describe("Header menu at narrow widths", () => {
  const button = () => screen.getByRole("button", { name: copy.nav.menu });
  const menu = () => screen.queryByRole("navigation", { name: copy.nav.menuList });
  const names = (root: HTMLElement) =>
    within(root)
      .getAllByRole("link")
      .map((link) => link.textContent);

  it("offers a collapsed menu button, with no list in the page until it is opened", () => {
    show("/repos");
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(button()).toHaveAttribute("aria-controls", "app-menu");
    expect(menu()).not.toBeInTheDocument();
  });

  it("opens a list of the same links as the tabs, in the same order, including Security", async () => {
    const user = userEvent.setup();
    show("/repos");
    const tabs = names(screen.getByRole("navigation", { name: copy.nav.label }));
    await user.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "true");
    const list = menu()!;
    expect(list).toHaveAttribute("id", "app-menu");
    expect(names(list)).toEqual(tabs);
    expect(within(list).getByRole("link", { name: copy.nav.security })).toHaveAttribute("href", "/security");
  });

  it("lights the current page in the menu as it does in the tabs", async () => {
    const user = userEvent.setup();
    show("/repos/1/security");
    await user.click(button());
    const lit = within(menu()!)
      .getAllByRole("link")
      .filter((link) => link.classList.contains("active"))
      .map((link) => link.textContent);
    expect(lit).toEqual([copy.nav.security]);
    expect(announced(menu()!)).toEqual([copy.nav.security]);
  });

  it("closes when the button is pressed again", async () => {
    const user = userEvent.setup();
    show("/repos");
    await user.click(button());
    await user.click(button());
    expect(menu()).not.toBeInTheDocument();
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape and puts focus back on the button, and ignores other keys", async () => {
    const user = userEvent.setup();
    show("/repos");
    await user.click(button());
    await user.keyboard("{Tab}");
    await user.keyboard("a");
    expect(menu()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(menu()).not.toBeInTheDocument();
    expect(button()).toHaveFocus();
  });

  it("closes when a link is followed, and the page changes", async () => {
    const user = userEvent.setup();
    show("/repos");
    await user.click(button());
    await user.click(within(menu()!).getByRole("link", { name: copy.nav.security }));
    expect(menu()).not.toBeInTheDocument();
    expect(button()).toHaveAttribute("aria-expanded", "false");
    // The tabs now show Security as the current page, so the navigation did happen.
    expect(
      within(screen.getByRole("navigation", { name: copy.nav.label })).getByRole("link", { name: copy.nav.security }),
    ).toHaveClass("active");
  });

  it("closes when the link to the page already open is followed, where the page does not change", async () => {
    const user = userEvent.setup();
    show("/repos");
    await user.click(button());
    await user.click(within(menu()!).getByRole("link", { name: copy.nav.repositories }));
    expect(menu()).not.toBeInTheDocument();
  });

  it("can be reached by keyboard alone", async () => {
    const user = userEvent.setup();
    show("/repos");
    button().focus();
    await user.keyboard("{Enter}");
    expect(menu()).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(within(menu()!).getAllByRole("link")[0]).toHaveFocus();
  });

  it("is not offered to someone who is signed out, because there are no pages to reach", () => {
    mockFetch({ "GET /api/health": { body: {} }, "GET /api/repos": { body: [] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Header auth={{ mode: "gh-cli", user: null, error: null }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: copy.nav.menu })).not.toBeInTheDocument();
  });
});
