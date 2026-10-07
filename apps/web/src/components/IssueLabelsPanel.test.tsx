import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueLabelsPanel } from "./IssueLabelsPanel";
import { mockFetch, renderRoute } from "../test/render";
import { useIssueReport, useRepos } from "../api/hooks";
import { issueReport, repo } from "../test/fixtures";
import { copy } from "../copy";

function setup(listing = repo({ issues: 12 }), response: { status?: number; body?: unknown } = { body: listing }) {
  let body: unknown = "not sent";
  const fetchMock = mockFetch({
    "GET /api/repos": { body: [listing] },
    "PUT /api/repos/1/issue-labels": (_url, init) => {
      body = JSON.parse(String(init?.body));
      return response;
    },
  });
  renderRoute(<IssueLabelsPanel repo={listing} />);
  return { sent: () => body, fetchMock, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label);

describe("IssueLabelsPanel", () => {
  it("has one box per kind and per priority, with the default names as placeholders", () => {
    setup();
    const kinds = ["Bug", "Feature", "Maintenance", "Incident", "Security", "Epic"];
    for (const kind of kinds) expect(field(copy.issueLabels.kindLabel(kind))).toBeInTheDocument();
    for (const priority of ["P0", "P1", "P2", "P3", "P4"]) {
      expect(field(copy.issueLabels.priorityLabel(priority))).toBeInTheDocument();
    }
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveAttribute("placeholder", "bug, defect, regression");
    expect(field(copy.issueLabels.priorityLabel("P0"))).toHaveAttribute("placeholder", "p0, critical, urgent, blocker");
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveValue("");
  });

  it("explains that changes apply straight away with no crawl", () => {
    setup();
    expect(screen.getByText(copy.issueLabels.applyNote)).toBeInTheDocument();
  });

  it("starts from the repository's current override", () => {
    setup(repo({ issues: 12, issueLabels: { kinds: { bug: ["broken", "defect"] }, priorities: { P0: ["sev1"] } } }));
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveValue("broken, defect");
    expect(field(copy.issueLabels.priorityLabel("P0"))).toHaveValue("sev1");
    expect(field(copy.issueLabels.kindLabel("Feature"))).toHaveValue("");
  });

  it("sends only the boxes that were filled in, with names trimmed and split on commas", async () => {
    const { user, sent } = setup();
    await user.type(field(copy.issueLabels.kindLabel("Bug")), " broken ,  defect,, ");
    await user.type(field(copy.issueLabels.priorityLabel("P1")), "sev2");
    await user.click(screen.getByRole("button", { name: copy.issueLabels.save }));
    expect(await screen.findByText(copy.issueLabels.saved)).toBeInTheDocument();
    expect(sent()).toEqual({ labels: { kinds: { bug: ["broken", "defect"] }, priorities: { P1: ["sev2"] } } });
  });

  it("sends null when every box is empty", async () => {
    const { user, sent } = setup();
    await user.click(screen.getByRole("button", { name: copy.issueLabels.save }));
    expect(await screen.findByText(copy.issueLabels.saved)).toBeInTheDocument();
    expect(sent()).toEqual({ labels: null });
  });

  it("clears the boxes and sends null when reset to defaults", async () => {
    const { user, sent } = setup(repo({ issues: 12, issueLabels: { kinds: { bug: ["broken"] } } }));
    await user.click(screen.getByRole("button", { name: copy.issueLabels.reset }));
    expect(await screen.findByText(copy.issueLabels.resetDone)).toBeInTheDocument();
    expect(sent()).toEqual({ labels: null });
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveValue("");
  });

  it("reads the repositories and the report again after a save, with no crawl", async () => {
    const listing = repo({ issues: 12 });
    const reads = { repos: 0, report: 0 };
    const user = userEvent.setup();
    const fetchMock = mockFetch({
      "GET /api/repos": () => {
        reads.repos += 1;
        return { body: [listing] };
      },
      "GET /api/repos/1/issues/report": () => {
        reads.report += 1;
        return { body: issueReport() };
      },
      "PUT /api/repos/1/issue-labels": { body: listing },
    });
    // The list and the report are asked for by the page around the panel, so the panel only has to invalidate them.
    function Around() {
      useRepos();
      useIssueReport(1, { from: null, to: null }, false);
      return <IssueLabelsPanel repo={listing} />;
    }
    renderRoute(<Around />);
    await waitFor(() => expect(reads).toEqual({ repos: 1, report: 1 }));
    await user.click(screen.getByRole("button", { name: copy.issueLabels.save }));
    await waitFor(() => expect(reads).toEqual({ repos: 2, report: 2 }));
    const methods = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0])}`);
    expect(methods.some((m) => m.includes("crawl"))).toBe(false);
  });

  it("shows the API's reason and no saved message when the save is refused", async () => {
    const { user } = setup(repo({ issues: 12 }), { status: 400, body: { error: "labels.kinds.bug has too many names" } });
    await user.type(field(copy.issueLabels.kindLabel("Bug")), "a");
    await user.click(screen.getByRole("button", { name: copy.issueLabels.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("labels.kinds.bug has too many names");
    expect(screen.queryByText(copy.issueLabels.saved)).not.toBeInTheDocument();
  });

  it("shows the error when a reset fails", async () => {
    const { user } = setup(repo({ issues: 12 }), { status: 500, body: { error: "boom" } });
    await user.click(screen.getByRole("button", { name: copy.issueLabels.reset }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText(copy.issueLabels.resetDone)).not.toBeInTheDocument();
  });

  it("disables Save and says why when a box holds more names than the API allows", async () => {
    const { user, sent } = setup();
    const box = field(copy.issueLabels.kindLabel("Bug"));
    await user.click(box);
    await user.paste(Array.from({ length: 31 }, (_, i) => `l${i}`).join(","));
    expect(screen.getByText(copy.issueLabels.tooMany(30))).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeDisabled();
    expect(sent()).toBe("not sent");
  });

  it("says when a name is too long", async () => {
    const { user } = setup();
    await user.click(field(copy.issueLabels.priorityLabel("P2")));
    await user.paste("x".repeat(101));
    expect(screen.getByText(copy.issueLabels.tooLong(100))).toBeInTheDocument();
    expect(
      within(screen.getByRole("form", { name: copy.issueLabels.title })).getByRole("button", { name: copy.issueLabels.save }),
    ).toBeDisabled();
  });
});
