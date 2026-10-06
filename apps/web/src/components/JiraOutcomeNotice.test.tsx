import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JiraOutcomeNotice } from "./JiraOutcomeNotice";
import { mockFetch, renderRoute } from "../test/render";
import { copy } from "../copy";
import type { JiraOutcome } from "../lib/jira";

const assign = vi.fn();
const original = window.location;

beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: original });
});

const show = async (outcome: string, extra = "", jira = true) => {
  const fetchMock = mockFetch({ "GET /api/health": { body: { jira } } });
  const rendered = renderRoute(<JiraOutcomeNotice />, { path: "/repos", route: `/repos?${extra}jira=${outcome}` });
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return rendered;
};

describe("JiraOutcomeNotice", () => {
  it.each<[JiraOutcome, "status" | "alert", string]>([
    ["denied", "status", "notice-info"],
    ["error", "alert", "notice-error"],
    ["misconfigured", "alert", "notice-error"],
    ["expired", "alert", "notice-warning"],
    ["rate_limited", "alert", "notice-warning"],
  ])("shows its own title and body for %s as a %s", async (outcome, role, tone) => {
    await show(outcome);
    const notice = await screen.findByRole(role);
    expect(notice).toHaveClass(tone);
    expect(notice).toHaveTextContent(copy.jira.outcomes[outcome].title);
    expect(notice).toHaveTextContent(copy.jira.outcomes[outcome].body);
  });

  it.each<JiraOutcome>(["denied", "error", "expired", "rate_limited"])("offers Connect Jira again for %s", async (outcome) => {
    const user = userEvent.setup();
    await show(outcome, "x=1&");
    await user.click(await screen.findByRole("button", { name: copy.jira.connectAgain }));
    expect(assign).toHaveBeenCalledWith("/api/auth/jira/start?returnTo=%2Frepos%3Fx%3D1");
  });

  it("does not offer to retry when Atlassian refused the dashboard's own settings", async () => {
    await show("misconfigured");
    expect(await screen.findByRole("button", { name: copy.jira.dismiss })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.jira.connectAgain })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.jira.dismiss })).toBeInTheDocument();
  });

  it("goes away when dismissed", async () => {
    const user = userEvent.setup();
    await show("expired");
    await user.click(await screen.findByRole("button", { name: copy.jira.dismiss }));
    expect(screen.queryByText(copy.jira.outcomes.expired.title)).not.toBeInTheDocument();
  });

  it.each([["unknown"], [""]])("shows nothing for the outcome %j", async (outcome) => {
    const { container } = await show(outcome);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing, and no Connect button, when Jira is switched off", async () => {
    const { container } = await show("error", "", false);
    expect(container).toBeEmptyDOMElement();
  });
});
