import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssuesPage } from "./IssuesPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

const route = { path: "/issues", route: "/issues" };

describe("IssuesPage", () => {
  it("lists only the repositories that have issues, each with its facts and a link to its report", async () => {
    mockFetch({
      "GET /api/repos": {
        body: [
          repo({ id: 1, issues: 1234 }),
          repo({ id: 2, name: "gadgets", issues: 0 }),
          repo({ id: 3, name: "doodads", issues: 5, lastCrawledAt: null }),
        ],
      },
    });
    renderRoute(<IssuesPage />, route);
    const widgets = (await screen.findByRole("link", { name: copy.issues.openReport("acme/widgets") })).closest("li")!;
    expect(screen.getByRole("link", { name: copy.issues.openReport("acme/widgets") })).toHaveAttribute("href", "/issues/1");
    expect(within(widgets).getByText("1,234")).toBeInTheDocument();
    expect(within(widgets).getByText("1 Mar 2026, 10:00")).toBeInTheDocument();
    const doodads = screen.getByRole("link", { name: copy.issues.openReport("acme/doodads") }).closest("li")!;
    expect(within(doodads).getByText(copy.issues.neverCrawled)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /gadgets/ })).not.toBeInTheDocument();
  });

  it("shows why the last read of issues failed beside the repository", async () => {
    mockFetch({ "GET /api/repos": { body: [repo({ issues: 3, issueError: "GitHub answered 502" })] } });
    renderRoute(<IssuesPage />, route);
    expect(await screen.findByText(copy.issues.errorTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issues.errorReason("GitHub answered 502"))).toBeInTheDocument();
  });

  it("shows no failure notice for a repository whose read succeeded", async () => {
    mockFetch({ "GET /api/repos": { body: [repo({ issues: 3 })] } });
    renderRoute(<IssuesPage />, route);
    await screen.findByRole("link", { name: copy.issues.openReport("acme/widgets") });
    expect(screen.queryByText(copy.issues.errorTitle)).not.toBeInTheDocument();
  });

  it("explains that issues are read during each crawl, and links to repositories, when none have issues", async () => {
    mockFetch({ "GET /api/repos": { body: [repo({ issues: 0 })] } });
    renderRoute(<IssuesPage />, route);
    expect(await screen.findByText(copy.issues.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.issues.emptyBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.issues.toRepos })).toHaveAttribute("href", "/repos");
  });

  it("shows a loading state first", () => {
    mockFetch({ "GET /api/repos": () => new Promise(() => undefined) });
    renderRoute(<IssuesPage />, route);
    expect(screen.getByRole("status")).toHaveTextContent(copy.issues.loading);
  });

  it("shows the error with a retry that reads the list again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockFetch({
      "GET /api/repos": () => (++calls === 1 ? { status: 500, body: { error: "boom" } } : { body: [repo({ issues: 2 })] }),
    });
    renderRoute(<IssuesPage />, route);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByRole("link", { name: copy.issues.openReport("acme/widgets") })).toBeInTheDocument();
  });
});
