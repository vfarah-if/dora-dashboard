import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copy } from "../copy";
import { setAcceptNotice } from "../lib/acceptNotice";
import { acceptanceView, securityReport } from "../test/fixtures";
import { mockFetch, renderRoute, type Handler, type MockResponse } from "../test/render";
import { AcceptedFindings } from "./AcceptedFindings";

const c = copy.security.acceptance;
const s = c.section;
const TITLE = copy.security.supplyChain.prHeadCheckout.title;
const PLACE = ".github/workflows/db-migrate.yml line 231";

const reportOf = (...views: ReturnType<typeof acceptanceView>[]) => securityReport({ acceptances: views });
const show = (...views: ReturnType<typeof acceptanceView>[]) => renderRoute(<AcceptedFindings report={reportOf(...views)} />);

const entry = () => screen.getByRole("listitem");
const button = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => setAcceptNotice(1, null));

describe("AcceptedFindings with nothing accepted", () => {
  it("says so, says GitHub's alerts are dismissed on GitHub, and keeps a heading that script can focus", () => {
    show();
    const section = document.getElementById("security-accepted")!;
    expect(section).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: s.title })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("heading", { name: s.title }).id).toBe("security-accepted-title");
    expect(within(section).getByText(s.empty)).toBeInTheDocument();
    expect(within(section).getByText(/Alerts from GitHub are dismissed on GitHub/)).toBeInTheDocument();
    expect(within(section).getByText(/only open alerts count/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("keeps an empty status region for a message to be announced in", () => {
    show();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("AcceptedFindings with acceptances that could not be read", () => {
  it("says how many, that their findings count again and that accepting again replaces them", () => {
    renderRoute(<AcceptedFindings report={securityReport({ acceptancesUnreadable: 2 })} />);
    expect(screen.getByText(c.unreadable(2))).toBeInTheDocument();
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/count again/)).toBeInTheDocument();
    expect(screen.getByText(/replaces them/)).toBeInTheDocument();
  });

  it("uses the singular for one, and says nothing when none could not be read", () => {
    const { unmount } = renderRoute(<AcceptedFindings report={securityReport({ acceptancesUnreadable: 1 })} />);
    expect(screen.getByText(/1 stored acceptance could not be read, so its finding counts again/)).toBeInTheDocument();
    unmount();
    renderRoute(<AcceptedFindings report={securityReport({ acceptancesUnreadable: 0 })} />);
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });
});

describe("AcceptedFindings entries", () => {
  it("show the check, the linked path, the reason, the note, the date and the rule for reopening", () => {
    show(acceptanceView());
    const item = entry();
    expect(within(item).getByText(TITLE)).toBeInTheDocument();
    const link = within(item).getByRole("link", { name: (name) => name.includes(PLACE) });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/blob/abcdef1234567890/.github/workflows/db-migrate.yml#L231",
    );
    expect(within(item).getByText("Reason").nextElementSibling).toHaveTextContent("Guarded elsewhere");
    expect(within(item).getByText("Note").nextElementSibling).toHaveTextContent("Only reached for pushes.");
    expect(within(item).getByText("Accepted on 1 Mar 2026.")).toBeInTheDocument();
    expect(within(item).getByText(s.reopen.w2)).toBeInTheDocument();
    expect(within(item).getByText(s.status.applies)).toBeInTheDocument();
  });

  it("show the note as text and never as markup", () => {
    show(acceptanceView({ acceptance: { note: '<img src=x onerror="alert(1)"> & <b>bold</b>' } }));
    expect(within(entry()).getByText('<img src=x onerror="alert(1)"> & <b>bold</b>')).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("show a path in plain text when the host built no link, and never link a javascript address", () => {
    show(
      acceptanceView({
        items: [{ ...acceptanceView().items[0]!, url: "javascript:alert(1)" }],
      }),
    );
    expect(within(entry()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(entry()).getByText(/db-migrate\.yml line 231/, { selector: ".accepted-place" })).toBeInTheDocument();
  });

  it("show a path in plain text for an acceptance that covers nothing now", () => {
    show(acceptanceView({ status: "gone", covers: 0, items: [] }));
    expect(within(entry()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(entry()).getByText(/db-migrate\.yml line 231/, { selector: ".accepted-place" })).toBeInTheDocument();
  });

  it("say how many places one acceptance covers when it is more than one, and nothing when it is one", () => {
    const { unmount } = show(acceptanceView({ covers: 3 }));
    expect(within(entry()).getByText("It covers 3 places, because identical lines share one acceptance.")).toBeInTheDocument();
    unmount();
    show(acceptanceView({ covers: 1 }));
    expect(within(entry()).queryByText(/It covers/)).not.toBeInTheDocument();
  });

  it("name an accepted absence as missing, with no path to link, and say it stops applying once the thing appears", () => {
    show(
      acceptanceView({
        covers: 1,
        items: [],
        acceptance: { check: "securityPolicy", path: null, line: null, fingerprint: "n1:", reason: "risk_accepted" },
      }),
    );
    const item = entry();
    expect(within(item).getByText(copy.security.supplyChain.securityPolicy.title)).toBeInTheDocument();
    expect(within(item).getByText(s.absent)).toBeInTheDocument();
    expect(within(item).queryByRole("link")).not.toBeInTheDocument();
    expect(within(item).getByText(s.reopen.n1)).toBeInTheDocument();
  });

  it.each([
    ["an action", "a1:0123456789abcdef", s.reopen.a1],
    ["a file", `b:${"a".repeat(40)}`, s.reopen.b],
    ["a missing lockfile", "p1:", s.reopen.p1],
  ])("state the rule for %s", (_name, fingerprint, rule) => {
    show(acceptanceView({ acceptance: { fingerprint } }));
    expect(within(entry()).getByText(rule)).toBeInTheDocument();
  });

  it("list one entry per acceptance, in the order the report gives", () => {
    show(
      acceptanceView({ acceptance: { id: 1, note: "First note." } }),
      acceptanceView({ acceptance: { id: 2, note: "Second note." } }),
    );
    const notes = screen.getAllByRole("listitem").map((li) => within(li).getByText(/note\.$/).textContent);
    expect(notes).toEqual(["First note.", "Second note."]);
  });
});

describe("AcceptedFindings Undo and Remove", () => {
  const deleteAt = (path: string, handler: Handler | MockResponse = { status: 204 }) =>
    mockFetch({ [`DELETE ${path}`]: handler });

  it("offers Undo for an acceptance that applies, named for what it undoes, and leaves the button out of print", () => {
    show(acceptanceView());
    const undo = button(/^Undo the acceptance of /);
    expect(undo).toHaveAccessibleName(`Undo the acceptance of ${TITLE}, ${PLACE}`);
    expect(undo).toHaveTextContent(/^Undo/);
    expect(undo).toHaveClass("screen-only");
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it.each([
    ["reopened", /no longer applies/],
    ["gone", /no longer matches anything the latest read reports/],
  ] as const)("says a %s acceptance has lapsed and offers Remove, not Undo", (status, words) => {
    show(acceptanceView({ status, covers: 0, items: [] }));
    expect(within(entry()).getByText(s.status[status])).toBeInTheDocument();
    expect(s.status[status]).toMatch(words);
    const remove = button(/^Remove the acceptance of /);
    expect(remove).toHaveClass("screen-only");
    expect(screen.queryByRole("button", { name: /^Undo/ })).not.toBeInTheDocument();
  });

  it("says the latest read could not check an unchecked acceptance, gives no advice to remove it, and still lets it be undone", () => {
    show(acceptanceView({ status: "unchecked", covers: 0, items: [] }));
    expect(within(entry()).getByText(s.status.unchecked)).toBeInTheDocument();
    expect(s.status.unchecked).toMatch(/latest read could not check it/);
    expect(s.status.unchecked).toMatch(/checked again at the next crawl/);
    expect(s.status.unchecked).not.toMatch(/remove/i);
    expect(button(/^Undo/)).toBeInTheDocument();
  });

  it("deletes the acceptance by its id, then says it was removed and moves focus to the heading", async () => {
    const fetchMock = deleteAt("/api/repos/1/security/acceptances/5");
    const user = userEvent.setup();
    show(acceptanceView({ acceptance: { id: 5 } }));
    await user.click(button(/^Undo/));
    await waitFor(() => expect(screen.getByRole("heading", { name: s.title })).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/repos/1/security/acceptances/5");
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("same-origin");
    expect(screen.getByRole("status")).toHaveTextContent(c.removed);
  });

  it("removes a lapsed acceptance in the same way", async () => {
    const fetchMock = deleteAt("/api/repos/1/security/acceptances/9");
    const user = userEvent.setup();
    show(acceptanceView({ status: "gone", covers: 0, items: [], acceptance: { id: 9 } }));
    await user.click(button(/^Remove/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/repos/1/security/acceptances/9");
  });

  it("shows why it failed, keeps the entry and its button, and says nothing was removed", async () => {
    deleteAt("/api/repos/1/security/acceptances/5", { status: 500, body: { error: "The store is busy." } });
    const user = userEvent.setup();
    show(acceptanceView());
    await user.click(button(/^Undo/));
    expect(await screen.findByRole("alert")).toHaveTextContent("The store is busy.");
    expect(button(/^Undo/)).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: s.title })).not.toHaveFocus();
  });

  it("disables the button and says it is removing while the request is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    deleteAt("/api/repos/1/security/acceptances/5", async () => {
      await gate;
      return { status: 204 };
    });
    const user = userEvent.setup();
    show(acceptanceView());
    await user.click(button(/^Undo/));
    expect(await screen.findByRole("button", { name: /^Removing/ })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(c.removed));
  });
});

describe("AcceptedFindings status line announcements", () => {
  it("announces a second removal again, because each message is a new element even with the same words", async () => {
    mockFetch({
      "DELETE /api/repos/1/security/acceptances/1": { status: 204 },
      "DELETE /api/repos/1/security/acceptances/2": { status: 204 },
    });
    const user = userEvent.setup();
    show(acceptanceView({ acceptance: { id: 1 } }), acceptanceView({ acceptance: { id: 2 } }));
    const [first, second] = screen.getAllByRole("button", { name: /^Undo/ });
    await user.click(first!);
    const before = await within(screen.getByRole("status")).findByText(c.removed);
    await user.click(second!);
    await waitFor(() => expect(within(screen.getByRole("status")).getByText(c.removed)).not.toBe(before));
    expect(before).not.toBeInTheDocument();
  });

  it("says nothing after the section has left, so a message does not wait for the next visit", () => {
    const { unmount } = show();
    act(() => setAcceptNotice(1, c.accepted));
    expect(screen.getByRole("status")).toHaveTextContent(c.accepted);
    unmount();
    show();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("shows nothing when the page moves to another repository, and nothing when it moves back", async () => {
    const reports = [
      reportOf(),
      securityReport({ repo: { id: 2, owner: "acme", name: "gadgets", deployBranch: "main", lastCrawledAt: null } }),
    ];
    function Switch() {
      const [index, setIndex] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setIndex((now) => 1 - now)}>
            Switch
          </button>
          <AcceptedFindings report={reports[index]!} />
        </>
      );
    }
    const user = userEvent.setup();
    renderRoute(<Switch />);
    act(() => setAcceptNotice(1, c.accepted));
    expect(screen.getByRole("status")).toHaveTextContent(c.accepted);
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("AcceptedFindings status line", () => {
  it("shows a message set elsewhere, such as after a finding is accepted", () => {
    show();
    act(() => setAcceptNotice(1, c.accepted));
    expect(screen.getByRole("status")).toHaveTextContent(c.accepted);
    expect(screen.getByRole("status")).toHaveClass("screen-only");
  });
});

describe("AcceptedFindings in print", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => acceptanceView({ acceptance: { id: i + 1, note: `Note number ${i + 1}.` } }));
  const startPrint = () => act(() => void window.dispatchEvent(new Event("beforeprint")));
  const endPrint = () => act(() => void window.dispatchEvent(new Event("afterprint")));

  it("shows ten entries on screen and the rest behind a button that is left out of print", async () => {
    show(...many(12));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    const more = screen.getByRole("button", { name: /Show all 12/ });
    expect(more).toHaveClass("screen-only");
  });

  it("prints every entry, since the acceptances explain the grade", () => {
    show(...many(12));
    startPrint();
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    endPrint();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("marks every control in the section as screen only, and nothing that carries the decision", () => {
    show(acceptanceView(), acceptanceView({ status: "gone", covers: 0, items: [], acceptance: { id: 6 } }));
    for (const control of screen.getAllByRole("button")) expect(control).toHaveClass("screen-only");
    for (const item of screen.getAllByRole("listitem")) {
      expect(item).not.toHaveClass("screen-only");
      expect(within(item).getByText("Note").closest("dl")?.closest(".screen-only")).toBeNull();
    }
  });
});
