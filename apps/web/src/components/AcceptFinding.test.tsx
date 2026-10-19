import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSecurityList, useSecurityReport } from "../api/hooks";
import { copy } from "../copy";
import { setAcceptNotice } from "../lib/acceptNotice";
import { acceptanceView, securityReport, securitySummary } from "../test/fixtures";
import { mockFetch, renderRoute, type Handler, type MockResponse } from "../test/render";
import { AcceptFinding } from "./AcceptFinding";
import { AcceptedFindings } from "./AcceptedFindings";

const c = copy.security.acceptance;
const PLACE = ".github/workflows/ci.yml line 12";
const FINGERPRINT = "w2:0123456789abcdef";
const target = { check: "scriptInjection", path: ".github/workflows/ci.yml", fingerprint: FINGERPRINT } as const;

/** Keeps the report and the list queries active, so a read that follows an accept can be seen. */
function Watchers() {
  useSecurityReport(1, { from: null, to: null });
  useSecurityList();
  return null;
}

function setup(post: Handler | MockResponse = { status: 201, body: { id: 7 } }) {
  const reads = { report: 0, list: 0 };
  const fetchMock = mockFetch({
    "GET /api/repos/1/security": () => {
      reads.report += 1;
      return { body: securityReport() };
    },
    "GET /api/security": () => {
      reads.list += 1;
      return { body: [securitySummary()] };
    },
    "POST /api/repos/1/security/acceptances": post,
  });
  renderRoute(
    <>
      <Watchers />
      <AcceptFinding repoId={1} target={target} place={PLACE} />
      <AcceptedFindings report={securityReport()} />
    </>,
  );
  return { fetchMock, reads, user: userEvent.setup() };
}

const toggle = () => screen.getByRole("button", { name: `${c.accept} ${PLACE}` });
const radio = (name: string) => screen.getByRole("radio", { name });
const note = () => screen.getByLabelText(c.noteLabel);
const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

describe("AcceptFinding", () => {
  beforeEach(() => setAcceptNotice(1, null));

  it("is closed until it is pressed, and tells a screen reader which place the button is for and what it controls", () => {
    setup();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent(/^Accept/);
    expect(document.getElementById(toggle().getAttribute("aria-controls")!)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: c.reasonLegend })).not.toBeInTheDocument();
  });

  it("is left out of the printed report", () => {
    setup();
    expect(toggle().closest(".accept-finding")).toHaveClass("screen-only");
  });

  it("opens a form with a Reason group of four radios, a labelled note, and moves focus to the first radio", async () => {
    const { user } = setup();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const group = screen.getByRole("group", { name: c.reasonLegend });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual([
      "false_positive",
      "guarded_elsewhere",
      "public_by_design",
      "risk_accepted",
    ]);
    expect(radios[0]).toHaveFocus();
    // The limit is counted by code point, which maxlength cannot do, so the box does not carry it.
    expect(note()).not.toHaveAttribute("maxlength");
    expect(note().tagName).toBe("TEXTAREA");
  });

  it("links each hint to its radio with aria-describedby, and says the note is printed and must hold no name or secret", async () => {
    const { user } = setup();
    await user.click(toggle());
    for (const reason of ["false_positive", "guarded_elsewhere", "public_by_design", "risk_accepted"] as const) {
      expect(radio(c.reasons[reason].label)).toHaveAccessibleDescription(c.reasons[reason].hint);
    }
    expect(note()).toHaveAccessibleDescription(c.noteHint(280));
    expect(c.noteHint(280)).toMatch(/printed with the report/);
    expect(c.noteHint(280)).toMatch(/no name and no secret value/);
  });

  it("keeps focus order from the radios to the note to the buttons", async () => {
    const { user } = setup();
    await user.click(toggle());
    expect(radio(c.reasons.false_positive.label)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(radio(c.reasons.guarded_elsewhere.label)).toHaveFocus();
    await user.tab();
    expect(note()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: c.submit })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: c.cancel })).toHaveFocus();
  });

  it("returns focus to the button when Cancel is pressed, and closes the form", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(screen.getByRole("button", { name: c.cancel }));
    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: c.reasonLegend })).not.toBeInTheDocument();
  });

  it("asks for a reason first, in an alert, and sends nothing", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.type(note(), "An example file.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(c.problems.noReason);
    expect(screen.getByRole("group", { name: c.reasonLegend })).toHaveAccessibleDescription(c.problems.noReason);
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it("clears the missing reason message once a reason is chosen", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(radio(c.reasons.risk_accepted.label));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks for a note when it is empty or only spaces, marks the box invalid and links the message to it", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "   ");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(c.problems.empty);
    expect(note()).toHaveAttribute("aria-invalid", "true");
    expect(note()).toHaveAccessibleDescription(`${c.noteHint(280)} ${c.problems.empty}`);
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it("refuses a note over 280 characters and a note with a line break", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    fireEvent.change(note(), { target: { value: "x".repeat(281) } });
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The note must hold at most 280 characters.");
    fireEvent.change(note(), { target: { value: "two\nlines" } });
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(c.problems.control);
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it("clears a note problem as soon as the note changes", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.type(note(), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(note()).toHaveAttribute("aria-invalid", "false");
  });

  it("posts exactly the five fields, with the note trimmed, to the repository's acceptances", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.guarded_elsewhere.label));
    await user.type(note(), "  A ruleset blocks it.  ");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    const [url, init] = posts(fetchMock)[0] as [string, RequestInit];
    expect(url).toBe("/api/repos/1/security/acceptances");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      check: "scriptInjection",
      path: ".github/workflows/ci.yml",
      fingerprint: FINGERPRINT,
      reason: "guarded_elsewhere",
      note: "A ruleset blocks it.",
    });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(["check", "fingerprint", "note", "path", "reason"]);
  });

  it("posts a null path to accept an absence", async () => {
    const fetchMock = mockFetch({ "POST /api/repos/1/security/acceptances": { status: 201, body: { id: 1 } } });
    const user = userEvent.setup();
    renderRoute(
      <AcceptFinding repoId={1} target={{ check: "securityPolicy", path: null, fingerprint: "n1:" }} place="A security policy" />,
    );
    await user.click(screen.getByRole("button", { name: `${c.accept} A security policy` }));
    await user.click(radio(c.reasons.risk_accepted.label));
    await user.type(note(), "Reported privately.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      check: "securityPolicy",
      path: null,
      fingerprint: "n1:",
      reason: "risk_accepted",
      note: "Reported privately.",
    });
  });

  it("moves focus to the Accepted findings heading, says so in a status line and reads the report and the list again", async () => {
    const { user, reads } = setup();
    await waitFor(() => expect(reads).toEqual({ report: 1, list: 1 }));
    await user.click(toggle());
    await user.click(radio(c.reasons.public_by_design.label));
    await user.type(note(), "An example file.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(screen.getByRole("heading", { name: c.section.title })).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(c.accepted);
    await waitFor(() => expect(reads).toEqual({ report: 2, list: 2 }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["acceptance_no_record", c.conflicts.acceptance_no_record],
    ["acceptance_finding_changed", c.conflicts.acceptance_finding_changed],
    ["acceptance_duplicate", c.conflicts.acceptance_duplicate],
    ["acceptance_limit", c.conflicts.acceptance_limit],
  ])("says the cause of a 409 coded %s once, in the form that stays, and reads the report again", async (code, sentence) => {
    const { user, reads } = setup({ status: 409, body: { error: "Server wording.", code } });
    await waitFor(() => expect(reads.report).toBe(1));
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(reads).toEqual({ report: 2, list: 2 }));
    // One message only, in the form where the person is, and not repeated in the Accepted section.
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText("Server wording.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: c.section.title })).not.toHaveFocus();
  });

  it("says the general sentence for a 409 with no code, and keeps focus in the form while the form is still there", async () => {
    const { user, reads } = setup({ status: 409, body: { error: "Conflict." } });
    await waitFor(() => expect(reads.report).toBe(1));
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(c.changed);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: c.section.title })).not.toHaveFocus();
    expect(screen.getByRole("group", { name: c.reasonLegend })).toBeInTheDocument();
  });

  it("moves focus to the Accepted findings heading after a 409 only when the finding has left the page with its form", async () => {
    let reads = 0;
    mockFetch({
      "GET /api/repos/1/security": () => {
        reads += 1;
        return { body: securityReport(reads === 1 ? {} : { acceptances: [acceptanceView()] }) };
      },
      "GET /api/security": { body: [securitySummary()] },
      "POST /api/repos/1/security/acceptances": { status: 409, body: { error: "x", code: "acceptance_duplicate" } },
    });
    function Host() {
      const { data } = useSecurityReport(1, { from: null, to: null });
      useSecurityList();
      if (!data) return null;
      return (
        <>
          {data.acceptances.length === 0 && <AcceptFinding repoId={1} target={target} place={PLACE} />}
          <AcceptedFindings report={data} />
        </>
      );
    }
    renderRoute(<Host />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `${c.accept} ${PLACE}` }));
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(screen.getByRole("heading", { name: c.section.title })).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(c.conflicts.acceptance_duplicate);
    expect(screen.queryByRole("group", { name: c.reasonLegend })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not pull focus or say a conflict later when the form was closed before it left the page", async () => {
    mockFetch({
      "GET /api/repos/1/security": { body: securityReport() },
      "GET /api/security": { body: [securitySummary()] },
      "POST /api/repos/1/security/acceptances": { status: 409, body: { error: "x", code: "acceptance_limit" } },
    });
    function Host({ shown }: { shown: boolean }) {
      return (
        <>
          {shown && <AcceptFinding repoId={1} target={target} place={PLACE} />}
          <AcceptedFindings report={securityReport()} />
        </>
      );
    }
    const { rerender } = renderRoute(<Host shown />);
    const user = userEvent.setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(c.conflicts.acceptance_limit);
    // Closed with the toggle and not Cancel, then the finding leaves for some other reason.
    await user.click(toggle());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<Host shown={false} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: c.section.title })).not.toHaveFocus();
  });

  it("lets an Enter that confirms an IME composition through, and stops any other Enter", async () => {
    const { user } = setup();
    await user.click(toggle());
    expect(fireEvent.keyDown(note(), { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(note(), { key: "Enter" })).toBe(false);
  });

  it("does not add a line break when Enter is pressed in the note", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.type(note(), "One{Enter}line");
    expect(note()).toHaveValue("Oneline");
  });

  it("says a line break that arrives by paste is not allowed as soon as it is there, and clears it once it is gone", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(note());
    await user.paste("two\nlines");
    expect(await screen.findByRole("alert")).toHaveTextContent(c.problems.control);
    expect(note()).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(note(), { target: { value: "one line" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows another failure, such as a rate limit, without reading the report again", async () => {
    const { user, reads } = setup({ status: 429, body: { error: "Too many requests." } });
    await waitFor(() => expect(reads.report).toBe(1));
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests.");
    expect(reads.report).toBe(1);
  });

  it("disables both buttons while the request is in flight, so it cannot be sent twice", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { user, fetchMock } = setup(async () => {
      await gate;
      return { status: 201, body: { id: 1 } };
    });
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("button", { name: copy.common.saving })).toBeDisabled();
    expect(screen.getByRole("button", { name: c.cancel })).toBeDisabled();
    release();
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
  });

  it("forgets an earlier failure when the form is cancelled and opened again", async () => {
    const { user } = setup({ status: 429, body: { error: "Too many requests." } });
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "x");
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: c.cancel }));
    await user.click(toggle());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes the form and returns focus to the button when Escape is pressed", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.type(note(), "Half written");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: c.reasonLegend })).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveFocus();
  });

  it("does not close the form on Escape while the request is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { user } = setup(async () => {
      await gate;
      return { status: 201, body: { id: 1 } };
    });
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    await user.type(note(), "Not a risk.");
    await user.click(screen.getByRole("button", { name: c.submit }));
    await screen.findByRole("button", { name: copy.common.saving });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("group", { name: c.reasonLegend })).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByRole("group", { name: c.reasonLegend })).not.toBeInTheDocument());
  });

  it("opens a fresh form after Cancel, with no reason chosen and an empty note", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.risk_accepted.label));
    await user.type(note(), "Something typed");
    await user.click(screen.getByRole("button", { name: c.cancel }));
    await user.click(toggle());
    for (const reason of ["false_positive", "guarded_elsewhere", "public_by_design", "risk_accepted"] as const) {
      expect(radio(c.reasons[reason].label)).not.toBeChecked();
    }
    expect(note()).toHaveValue("");
    expect(screen.getByText(c.noteCount(0, 280))).toBeInTheDocument();
  });

  it("opens a fresh form after Escape as well", async () => {
    const { user } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.risk_accepted.label));
    await user.type(note(), "Something typed");
    await user.keyboard("{Escape}");
    await user.click(toggle());
    expect(radio(c.reasons.risk_accepted.label)).not.toBeChecked();
    expect(note()).toHaveValue("");
  });

  it("counts the note by code point as it is typed, and accepts exactly 280 code points of emoji", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    // Each emoji is two UTF-16 units, so 280 of them are 560 units, which a maxlength of 280 would have refused.
    const emoji = "\u{1F600}".repeat(280);
    fireEvent.change(note(), { target: { value: emoji } });
    expect(screen.getByText(c.noteCount(280, 280))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: c.submit }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String((posts(fetchMock)[0]![1] as RequestInit).body)).note).toBe(emoji);
  });

  it("says at once that a note is over the limit, by code point, and sends nothing", async () => {
    const { user, fetchMock } = setup();
    await user.click(toggle());
    await user.click(radio(c.reasons.false_positive.label));
    fireEvent.change(note(), { target: { value: "\u{1F600}".repeat(281) } });
    expect(screen.getByText(c.noteCount(281, 280))).toHaveAttribute("data-over", "true");
    expect(await screen.findByRole("alert")).toHaveTextContent(c.problems.tooLong(280));
    await user.click(screen.getByRole("button", { name: c.submit }));
    expect(posts(fetchMock)).toHaveLength(0);
    fireEvent.change(note(), { target: { value: "x".repeat(280) } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
