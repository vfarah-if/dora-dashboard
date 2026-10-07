import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueLabelsPanel } from "./IssueLabelsPanel";
import { mockFetch, renderRoute } from "../test/render";
import { useIssueReport, useRepos } from "../api/hooks";
import { issueLabelDefaults, issueReport, repo } from "../test/fixtures";
import { copy } from "../copy";

function setup(
  listing = repo({ issues: 12 }),
  response: { status?: number; body?: unknown } = { body: listing },
  defaults: { status?: number; body?: unknown } = { body: issueLabelDefaults() },
) {
  let body: unknown = "not sent";
  const fetchMock = mockFetch({
    "GET /api/repos": { body: [listing] },
    "GET /api/issue-labels/defaults": defaults,
    "PUT /api/repos/1/issue-labels": (_url, init) => {
      body = JSON.parse(String(init?.body));
      return response;
    },
  });
  renderRoute(<IssueLabelsPanel repo={listing} />);
  return { sent: () => body, fetchMock, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label);

/** Save is off until the defaults have loaded, so a test that presses it waits for that. */
const saveButton = async () => {
  const button = screen.getByRole("button", { name: copy.issueLabels.save });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
};

describe("IssueLabelsPanel", () => {
  it("has one box per kind and per priority, with the default names as placeholders", async () => {
    setup();
    await waitFor(() =>
      expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveAttribute("placeholder", "bug, defect, regression"),
    );
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
    await user.click(await saveButton());
    expect(await screen.findByText(copy.issueLabels.saved)).toBeInTheDocument();
    expect(sent()).toEqual({ labels: { kinds: { bug: ["broken", "defect"] }, priorities: { P1: ["sev2"] } } });
  });

  it("sends null when every box is empty", async () => {
    const { user, sent } = setup();
    await user.click(await saveButton());
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
      "GET /api/issue-labels/defaults": { body: issueLabelDefaults() },
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
    await user.click(await saveButton());
    await waitFor(() => expect(reads).toEqual({ repos: 2, report: 2 }));
    const methods = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0])}`);
    expect(methods.some((m) => m.includes("crawl"))).toBe(false);
  });

  it("shows the API's reason and no saved message when the save is refused", async () => {
    const { user } = setup(repo({ issues: 12 }), { status: 400, body: { error: "labels.kinds.bug has too many names" } });
    await user.type(field(copy.issueLabels.kindLabel("Bug")), "a");
    await user.click(await saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("labels.kinds.bug has too many names");
    expect(screen.queryByText(copy.issueLabels.saved)).not.toBeInTheDocument();
  });

  it("shows the error when a reset fails", async () => {
    const { user } = setup(repo({ issues: 12 }), { status: 500, body: { error: "boom" } });
    await user.click(screen.getByRole("button", { name: copy.issueLabels.reset }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText(copy.issueLabels.resetDone)).not.toBeInTheDocument();
  });

  it("disables Save and says why when a box holds more names than the defaults route allows", async () => {
    const defaults = { ...issueLabelDefaults(), limits: { names: 3, length: 100 } };
    const { user, sent } = setup(repo({ issues: 12 }), undefined, { body: defaults });
    await saveButton();
    const box = field(copy.issueLabels.kindLabel("Bug"));
    await user.click(box);
    await user.paste("a,b,c,d");
    expect(screen.getByText(copy.issueLabels.tooMany(3))).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeDisabled();
    expect(sent()).toBe("not sent");
  });

  it("says when a name is longer than the defaults route allows", async () => {
    const defaults = { ...issueLabelDefaults(), limits: { names: 30, length: 8 } };
    const { user } = setup(repo({ issues: 12 }), undefined, { body: defaults });
    await saveButton();
    await user.click(field(copy.issueLabels.priorityLabel("P2")));
    await user.paste("x".repeat(9));
    expect(screen.getByText(copy.issueLabels.tooLong(8))).toBeInTheDocument();
    expect(
      within(screen.getByRole("form", { name: copy.issueLabels.title })).getByRole("button", { name: copy.issueLabels.save }),
    ).toBeDisabled();
  });

  it("says when a name holds a control character and keeps Save off", async () => {
    setup();
    await saveButton();
    const box = field(copy.issueLabels.kindLabel("Feature"));
    fireEvent.change(box, { target: { value: "good, bad\u0001name" } });
    expect(screen.getByText(copy.issueLabels.control)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeDisabled();
    fireEvent.change(box, { target: { value: "good" } });
    expect(screen.queryByText(copy.issueLabels.control)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeEnabled();
  });

  it("holds Save off, with no placeholders, while the defaults load", async () => {
    setup();
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeDisabled();
    expect(screen.getByText(copy.issueLabels.loadingDefaults)).toBeInTheDocument();
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveAttribute("placeholder", "");
    await saveButton();
    expect(screen.queryByText(copy.issueLabels.loadingDefaults)).not.toBeInTheDocument();
  });

  it("shows the error, keeps Save off and loads the defaults on retry when the first read fails", async () => {
    let calls = 0;
    const user = userEvent.setup();
    const listing = repo({ issues: 12 });
    mockFetch({
      "GET /api/repos": { body: [listing] },
      "GET /api/issue-labels/defaults": () => {
        calls += 1;
        return calls === 1 ? { status: 500, body: { error: "defaults unavailable" } } : { body: issueLabelDefaults() };
      },
    });
    renderRoute(<IssueLabelsPanel repo={listing} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("defaults unavailable");
    expect(screen.getByRole("button", { name: copy.issueLabels.save })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: copy.common.retry }));
    await saveButton();
    expect(field(copy.issueLabels.kindLabel("Bug"))).toHaveAttribute("placeholder", "bug, defect, regression");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns that saved names could not be read, so the defaults apply until they are saved again", () => {
    setup(repo({ issues: 12, issueLabelsUnreadable: true }));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.issueLabels.unreadable);
  });

  it("shows no unreadable warning when the saved names could be read", () => {
    setup();
    expect(screen.queryByText(copy.issueLabels.unreadable)).not.toBeInTheDocument();
  });
});
