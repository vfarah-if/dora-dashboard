import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copy } from "../copy";
import { noSecurity, securityAction, securityReport } from "../test/fixtures";
import { renderRoute } from "../test/render";
import { CopySnippet } from "./CopySnippet";
import { Glossary } from "./Glossary";
import { PassFail } from "./PassFail";
import { ActionItem, SecurityActions, fixContext } from "./SecurityActions";
import { SecurityGrade } from "./SecurityGrade";
import { StartHere } from "./StartHere";

const startPrint = () => act(() => void window.dispatchEvent(new Event("beforeprint")));
const endPrint = () => act(() => void window.dispatchEvent(new Event("afterprint")));

describe("CopySnippet", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // The instance property, put there by userEvent.setup() or by this file, is dropped so each test starts clean.
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  const region = () => screen.getByRole("status");

  it("names the block once, as a labelled group, and keeps the text in a block that a keyboard can scroll", () => {
    render(<CopySnippet label="Upgrade command" code="npm install left-pad@1.3.1" />);
    const group = screen.getByRole("group", { name: "Upgrade command" });
    const block = within(group).getByText("npm install left-pad@1.3.1").closest("pre")!;
    expect(block).toHaveAttribute("tabindex", "0");
    // The group carries the name, so the block does not repeat it.
    expect(block).not.toHaveAttribute("aria-label");
    expect(screen.queryByLabelText("Upgrade command", { selector: "pre" })).not.toBeInTheDocument();
  });

  it("keeps the announcement region in the page, visually hidden and empty, before anything is copied", () => {
    render(<CopySnippet label="Upgrade command" code="x" />);
    expect(region()).toBeEmptyDOMElement();
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveClass("visually-hidden");
    expect(region()).not.toHaveStyle({ display: "none" });
  });

  it("copies the text when the labelled button is pressed and announces it politely", async () => {
    const user = userEvent.setup();
    render(<CopySnippet label="Upgrade command" code="npm install left-pad@1.3.1" />);
    await user.click(screen.getByRole("button", { name: "Copy Upgrade command" }));
    expect(await navigator.clipboard.readText()).toBe("npm install left-pad@1.3.1");
    expect(region()).toHaveTextContent(copy.security.copied);
    // The visible button says so too, for someone who cannot hear the announcement.
    expect(screen.getByRole("button", { name: "Copy Upgrade command" })).toHaveTextContent(copy.security.copied);
  });

  it("announces a second copy again, as a new message, and not as a repeat of the first", async () => {
    const user = userEvent.setup();
    render(<CopySnippet label="Upgrade command" code="x" />);
    await user.click(screen.getByRole("button", { name: "Copy Upgrade command" }));
    const first = region().firstElementChild;
    expect(first).toHaveTextContent(copy.security.copied);
    await user.click(screen.getByRole("button", { name: "Copy Upgrade command" }));
    const second = region().firstElementChild;
    expect(second).toHaveTextContent(copy.security.copied);
    expect(second).not.toBe(first);
  });

  it("clears the announcement after about two seconds and shows the button as Copy again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CopySnippet label="Upgrade command" code="x" />);
    await user.click(screen.getByRole("button", { name: "Copy Upgrade command" }));
    expect(region()).toHaveTextContent(copy.security.copied);
    act(() => void vi.advanceTimersByTime(1900));
    expect(region()).toHaveTextContent(copy.security.copied);
    act(() => void vi.advanceTimersByTime(200));
    expect(region()).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Copy Upgrade command" })).toHaveTextContent(copy.security.copyButton);
  });

  it("says the text could not be copied when the browser refuses, in the region and in view", async () => {
    const user = userEvent.setup();
    render(<CopySnippet label="Upgrade command" code="x" />);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy Upgrade command" }));
    expect(region()).toHaveTextContent(copy.security.copyFailed);
    expect(screen.getAllByText(copy.security.copyFailed)).toHaveLength(2);
    expect(screen.queryByText(copy.security.copied)).not.toBeInTheDocument();
  });

  it("tells the reader to select the text themselves when the browser has no clipboard, and offers no button", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<CopySnippet label="Upgrade command" code="x" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(copy.security.copyUnavailable)).toBeInTheDocument();
    expect(region()).toBeEmptyDOMElement();
  });

  it("shows a caution beside the block", () => {
    render(<CopySnippet label="A workflow" code="x" note="Needs a paid plan." />);
    expect(within(screen.getByRole("group", { name: "A workflow" })).getByText("Needs a paid plan.")).toBeInTheDocument();
  });

  it("shows a block for comparison that has no button and is not in the copied text", async () => {
    const user = userEvent.setup();
    render(<CopySnippet label="Safe way" code="safe" instead="risky" />);
    expect(screen.getByText(copy.security.insteadOf)).toBeInTheDocument();
    expect(screen.getByText("risky")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Copy Safe way" }));
    expect(await navigator.clipboard.readText()).toBe("safe");
  });
});

describe("PassFail", () => {
  it.each([
    ["met", "Met", "checks-passing"],
    ["unmet", "Not met", "checks-failing"],
    ["unseen", "Not visible", "checks-none"],
  ] as const)("shows %s as an icon and the word %s", (state, word, className) => {
    const { container } = render(<PassFail state={state} />);
    expect(screen.getByText(word)).toBeInTheDocument();
    expect(container.querySelector(`.${className} svg`)).toHaveAttribute("aria-hidden", "true");
  });

  it("takes a word of its own where Met and Not met do not fit", () => {
    render(<PassFail state="unmet" label="Switched off" />);
    expect(screen.getByText("Switched off")).toBeInTheDocument();
    expect(screen.queryByText("Not met")).not.toBeInTheDocument();
  });
});

describe("StartHere", () => {
  it("gives the grade, what raises it, the first three things with their effort and the advice that does not count", () => {
    render(<StartHere report={securityReport()} />);
    const card = screen.getByRole("region", { name: copy.security.start.title });
    expect(within(card).getByText("Medium")).toBeInTheDocument();
    expect(within(card).getByText("Do these 2 things to move from medium to high.")).toBeInTheDocument();
    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("left-pad has 2 open critical alerts, and version 1.3.1 fixes them.");
    expect(items[0]).toHaveTextContent("Under an hour");
    expect(items[1]).toHaveTextContent("uses 1 action from other organisations that is not pinned");
    expect(items[1]).toHaveTextContent("Under an hour");
    expect(items[2]).toHaveTextContent("No Dependabot or Renovate configuration was found");
    expect(items[2]).toHaveTextContent("A few minutes");
    expect(within(card).getByText("and 1 more.", { exact: false })).toBeInTheDocument();
    expect(within(card).getByText("There are also 2 pieces of advice that do not change the grade.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: copy.security.start.seeAll })).toHaveAttribute("href", "#security-actions");
    // An in-page jump has nowhere to go on paper, so it is left out of the printed report.
    expect(within(card).getByRole("link", { name: copy.security.start.seeAll })).toHaveClass("screen-only");
  });

  it("says this one thing when a single action raises the grade", () => {
    render(
      <StartHere
        report={securityReport({
          raiseGrade: { to: "elite", actions: 1 },
          grade: {
            ...securityReport().grade!,
            overall: { band: "high", check: "highOpen", reason: "x", part: "vulnerabilities" },
          },
        })}
      />,
    );
    expect(screen.getByText("Do this one thing to move from high to elite.")).toBeInTheDocument();
  });

  it("says nothing stands in the way of the band when actions exist but none raises it", () => {
    render(<StartHere report={securityReport({ raiseGrade: null })} />);
    expect(screen.getByText(copy.security.start.nothingToRaise("medium"))).toBeInTheDocument();
  });

  it("gives a plain good word when nothing needs fixing", () => {
    render(<StartHere report={securityReport({ actions: [], raiseGrade: null })} />);
    expect(screen.getByText(copy.security.start.good)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("explains why there is no grade", () => {
    const { rerender } = render(<StartHere report={noSecurity()} />);
    expect(screen.getByText(copy.security.start.missing.not_crawled)).toBeInTheDocument();
    rerender(<StartHere report={noSecurity({ gradeMissing: "nothing_measured" })} />);
    expect(screen.getByText(copy.security.start.missing.nothing_measured)).toBeInTheDocument();
    rerender(<StartHere report={noSecurity({ gradeMissing: null })} />);
    expect(screen.getByText(copy.security.start.missing.nothing_measured)).toBeInTheDocument();
  });

  it("leaves out the count of more actions and the advice when there is none", () => {
    render(<StartHere report={securityReport({ actions: securityReport().actions.slice(0, 2) })} />);
    expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pieces? of advice/)).not.toBeInTheDocument();
  });

  it("says there is one piece of advice in the singular", () => {
    render(<StartHere report={securityReport({ actions: securityReport().actions.slice(0, 3) })} />);
    expect(screen.getByText("There is also one piece of advice that does not change the grade.")).toBeInTheDocument();
  });
});

describe("SecurityGrade", () => {
  it("shows the grade as a large band with the sentence naming what holds it back", () => {
    render(<SecurityGrade report={securityReport()} />);
    const tile = screen.getAllByRole("heading", { level: 3, name: copy.security.grade.title })[0]!.closest("article")!;
    expect(within(tile).getByText("Medium")).toBeInTheDocument();
    expect(tile).toHaveClass("grade-tile-large");
    expect(within(tile).getByText(/^The lowest part is Known vulnerabilities and secrets/)).toBeInTheDocument();
  });

  it("shows each part, with not measured for one that was left out", () => {
    render(<SecurityGrade report={securityReport()} />);
    expect(screen.getByRole("heading", { level: 3, name: "Workflows and supply chain" }).closest("article")).toHaveTextContent(
      "High",
    );
    const change = screen.getByRole("heading", { level: 3, name: "Change control" }).closest("article")!;
    expect(change).toHaveTextContent(copy.security.notMeasured);
    expect(change).not.toHaveTextContent(/Elite|High|Medium|Low/);
  });

  it("lists what is good and what to improve, marking only the check that sets the overall grade with Sets the grade", () => {
    render(<SecurityGrade report={securityReport()} />);
    const good = screen.getByRole("heading", { name: copy.security.grade.goodTitle }).closest("section")!;
    expect(
      within(good)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "No critical alert has waited longer than its 7 day fix-by date.",
      "No workflow runs a pull request's own code while holding secrets.",
    ]);
    const improve = screen.getByRole("heading", { name: copy.security.grade.improveTitle }).closest("section")!;
    const items = within(improve).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("1 critical alert is open");
    expect(items[0]).toHaveTextContent(copy.security.tags.setsGrade);
    expect(items[1]).not.toHaveTextContent(copy.security.tags.setsGrade);
    expect(items[2]).toHaveTextContent("not pinned to a commit");
    // Another part's limiting check does not set the overall grade, so it carries the part wording instead.
    expect(items[2]).not.toHaveTextContent(copy.security.tags.setsGrade);
    expect(items[2]).toHaveTextContent(copy.security.tags.setsPartGrade);
    expect(items[0]).not.toHaveTextContent(copy.security.tags.setsPartGrade);
    expect(items[3]).not.toHaveTextContent(copy.security.tags.setsGrade);
  });

  it("says what the grade does not cover", () => {
    render(<SecurityGrade report={securityReport()} />);
    expect(screen.getByText(copy.security.grade.unmeasuredTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.security.unmeasured.changeControl)).toBeInTheDocument();
  });

  it("says nothing was measured as good, or nothing needs improving, when a list is empty", () => {
    const base = securityReport();
    const { rerender } = render(<SecurityGrade report={securityReport({ checks: base.checks.filter((c) => c.met === true) })} />);
    expect(screen.getByText(copy.security.grade.improveEmpty)).toBeInTheDocument();
    rerender(
      <SecurityGrade
        report={securityReport({ checks: base.checks.filter((c) => c.met === false), grade: { ...base.grade!, unmeasured: [] } })}
      />,
    );
    expect(screen.getByText(copy.security.grade.goodEmpty)).toBeInTheDocument();
    expect(screen.queryByText(copy.security.grade.unmeasuredTitle)).not.toBeInTheDocument();
  });

  it("explains why there is no grade", () => {
    render(<SecurityGrade report={noSecurity({ gradeMissing: "nothing_measured" })} />);
    expect(screen.getByText(copy.security.start.missing.nothing_measured)).toBeInTheDocument();
    expect(screen.queryByText(copy.security.grade.partsTitle)).not.toBeInTheDocument();
  });

  it("falls back to the nothing measured wording when no reason is given", () => {
    render(<SecurityGrade report={noSecurity({ gradeMissing: null })} />);
    expect(screen.getByText(copy.security.start.missing.nothing_measured)).toBeInTheDocument();
  });
});

describe("ActionItem", () => {
  const context = fixContext(securityReport());
  const show = (overrides = {}) =>
    render(
      <ol>
        <ActionItem action={securityAction(overrides)} context={context} />
      </ol>,
    );

  it("derives the fix context from the report", () => {
    expect(context).toEqual({
      repo: { id: 1, owner: "acme", name: "widgets", lastCrawledAt: "2026-03-01T10:00:00Z" },
      ecosystems: ["npm", "github-actions"],
      branch: "main",
      settingsUrl: "https://github.com/acme/widgets/settings/security_analysis",
      versionUpdates: null,
      codeScanning: true,
      thresholds: securityReport().thresholds,
    });
    expect(fixContext(noSecurity()).branch).toBe("main");
    expect(fixContext(noSecurity()).ecosystems).toEqual([]);
  });

  it("states what is wrong with the tags that say how much work it is and what it holds back", () => {
    show({ likelyExploited: true });
    expect(
      screen.getByText("left-pad has 2 open critical alerts, and version 1.3.1 fixes them.", { selector: "p" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Under an hour")).toBeInTheDocument();
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Holds the grade at Medium")).toBeInTheDocument();
    expect(screen.getByText(copy.security.tags.likelyExploited)).toBeInTheDocument();
  });

  it("marks advice that never moves the grade, and leaves out tags that do not apply", () => {
    show({ kind: "add_security_policy", band: null, onPath: false, severity: null, likelyExploited: false });
    expect(screen.getByText(copy.security.tags.advice)).toBeInTheDocument();
    expect(screen.queryByText(copy.security.tags.likelyExploited)).not.toBeInTheDocument();
    expect(screen.queryByText(/Holds the grade/)).not.toBeInTheDocument();
  });

  it("keeps the explanation in a native disclosure that starts closed and opens when its summary is pressed", async () => {
    const user = userEvent.setup();
    const { container } = show();
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText(copy.security.fixTitle, { selector: "summary" }));
    expect(details).toHaveAttribute("open");
    await user.click(screen.getByText(copy.security.fixTitle, { selector: "summary" }));
    expect(details).not.toHaveAttribute("open");
  });

  it("answers why it matters, what to do, a command to copy, where to look and where to learn more", () => {
    show();
    expect(screen.getByRole("heading", { level: 3, name: copy.security.why })).toBeInTheDocument();
    expect(screen.getByText(copy.security.fix.upgrade_dependency.why)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      expect.arrayContaining([...copy.security.fix.upgrade_dependency.steps]),
    );
    expect(
      within(screen.getByRole("group", { name: "Upgrade command" })).getByText("npm install left-pad@1.3.1"),
    ).toBeInTheDocument();
    const alert = screen.getByRole("link", { name: /Prototype pollution in left-pad/ });
    expect(alert).toHaveAttribute("href", "https://github.com/acme/widgets/security/dependabot/1");
    expect(alert).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: new RegExp(copy.security.learnMore) })).toHaveAttribute(
      "href",
      "https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-dependabot-alerts/view-dependabot-alerts",
    );
  });

  it("shows a reference without a link as a path, and refuses a link that is not a web address", () => {
    show({
      refs: [
        { label: "src/db/query.ts:42", url: null },
        { label: "A trap", url: "javascript:alert(1)" },
      ],
    });
    expect(screen.getByText("src/db/query.ts:42")).toBeInTheDocument();
    expect(screen.getByText("A trap")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /A trap/ })).not.toBeInTheDocument();
  });

  it("leaves out the where to look list when there are no references", () => {
    show({ refs: [] });
    expect(screen.queryByText(copy.security.affected)).not.toBeInTheDocument();
  });

  it("offers the security settings for a fix that is a setting, and the branch settings for a rule", () => {
    const { unmount } = show({ kind: "enable_push_protection", band: null, refs: [] });
    expect(screen.getByRole("link", { name: new RegExp(copy.security.settingsLink) })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/settings/security_analysis",
    );
    unmount();
    show({ kind: "protect_branch", refs: [] });
    expect(screen.getByRole("link", { name: new RegExp(copy.security.branchSettingsLink) })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/settings/branches",
    );
  });

  it("has no learn more link for a setting of the dashboard itself", () => {
    show({ kind: "turn_on_code_analysis", band: null, refs: [] });
    expect(screen.queryByRole("link", { name: new RegExp(copy.security.learnMore) })).not.toBeInTheDocument();
  });

  it("works out whether GitHub code scanning can be used from the repository's visibility and the source", () => {
    const base = securityReport();
    const privateOff = securityReport({
      posture: { ...base.posture!, visibility: "private" },
      sources: {
        ...base.sources,
        code_scanning: { ...base.sources.code_scanning, status: "off", reason: "needs_advanced_security" },
      },
    });
    expect(fixContext(base).codeScanning).toBe(true);
    expect(fixContext(privateOff).codeScanning).toBe(false);
    // A private repository where code scanning was read has it.
    expect(fixContext({ ...privateOff, sources: base.sources }).codeScanning).toBe(true);
    // Nothing known about the repository, and no read, is treated as not available.
    expect(fixContext(noSecurity()).codeScanning).toBe(false);
  });

  it("offers Semgrep, with what it needs, for a private repository without code scanning, and CodeQL for a public one", () => {
    const base = securityReport();
    const off = { ...base.sources.code_scanning, status: "off" as const, reason: "needs_advanced_security" as const };
    const privateReport = securityReport({
      posture: { ...base.posture!, visibility: "private" },
      sources: { ...base.sources, code_scanning: off },
    });
    const { unmount } = render(
      <ol>
        <ActionItem action={securityAction({ kind: "enable_code_scanning", refs: [] })} context={fixContext(privateReport)} />
      </ol>,
    );
    expect(screen.getByRole("group", { name: copy.security.snippets.semgrep })).toHaveTextContent(
      "semgrep scan --config auto --error",
    );
    expect(screen.getByText(copy.security.snippetNotes.semgrep)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: copy.security.snippets.codeql })).not.toBeInTheDocument();
    unmount();
    render(
      <ol>
        <ActionItem
          action={securityAction({ kind: "enable_code_scanning", refs: [] })}
          context={fixContext(
            securityReport({
              posture: { ...base.posture!, visibility: "public" },
              sources: { ...base.sources, code_scanning: off },
            }),
          )}
        />
      </ol>,
    );
    expect(screen.getByRole("group", { name: copy.security.snippets.codeql })).toHaveTextContent("security-events: write");
    expect(screen.getByText(copy.security.snippetNotes.codeql)).toBeInTheDocument();
  });

  it("says, in words and with no Copy button, how to fix a package that comes in through another package", () => {
    render(
      <ol>
        <ActionItem action={securityAction({ relationship: "transitive" })} context={context} />
      </ol>,
    );
    expect(screen.getByText(/left-pad comes in through another package/)).toBeInTheDocument();
    expect(screen.queryByText("npm install left-pad@1.3.1")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: copy.security.snippets.npmOverrides })).toHaveTextContent('"overrides"');
    expect(screen.getByRole("group", { name: copy.security.snippets.upgradeInPlace })).toHaveTextContent("npm update left-pad");
  });

  it("says in words, with no Copy button, what to do where the fix is a requirements file", () => {
    const { container } = show({ ecosystem: "pip", target: "pip:left-pad", manifestPath: "requirements.txt" });
    const words = screen.getByText(/Set left-pad==1.3.1 in requirements.txt/);
    expect(words.closest("code")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument();
    expect(container.querySelector(".copy-snippet")).toBeNull();
  });

  it("shows the risky script line only for comparison, so that Copy gives the safe version", async () => {
    const user = userEvent.setup();
    show({ kind: "fix_script_injection", refs: [] });
    expect(screen.getByText(copy.security.insteadOf)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Copy ${copy.security.snippets.scriptInjection}` }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("TITLE: ${{ github.event.issue.title }}");
    expect(copied).not.toContain('echo "${{');
  });

  it("refuses a settings link that is not a web address", () => {
    const base = fixContext(securityReport());
    const { unmount } = render(
      <ol>
        <ActionItem
          action={securityAction({ kind: "enable_push_protection", band: null, refs: [] })}
          context={{ ...base, settingsUrl: "javascript:alert(1)" }}
        />
      </ol>,
    );
    expect(screen.queryByRole("link", { name: new RegExp(copy.security.settingsLink) })).not.toBeInTheDocument();
    unmount();
    render(
      <ol>
        <ActionItem
          action={securityAction({ kind: "protect_branch", refs: [] })}
          context={{ ...base, settingsUrl: "javascript:alert(1)/settings/x" }}
        />
      </ol>,
    );
    expect(screen.queryByRole("link", { name: new RegExp(copy.security.branchSettingsLink) })).not.toBeInTheDocument();
  });

  it("writes the limits it names from the report's thresholds", () => {
    const base = securityReport();
    const context = fixContext({ ...base, thresholds: { ...base.thresholds, reviewWindowDays: 45 } });
    render(
      <ol>
        <ActionItem action={securityAction({ kind: "require_review", count: 3, band: "high", refs: [] })} context={context} />
      </ol>,
    );
    expect(
      screen.getByText("3 merged pull requests in the last 45 days had no approval from another person.", { selector: "p" }),
    ).toBeInTheDocument();
  });

  it("keeps its disclosure as it is on screen when the page prints, so a closed one stays closed", () => {
    const { container } = render(
      <ol>
        <ActionItem action={securityAction()} context={context} />
      </ol>,
    );
    startPrint();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    endPrint();
  });

  it("leaves no empty Where to look heading when the action has nothing to point at", () => {
    const { rerender } = render(
      <ol>
        <ActionItem action={securityAction({ kind: "require_review", count: 3, band: "high", refs: [] })} context={context} />
      </ol>,
    );
    expect(screen.queryByRole("heading", { name: copy.security.affected })).not.toBeInTheDocument();
    rerender(
      <ol>
        <ActionItem
          action={securityAction({
            kind: "require_review",
            count: 3,
            band: "high",
            refs: [{ label: ".github/workflows/ci.yml", url: null }],
          })}
          context={context}
        />
      </ol>,
    );
    expect(screen.getByRole("heading", { name: copy.security.affected })).toBeInTheDocument();
  });
});

describe("SecurityActions", () => {
  const many = (count: number) =>
    securityReport({ actions: Array.from({ length: count }, (_, i) => securityAction({ target: `npm:pkg-${i + 1}` })) });

  it("numbers the actions in the order core gave them", () => {
    renderRoute(<SecurityActions report={securityReport()} />);
    const list = screen.getAllByRole("list").find((l) => l.classList.contains("action-list"))!;
    expect(list.tagName).toBe("OL");
    expect([...list.querySelectorAll(".action-sentence")].map((p) => p.textContent?.slice(0, 22))).toEqual([
      "left-pad has 2 open cr",
      "The workflow .github/w",
      "No Dependabot or Renov",
      "Push protection is swi",
    ]);
    expect(screen.getByText("4 things to fix")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: copy.security.actions.title })).toBeInTheDocument();
  });

  it("never skips a heading level, so there is no h4 straight under the section's h2", () => {
    const { container } = renderRoute(<SecurityActions report={securityReport()} />);
    expect(container.querySelectorAll("h4")).toHaveLength(0);
    const levels = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(2);
    levels.slice(1).forEach((level, i) => expect(level - levels[i]!).toBeLessThanOrEqual(1));
    expect(levels).toContain(3);
  });

  it("says one thing to fix in the singular", () => {
    renderRoute(<SecurityActions report={securityReport({ actions: [securityAction()] })} />);
    expect(screen.getByText("One thing to fix")).toBeInTheDocument();
  });

  it("shows ten and offers the rest behind a button", async () => {
    const user = userEvent.setup();
    const { container } = renderRoute(<SecurityActions report={many(12)} />);
    expect(container.querySelectorAll(".action-item")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: copy.space.showAll(12) }));
    expect(container.querySelectorAll(".action-item")).toHaveLength(12);
    expect(screen.getByRole("button", { name: copy.space.showFewer })).toBeInTheDocument();
  });

  it("prints what the screen shows, with the explanations as they are and a line for the actions left out", async () => {
    const user = userEvent.setup();
    const { container } = renderRoute(<SecurityActions report={many(12)} />);
    await user.click(container.querySelector("summary")!);
    startPrint();
    expect(container.querySelectorAll(".action-item")).toHaveLength(10);
    // Only the one opened on screen is open on paper.
    expect(container.querySelectorAll("details[open]")).toHaveLength(1);
    const note = screen.getByText(copy.security.printMore(2));
    expect(note).toHaveClass("print-only");
    endPrint();
  });

  it("hides the show all button from the printed copy, and prints no note once everything is shown", async () => {
    const user = userEvent.setup();
    const { container } = renderRoute(<SecurityActions report={many(12)} />);
    expect(screen.getByRole("button", { name: copy.space.showAll(12) })).toHaveClass("screen-only");
    await user.click(screen.getByRole("button", { name: copy.space.showAll(12) }));
    expect(container.querySelectorAll(".action-item")).toHaveLength(12);
    expect(screen.queryByText(copy.security.printMore(2))).not.toBeInTheDocument();
  });

  it("says nothing needs fixing when there are no actions", () => {
    renderRoute(<SecurityActions report={securityReport({ actions: [] })} />);
    expect(screen.getByText(copy.security.actions.none)).toBeInTheDocument();
  });
});

describe("Glossary", () => {
  it("explains the fifteen terms the page uses, in a disclosure", async () => {
    const user = userEvent.setup();
    const { container } = render(<Glossary />);
    const terms = copy.security.glossary.terms.map((t) => t.term);
    expect(terms).toEqual([
      "Dependabot",
      "Code scanning",
      "Secret scanning",
      "Advisory",
      "CVE",
      "GHSA",
      "CWE",
      "EPSS",
      "CVSS",
      "Lockfile",
      "Pinning to a commit SHA",
      "GITHUB_TOKEN permissions",
      "pull_request_target",
      "Branch protection",
      "Push protection",
    ]);
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText(copy.security.glossary.summary));
    expect(details).toHaveAttribute("open");
    expect(screen.getAllByRole("term")).toHaveLength(15);
    expect(screen.getByText(/^A catalogue number that identifies one published flaw/)).toBeInTheDocument();
  });

  it("prints as it is on screen, closed until someone opens it", () => {
    const { container } = render(<Glossary />);
    startPrint();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });
});
