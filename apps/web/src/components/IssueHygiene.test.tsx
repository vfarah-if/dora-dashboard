import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STALE_URGENT_DAYS } from "@dora-dashboard/core";
import type { IssueHygieneFinding, IssueRef } from "@dora-dashboard/core";
import { IssueHygiene } from "./IssueHygiene";
import { issueReport } from "../test/fixtures";
import { copy } from "../copy";

const card = (title: string) => screen.getByRole("region", { name: title });

const ref = (number: number, assignee?: string | null): IssueRef => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  kind: "bug",
  priority: null,
  assigned: assignee !== undefined && assignee !== null,
  ...(assignee === undefined ? {} : { assignee }),
});

describe("IssueHygiene", () => {
  it("shows one card per check in the fixed order, whatever order the findings arrive in", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(
      Object.values(copy.issue.hygiene.checks).map((c) => c.title),
    );
  });

  it("shows the count, the share when there is one, and the plain explanation", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    const closed = card(copy.issue.hygiene.checks.closed_without_pr.title);
    // 3 of 12 closed issues is 25%.
    expect(within(closed).getByText(copy.issue.hygiene.foundOf(3, 12, "25%"))).toBeInTheDocument();
    expect(within(closed).getByText(copy.issue.hygiene.checks.closed_without_pr.explanation)).toBeInTheDocument();
    const reopened = card(copy.issue.hygiene.checks.reopened.title);
    expect(within(reopened).getByText(copy.issue.hygiene.found(1))).toBeInTheDocument();
  });

  it("names the number of days core uses in the stale urgent explanation", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    const stale = card(copy.issue.hygiene.checks.stale_urgent.title);
    expect(within(stale).getByText(new RegExp(`${STALE_URGENT_DAYS} days`))).toBeInTheDocument();
    expect(STALE_URGENT_DAYS).toBe(14);
  });

  it("says there is nothing to check, and lists nothing, when a check found nothing", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    const stale = card(copy.issue.hygiene.checks.stale_urgent.title);
    expect(within(stale).getByText(copy.issue.hygiene.none)).toBeInTheDocument();
    expect(within(stale).queryByRole("link")).not.toBeInTheDocument();
  });

  it("links each issue to its own address on GitHub", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    const closed = card(copy.issue.hygiene.checks.closed_without_pr.title);
    expect(within(closed).getByRole("link", { name: /#3/ })).toHaveAttribute("href", "https://github.com/acme/widgets/issues/3");
    expect(within(closed).getByText("Fix typo")).toBeInTheDocument();
  });

  it("lists pull requests for the check that finds them, linked to the pull request", () => {
    render(<IssueHygiene findings={issueReport().hygiene} people={false} />);
    const prs = card(copy.issue.hygiene.checks.pr_without_issue.title);
    expect(within(prs).getByText(copy.issue.hygiene.foundOf(2, 10, "20%"))).toBeInTheDocument();
    expect(within(prs).getByRole("link", { name: /acme\/widgets#5/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/5",
    );
    expect(within(prs).getByText("Bump deps")).toBeInTheDocument();
  });

  it("shows no names and no group headings when people are off", () => {
    render(<IssueHygiene findings={issueReport({ people: true }).hygiene} people={false} />);
    expect(screen.queryByText("Ann Example")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 4 })).toHaveLength(0);
  });

  it("groups issues under each assignee, A to Z, with unassigned last, when people are on", () => {
    const findings: IssueHygieneFinding[] = [
      {
        check: "closed_without_pr",
        count: 4,
        of: 10,
        items: [ref(1, "Zoe Example"), ref(2, null), ref(3, "Ann Example"), ref(4, "Ann Example")],
      },
    ];
    render(<IssueHygiene findings={findings} people />);
    const closed = card(copy.issue.hygiene.checks.closed_without_pr.title);
    expect(
      within(closed)
        .getAllByRole("heading", { level: 4 })
        .map((h) => h.textContent),
    ).toEqual(["Ann Example", "Zoe Example", copy.space.hygiene.unassigned]);
    const ann = within(closed).getByRole("heading", { level: 4, name: "Ann Example" }).parentElement!;
    expect(within(ann).getAllByRole("link")).toHaveLength(2);
  });

  it("collapses a long list after ten and shows the rest on request", async () => {
    const user = userEvent.setup();
    const findings: IssueHygieneFinding[] = [
      { check: "unclassified", count: 12, of: 40, items: Array.from({ length: 12 }, (_, i) => ref(i + 1)) },
    ];
    render(<IssueHygiene findings={findings} people={false} />);
    const unclassified = card(copy.issue.hygiene.checks.unclassified.title);
    expect(within(unclassified).getAllByRole("link")).toHaveLength(10);
    await user.click(within(unclassified).getByRole("button", { name: copy.space.showAll(12) }));
    expect(within(unclassified).getAllByRole("link")).toHaveLength(12);
  });

  it("collapses a long pull request list too", async () => {
    const user = userEvent.setup();
    const pullRequests = Array.from({ length: 11 }, (_, i) => ({
      repo: "acme/widgets",
      number: i + 1,
      title: `Change ${i + 1}`,
      url: `https://github.com/acme/widgets/pull/${i + 1}`,
    }));
    render(<IssueHygiene findings={[{ check: "pr_without_issue", count: 11, of: 11, pullRequests }]} people={false} />);
    const prs = card(copy.issue.hygiene.checks.pr_without_issue.title);
    expect(within(prs).getAllByRole("link")).toHaveLength(10);
    await user.click(within(prs).getByRole("button", { name: copy.space.showAll(11) }));
    expect(within(prs).getAllByRole("link")).toHaveLength(11);
  });

  it("shows a count without a share when a check has no total to compare with", () => {
    render(<IssueHygiene findings={[{ check: "closed_without_pr", count: 2, of: 0, items: [ref(1), ref(2)] }]} people={false} />);
    expect(screen.getByText(copy.issue.hygiene.found(2))).toBeInTheDocument();
  });
});
