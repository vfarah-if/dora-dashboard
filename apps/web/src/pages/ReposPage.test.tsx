import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReposPage } from "./ReposPage";
import { mockFetch, renderRoute } from "../test/render";
import { repo } from "../test/fixtures";
import { copy } from "../copy";

describe("ReposPage", () => {
  it("posts the repository, workflows and branch, and shows the API error on a 404", async () => {
    const user = userEvent.setup();
    let posted: unknown;
    mockFetch({
      "GET /api/repos": { body: [] },
      "POST /api/repos": (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return { status: 404, body: { error: "acme/gadgets was not found, or your GitHub account cannot see it" } };
      },
    });
    renderRoute(<ReposPage />);

    expect(await screen.findByText(copy.repos.emptyTitle)).toBeInTheDocument();
    await user.type(screen.getByLabelText(copy.repos.repoLabel), "acme/gadgets");
    await user.type(screen.getByLabelText(copy.repos.workflowLabel), "deploy.yml, release.yml");
    await user.type(screen.getByLabelText(copy.repos.branchLabel), "trunk");
    await user.click(screen.getByRole("button", { name: copy.repos.addButton }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "acme/gadgets was not found, or your GitHub account cannot see it",
    );
    expect(posted).toEqual({ repo: "acme/gadgets", deployWorkflows: ["deploy.yml", "release.yml"], deployBranch: "trunk" });
  });

  it("sends only the repository when the optional fields are empty and confirms the addition", async () => {
    const user = userEvent.setup();
    let posted: unknown;
    mockFetch({
      "GET /api/repos": { body: [] },
      "POST /api/repos": (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return { status: 201, body: repo({ owner: "acme", name: "gadgets" }) };
      },
    });
    renderRoute(<ReposPage />);
    await user.type(await screen.findByLabelText(copy.repos.repoLabel), "  acme/gadgets ");
    await user.click(screen.getByRole("button", { name: copy.repos.addButton }));
    expect(await screen.findByText(copy.repos.added("acme/gadgets"))).toBeInTheDocument();
    expect(posted).toEqual({ repo: "acme/gadgets" });
    expect(screen.getByLabelText(copy.repos.repoLabel)).toHaveValue("");
  });

  it("shows crawl progress while a repository is crawling", async () => {
    mockFetch({
      "GET /api/repos": {
        body: [repo({ crawlStatus: "crawling", crawlProgress: "Fetched 200 pull requests", lastCrawledAt: null })],
      },
    });
    renderRoute(<ReposPage />);
    expect(await screen.findByText("Fetched 200 pull requests")).toBeInTheDocument();
    expect(screen.getByText(copy.repos.status.crawling)).toBeInTheDocument();
    expect(screen.getByText(copy.repos.neverCrawled)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.repos.recrawl })).toBeDisabled();
  });

  it("shows a failed crawl's error", async () => {
    mockFetch({ "GET /api/repos": { body: [repo({ crawlStatus: "failed", crawlError: "GitHub rate limit reached" })] } });
    renderRoute(<ReposPage />);
    expect(await screen.findByText("GitHub rate limit reached")).toBeInTheDocument();
    expect(screen.getByText(copy.repos.status.failed)).toBeInTheDocument();
  });

  it("starts a full re-crawl and removes a repository after confirmation", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    mockFetch({
      "GET /api/repos": { body: [repo()] },
      "POST /api/repos/1/crawl": (url) => {
        calls.push(`crawl ${url.search}`);
        return { status: 202, body: { ok: true } };
      },
      "DELETE /api/repos/1": () => {
        calls.push("delete");
        return { status: 204 };
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderRoute(<ReposPage />);
    await user.click(await screen.findByRole("button", { name: copy.repos.fullRecrawl }));
    await user.click(screen.getByRole("button", { name: copy.repos.recrawl }));
    await user.click(screen.getByRole("button", { name: copy.repos.remove }));
    await waitFor(() => expect(calls).toEqual(["crawl ?full=1", "crawl ", "delete"]));
    expect(window.confirm).toHaveBeenCalledWith(copy.repos.confirmRemove("acme/widgets"));
  });

  it("configures deploy workflows from the repository's workflow list", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    mockFetch({
      "GET /api/repos": { body: [repo({ deployWorkflows: [] })] },
      "GET /api/repos/1/workflows": { body: ["ci.yml", "deploy.yml"] },
      "PATCH /api/repos/1": (_url, init) => {
        patched = JSON.parse(String(init?.body));
        return { body: repo() };
      },
    });
    renderRoute(<ReposPage />);
    expect(await screen.findByText(copy.repos.noDeployWorkflow)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.repos.configure }));
    await user.click(await screen.findByRole("checkbox", { name: "deploy.yml" }));
    const branch = screen.getByLabelText(copy.configure.branchLabel);
    await user.clear(branch);
    await user.type(branch, "release");
    await user.click(screen.getByRole("button", { name: copy.common.save }));
    expect(await screen.findByText(copy.configure.saved)).toBeInTheDocument();
    expect(patched).toEqual({ deployWorkflows: ["deploy.yml"], deployBranch: "release" });
    await user.click(screen.getByRole("button", { name: copy.common.close }));
    expect(screen.queryByText(copy.configure.saved)).not.toBeInTheDocument();
  });

  it("enables Compare once two repositories are picked and goes to the compare page", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /api/repos": { body: [repo(), repo({ id: 2, name: "gadgets" }), repo({ id: 3, name: "gizmos" })] },
    });
    renderRoute(<ReposPage />);
    const compare = await screen.findByRole("button", { name: copy.repos.compareButton });
    expect(compare).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: copy.repos.selectForCompare("acme/gadgets") }));
    await user.click(screen.getByRole("checkbox", { name: copy.repos.selectForCompare("acme/widgets") }));
    expect(screen.getByText(copy.repos.compareSelected(2))).toBeInTheDocument();
    expect(compare).toBeEnabled();
    await user.click(compare);
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });

  it("shows the API error when the list cannot be loaded", async () => {
    mockFetch({ "GET /api/repos": { status: 401, body: { error: "Sign in with GitHub first" } } });
    renderRoute(<ReposPage />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Sign in with GitHub first")).toBeInTheDocument();
  });

  it.each(["denied", "error", "expired", "misconfigured", "rate_limited"] as const)(
    "shows the Jira %s outcome when the sign-in lands on the repositories page, and clears it when dismissed",
    async (outcome) => {
      const user = userEvent.setup();
      mockFetch({ "GET /api/repos": { body: [] }, "GET /api/health": { body: { jira: true } } });
      renderRoute(<ReposPage />, { route: `/?jira=${outcome}` });
      expect(await screen.findByText(copy.jira.outcomes[outcome].title)).toBeInTheDocument();
      expect(screen.getByText(copy.jira.outcomes[outcome].body)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: copy.jira.dismiss }));
      expect(screen.queryByText(copy.jira.outcomes[outcome].title)).not.toBeInTheDocument();
    },
  );

  it("shows no Jira outcome when Jira is switched off", async () => {
    mockFetch({ "GET /api/repos": { body: [] }, "GET /api/health": { body: { jira: false } } });
    renderRoute(<ReposPage />, { route: "/?jira=error" });
    expect(await screen.findByText(copy.repos.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.jira.outcomes.error.title)).not.toBeInTheDocument();
  });
});
