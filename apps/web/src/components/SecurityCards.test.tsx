import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceState, SupplyChainLine } from "@dora-dashboard/core";
import { copy } from "../copy";
import { noSecurity, securityReport } from "../test/fixtures";
import { renderRoute } from "../test/render";
import { BranchProtectionCard } from "./BranchProtectionCard";
import { DependencyUpdatesCard } from "./DependencyUpdatesCard";
import { ScorecardCard } from "./ScorecardCard";
import { SecurityIssuesCard } from "./SecurityIssuesCard";
import { SourcesPanel } from "./SourcesPanel";
import { SupplyChainCard } from "./SupplyChainCard";

const tile = (label: string) => screen.getByRole("heading", { level: 3, name: label }).closest("article")!;

describe("SupplyChainCard", () => {
  it("shows each workflow check as an icon and a word with a sentence and whether it counts towards the grade", () => {
    render(<SupplyChainCard report={securityReport()} group="workflows" />);
    const rows = screen.getAllByRole("listitem").filter((li) => li.classList.contains("check-row"));
    expect(rows.map((r) => r.querySelector(".check-row-title")?.textContent)).toEqual([
      supplyTitle("prHeadCheckout"),
      supplyTitle("scriptInjection"),
      supplyTitle("unpinnedActions"),
      supplyTitle("workflowPermissions"),
      supplyTitle("keyFiles"),
    ]);
    expect(within(rows[0]!).getByText("Met")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("No workflow does this.")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Not met")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("1 use of an action is not pinned to a commit.")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(copy.security.tags.countsTowardsGrade)).toBeInTheDocument();
  });

  it("lists what was found with its file and line, and says where the workflow files were read from", () => {
    render(<SupplyChainCard report={securityReport()} group="workflows" />);
    expect(screen.getByText(".github/workflows/ci.yml line 12")).toBeInTheDocument();
    expect(screen.getByText("acme-tools/setup@v2")).toBeInTheDocument();
    expect(screen.getByText("Read from commit abcdef1 on 1 Mar 2026, 10:05, covering 3 workflow files.")).toBeInTheDocument();
  });

  it("marks advice as advice only, in the files and tools sections", () => {
    const { unmount } = render(<SupplyChainCard report={securityReport()} group="files" />);
    expect(screen.getAllByText(copy.security.tags.advice)).toHaveLength(1);
    expect(screen.getByText("No security policy was found.")).toBeInTheDocument();
    expect(screen.queryByText(/CODEOWNERS/)).not.toBeInTheDocument();
    unmount();
    render(<SupplyChainCard report={securityReport()} group="tools" />);
    expect(screen.getByText("No code scanner was found.")).toBeInTheDocument();
  });

  it("says how many workflow files could not be read, in the singular and the plural", () => {
    const chain = securityReport().supplyChain;
    if (chain.status !== "ok") throw new Error("fixture");
    const { rerender } = render(
      <SupplyChainCard report={securityReport({ supplyChain: { ...chain, workflowsUnread: ["a.yml"] } })} group="workflows" />,
    );
    expect(screen.getByText("1 workflow file was not read, so it is left out of the checks.")).toBeInTheDocument();
    expect(screen.getByText("a.yml")).toBeInTheDocument();
    rerender(
      <SupplyChainCard
        report={securityReport({ supplyChain: { ...chain, workflowsUnread: ["a.yml", "b.yml"] } })}
        group="workflows"
      />,
    );
    expect(screen.getByText("2 workflow files were not read, so they are left out of the checks.")).toBeInTheDocument();
    expect(screen.getByText("b.yml")).toBeInTheDocument();
  });

  it("says how many Dockerfiles were not read on the container images card, with the paths behind a button", async () => {
    const user = userEvent.setup();
    const chain = securityReport().supplyChain;
    if (chain.status !== "ok") throw new Error("fixture");
    const paths = Array.from({ length: 7 }, (_, i) => `svc${i}/Dockerfile`);
    render(
      <SupplyChainCard
        report={securityReport({ supplyChain: { ...chain, dockerfilesUnread: paths, dockerfilesUnreadTotal: 250 } })}
        group="images"
      />,
    );
    expect(screen.getByText("250 Dockerfiles were not read, so they are left out of the checks.")).toBeInTheDocument();
    expect(screen.getByText("svc4/Dockerfile")).toBeInTheDocument();
    expect(screen.queryByText("svc5/Dockerfile")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 7 of 250.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.space.showAll(7) }));
    expect(screen.getByText("svc6/Dockerfile")).toBeInTheDocument();
  });

  it("says one Dockerfile in the singular, and nothing when every file was read", () => {
    const chain = securityReport().supplyChain;
    if (chain.status !== "ok") throw new Error("fixture");
    const { rerender } = render(
      <SupplyChainCard
        report={securityReport({ supplyChain: { ...chain, dockerfilesUnread: ["Dockerfile"], dockerfilesUnreadTotal: 1 } })}
        group="images"
      />,
    );
    expect(screen.getByText("1 Dockerfile was not read, so it is left out of the checks.")).toBeInTheDocument();
    rerender(<SupplyChainCard report={securityReport()} group="images" />);
    expect(screen.queryByText(/not read, so/)).not.toBeInTheDocument();
  });

  it("shows five items and the rest behind a button, and says how many there are in all", async () => {
    const user = userEvent.setup();
    const chain = securityReport().supplyChain;
    if (chain.status !== "ok") throw new Error("fixture");
    const items = Array.from({ length: 7 }, (_, i) => ({ path: `.github/workflows/w${i}.yml`, line: i + 1, detail: null }));
    const line: SupplyChainLine = { check: "unpinnedActions", met: false, graded: true, items, total: 60 };
    render(<SupplyChainCard report={securityReport({ supplyChain: { ...chain, lines: [line] } })} group="workflows" />);
    expect(screen.getAllByText(/^\.github\/workflows\/w\d\.yml line \d$/)).toHaveLength(5);
    expect(screen.getByText("Showing 7 of 60.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.space.showAll(7) }));
    expect(screen.getAllByText(/^\.github\/workflows\/w\d\.yml line \d$/)).toHaveLength(7);
  });

  it("explains why nothing was read when code analysis is off or the files have not been read yet", () => {
    const { rerender } = render(
      <SupplyChainCard report={noSecurity({ supplyChain: { status: "none", reason: "analysis_off" } })} group="workflows" />,
    );
    expect(screen.getByText(copy.security.chain.none.analysis_off)).toBeInTheDocument();
    rerender(<SupplyChainCard report={noSecurity()} group="workflows" />);
    expect(screen.getByText(copy.security.chain.none.not_read)).toBeInTheDocument();
  });

  it("leaves the other sections out when the files were not read, so the notice is not repeated", () => {
    const { container } = render(
      <>
        {(["files", "tools", "images", "updates"] as const).map((group) => (
          <SupplyChainCard key={group} report={noSecurity()} group={group} />
        ))}
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says there is nothing to check in a section the report has no lines for", () => {
    render(<SupplyChainCard report={securityReport()} group="updates" />);
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("check-row"))).toHaveLength(2);
    const chain = securityReport().supplyChain;
    if (chain.status !== "ok") throw new Error("fixture");
    render(<SupplyChainCard report={securityReport({ supplyChain: { ...chain, lines: [] } })} group="images" />);
    expect(screen.getByText(copy.security.chain.nothingFound)).toBeInTheDocument();
  });
});

const supplyTitle = (id: keyof typeof copy.security.supplyChain) => copy.security.supplyChain[id].title;

describe("BranchProtectionCard", () => {
  it("shows each rule and setting as Met, Not met or Not visible, each with its words", () => {
    render(<BranchProtectionCard report={securityReport()} />);
    const row = (label: string) => screen.getByText(label, { selector: ".check-row-title" }).closest("li")!;
    expect(within(row(copy.security.branch.rules.requirePullRequest)).getByText("Met")).toBeInTheDocument();
    expect(within(row(copy.security.branch.rules.blockForcePushes)).getByText("Not met")).toBeInTheDocument();
    expect(within(row(copy.security.branch.rules.requireStatusChecks)).getByText("Not visible")).toBeInTheDocument();
    expect(within(row(copy.security.branch.settings.pushProtection)).getByText("Not met")).toBeInTheDocument();
    expect(within(row(copy.security.branch.settings.dependabotSecurityUpdates)).getByText("Met")).toBeInTheDocument();
    expect(within(row(copy.security.branch.settings.secretScanning)).getByText("Not visible")).toBeInTheDocument();
  });

  it("shows only the rules about protection from direct pushes, rewrites and deletion, and none about approvals", () => {
    render(<BranchProtectionCard report={securityReport()} />);
    const titles = [...document.querySelectorAll(".check-row-title")].map((el) => el.textContent);
    const rules = copy.security.branch.rules;
    expect(titles).toEqual(
      expect.arrayContaining([
        rules.requirePullRequest,
        rules.requireStatusChecks,
        rules.blockForcePushes,
        rules.blockDeletion,
        rules.requireSignedCommits,
      ]),
    );
    expect(Object.keys(rules)).toEqual([
      "requirePullRequest",
      "requireStatusChecks",
      "blockForcePushes",
      "blockDeletion",
      "requireSignedCommits",
    ]);
    expect(screen.queryByText(/approv|code owner|linear/i)).not.toBeInTheDocument();
  });

  it("says why some rules are not visible, and that it does not mean they are off", () => {
    render(<BranchProtectionCard report={securityReport()} />);
    expect(screen.getByText(copy.security.branch.notVisibleTitle)).toBeInTheDocument();
    expect(screen.getByText(/It does not mean the setting is off\./)).toBeInTheDocument();
  });

  it("describes the branch, what the account could read and when", () => {
    render(<BranchProtectionCard report={securityReport()} />);
    expect(screen.getByText(/^The deploy branch is main in a public repository\./)).toBeInTheDocument();
    expect(screen.getByText(/The branch is protected\. Only rulesets could be read/)).toBeInTheDocument();
    expect(screen.getByText(/Read on 1 Mar 2026, 10:03\./)).toBeInTheDocument();
  });

  it("never says only rulesets could be read for an unprotected branch or for an administrator", () => {
    const base = securityReport();
    const posture = base.posture!;
    const { rerender } = render(<BranchProtectionCard report={base} />);
    expect(screen.getByText(/Only rulesets could be read/)).toBeInTheDocument();
    rerender(
      <BranchProtectionCard
        report={{ ...base, posture: { ...posture, branch: { ...posture.branch, protected: false, detail: "rulesets_only" } } }}
      />,
    );
    expect(screen.getByText(/The branch is not protected\./)).toBeInTheDocument();
    expect(screen.queryByText(/Only rulesets could be read/)).not.toBeInTheDocument();
    rerender(<BranchProtectionCard report={{ ...base, posture: { ...posture, isAdmin: true } }} />);
    expect(screen.queryByText(/Only rulesets could be read/)).not.toBeInTheDocument();
    expect(screen.getByText(/The account the dashboard uses is an administrator/)).toBeInTheDocument();
  });

  it("shows private vulnerability reporting and advisories as public only, neutrally, on a private repository", () => {
    const base = securityReport();
    const posture = base.posture!;
    render(
      <BranchProtectionCard
        report={{
          ...base,
          posture: {
            ...posture,
            visibility: "private",
            isAdmin: true,
            branch: {
              ...posture.branch,
              rules: {
                requirePullRequest: true,
                requiredApprovals: 1,
                dismissStaleReviews: true,
                requireCodeOwnerReview: true,
                requireStatusChecks: true,
                blockForcePushes: true,
                blockDeletion: true,
                requireSignedCommits: true,
                requireLinearHistory: true,
              },
            },
            settings: {
              dependabotSecurityUpdates: true,
              secretScanning: true,
              pushProtection: true,
              validityChecks: true,
              privateVulnerabilityReporting: null,
            },
            advisories: null,
          },
        }}
      />,
    );
    const row = screen
      .getByText(copy.security.branch.settings.privateVulnerabilityReporting, { selector: ".check-row-title" })
      .closest("li")!;
    expect(within(row).getByText(copy.security.branch.publicOnly)).toBeInTheDocument();
    expect(within(row).queryByText("Not visible")).not.toBeInTheDocument();
    expect(screen.getByText(copy.security.branch.publicOnly, { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(copy.security.branch.advisoriesHidden)).not.toBeInTheDocument();
    // Nothing is actually hidden, so the explainer about administrators has no place.
    expect(screen.queryByText(copy.security.branch.notVisibleTitle)).not.toBeInTheDocument();
  });

  it("says advisories are not visible, or counts them by state", () => {
    const base = securityReport();
    const { rerender } = render(<BranchProtectionCard report={base} />);
    expect(screen.getByText(copy.security.branch.advisoriesHidden)).toBeInTheDocument();
    rerender(
      <BranchProtectionCard
        report={{ ...base, posture: { ...base.posture!, advisories: { draft: 0, triage: 2, published: 1, closed: 5 } } }}
      />,
    );
    expect(screen.getByText("0 in draft, 2 in triage, 1 published and 5 closed.")).toBeInTheDocument();
  });

  it("leaves out the not visible explanation when every rule, setting and advisory could be seen", () => {
    const base = securityReport();
    const posture = base.posture!;
    const seen = {
      ...posture,
      isAdmin: true,
      branch: {
        ...posture.branch,
        rules: {
          requirePullRequest: true,
          requiredApprovals: 2,
          dismissStaleReviews: true,
          requireCodeOwnerReview: true,
          requireStatusChecks: true,
          blockForcePushes: true,
          blockDeletion: true,
          requireSignedCommits: false,
          requireLinearHistory: false,
        },
      },
      settings: {
        dependabotSecurityUpdates: true,
        secretScanning: true,
        pushProtection: true,
        validityChecks: false,
        privateVulnerabilityReporting: false,
      },
      advisories: { draft: 0, triage: 0, published: 0, closed: 0 },
    };
    render(<BranchProtectionCard report={{ ...base, posture: seen, postureReadAt: null }} />);
    expect(screen.queryByText(copy.security.branch.notVisibleTitle)).not.toBeInTheDocument();
    // Signed commits, the validity checks and private reporting. The history rule is no longer shown.
    expect(screen.getAllByText("Not met")).toHaveLength(3);
  });

  it("says quietly that the facts are from an earlier read when the latest attempt failed, and keeps showing them", () => {
    const { rerender } = render(<BranchProtectionCard report={securityReport({ postureError: "GitHub is down" })} />);
    expect(screen.getByText(copy.security.branch.postureError)).toBeInTheDocument();
    expect(screen.getByText("Changes need a pull request")).toBeInTheDocument();
    rerender(<BranchProtectionCard report={securityReport({ postureError: null })} />);
    expect(screen.queryByText(copy.security.branch.postureError)).not.toBeInTheDocument();
  });

  it("says the settings have not been read yet when there is no posture", () => {
    render(<BranchProtectionCard report={noSecurity()} />);
    expect(screen.getByText(copy.security.branch.notRead)).toBeInTheDocument();
    expect(screen.queryByText("Met")).not.toBeInTheDocument();
  });
});

describe("DependencyUpdatesCard", () => {
  it("shows the update pull request figures, with the time to merge and the oldest still open through the one duration formatter", () => {
    render(<DependencyUpdatesCard report={securityReport()} />);
    expect(tile(copy.security.updates.opened)).toHaveTextContent("5");
    expect(tile(copy.security.updates.merged)).toHaveTextContent("3");
    expect(tile(copy.security.updates.closed)).toHaveTextContent("1");
    expect(tile(copy.security.updates.openNow)).toHaveTextContent("1");
    expect(tile(copy.security.updates.timeToMerge)).toHaveTextContent("30.0 h");
    expect(tile(copy.security.updates.timeToMerge)).toHaveTextContent("Across 4 merged update pull requests.");
    // 12 days is 288 hours, which is written as 12.0 days.
    expect(tile(copy.security.updates.oldest)).toHaveTextContent("12.0 days");
    expect(screen.getByText(copy.security.updates.good)).toBeInTheDocument();
  });

  it("shows whether updates are scheduled and lockfiles are in place", () => {
    render(<DependencyUpdatesCard report={securityReport()} />);
    expect(screen.getByText("No configuration was found.")).toBeInTheDocument();
    expect(screen.getByText("Every manifest has a lockfile.")).toBeInTheDocument();
  });

  it("says no update pull requests were found, and that none are open", () => {
    render(<DependencyUpdatesCard report={noSecurity()} />);
    expect(screen.getByText(copy.security.updates.noneYet)).toBeInTheDocument();
    expect(tile(copy.security.updates.oldest)).toHaveTextContent("No data");
    expect(screen.getByText(copy.security.updates.oldestNone)).toBeInTheDocument();
    expect(tile(copy.security.updates.timeToMerge)).toHaveTextContent("No update pull request was merged in this range.");
    expect(screen.queryByText(copy.security.chain.none.not_read)).not.toBeInTheDocument();
  });

  it("says nothing more when pull requests are open but none was merged", () => {
    const base = securityReport();
    render(
      <DependencyUpdatesCard report={securityReport({ dependencyUpdates: { ...base.dependencyUpdates, mergedInRange: 0 } })} />,
    );
    expect(screen.queryByText(copy.security.updates.good)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.security.updates.noneYet)).not.toBeInTheDocument();
  });

  it("says one merged update in the singular", () => {
    const base = securityReport();
    render(
      <DependencyUpdatesCard
        report={securityReport({
          dependencyUpdates: { ...base.dependencyUpdates, timeToMerge: { count: 1, median: 5, p75: 5, mean: 5 } },
        })}
      />,
    );
    expect(screen.getByText("Across 1 merged update pull request.")).toBeInTheDocument();
  });
});

describe("SecurityIssuesCard", () => {
  it("shows the open, oldest, closed and time to close figures with a link to the issues page", () => {
    renderRoute(<SecurityIssuesCard report={securityReport()} />);
    expect(tile(copy.security.issues.open)).toHaveTextContent("2");
    // 20 days is 480 hours, written as 20.0 days, and 72 hours as 3.0 days.
    expect(tile(copy.security.issues.oldest)).toHaveTextContent("20.0 days");
    expect(tile(copy.security.issues.closed)).toHaveTextContent("1");
    expect(tile(copy.security.issues.timeToClose)).toHaveTextContent("3.0 days");
    expect(tile(copy.security.issues.timeToClose)).toHaveTextContent("Across 4 closed issues.");
    expect(screen.getByRole("link", { name: copy.security.issues.link })).toHaveAttribute("href", "/issues/1");
    expect(screen.getByRole("link", { name: copy.security.issues.link }).closest("p")).toHaveClass("screen-only");
  });

  it("says security issues are not counted when the repository has no stored issues", () => {
    renderRoute(<SecurityIssuesCard report={noSecurity()} />);
    expect(screen.getByText(copy.security.issues.none)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says none are open when the oldest is not there, and writes the plural of closed issues", () => {
    const issues = securityReport().securityIssues!;
    renderRoute(
      <SecurityIssuesCard
        report={securityReport({
          securityIssues: { ...issues, oldestOpenDays: null, open: 0, timeToClose: { count: 3, median: 5, p75: 5, mean: 5 } },
        })}
      />,
    );
    expect(tile(copy.security.issues.oldest)).toHaveTextContent("No data");
    expect(screen.getByText(copy.security.issues.oldestNone)).toBeInTheDocument();
    expect(screen.getByText("Across 3 closed issues.")).toBeInTheDocument();
  });

  it("says nothing was closed in the range when none was", () => {
    const issues = securityReport().securityIssues!;
    renderRoute(
      <SecurityIssuesCard
        report={securityReport({ securityIssues: { ...issues, timeToClose: { count: 0, median: null, p75: null, mean: null } } })}
      />,
    );
    expect(screen.getByText(copy.security.issues.timeToCloseHint(0))).toBeInTheDocument();
  });
});

describe("ScorecardCard", () => {
  it("shows the score out of 10 with the date and a table of its checks, and says it never changes the grade", () => {
    render(<ScorecardCard report={securityReport()} />);
    expect(tile(copy.security.scorecard.score)).toHaveTextContent("6.4 out of 10");
    expect(tile(copy.security.scorecard.score)).toHaveTextContent("Scanned on 28 Feb 2026.");
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent))).toEqual([
      ["Branch-Protection", "3 out of 10", "branch protection is not maximal"],
      ["Fuzzing", "Not applicable", "no fuzzer integration found"],
    ]);
    expect(screen.getByText(/never changes the grade/)).toBeInTheDocument();
  });

  it("says that only public projects in Scorecard's weekly scan have a score", () => {
    render(<ScorecardCard report={securityReport()} />);
    expect(screen.getByText(copy.security.scorecard.only)).toBeInTheDocument();
  });

  it.each(["off", "not_public", "not_scanned", "error"] as const)("explains the %s status and shows no score", (status) => {
    render(<ScorecardCard report={securityReport({ scorecard: null, scorecardStatus: status })} />);
    expect(screen.getByText(copy.security.scorecard.status[status])).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says the Scorecard retry rules as they are, not that it is tried at every crawl", () => {
    render(<ScorecardCard report={securityReport({ scorecard: null, scorecardStatus: "error" })} />);
    const text = screen.getByText(copy.security.scorecard.status.error).textContent!;
    expect(text).toContain("more than a day old");
    expect(text).toContain("every full crawl");
    expect(text).not.toContain("next crawl");
  });

  it("treats an ok status with no result as not scanned", () => {
    render(<ScorecardCard report={securityReport({ scorecard: null, scorecardStatus: "ok" })} />);
    expect(screen.getByText(copy.security.scorecard.status.not_scanned)).toBeInTheDocument();
  });
});

describe("SourcesPanel", () => {
  const state = (overrides: Partial<SourceState>): SourceState => ({
    status: "ok",
    reason: null,
    readAt: "2026-03-01T10:00:00Z",
    attemptedAt: null,
    truncated: false,
    error: null,
    ...overrides,
  });
  const card = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li")!;

  it("is a section other parts of the page can link to", () => {
    const { container } = render(<SourcesPanel report={securityReport()} />);
    expect(container.querySelector("section#security-sources")).not.toBeNull();
  });

  it("shows each source with its state in a word and an icon, and when it was read", () => {
    render(<SourcesPanel report={securityReport()} />);
    expect(card("Dependabot alerts")).toHaveTextContent("Read");
    expect(card("Dependabot alerts")).toHaveTextContent("Read on 1 Mar 2026, 10:00");
    expect(card("OSV.dev lookup")).toHaveTextContent("Switched off");
    // A lookup that is not in use was never going to be read, so it carries no read line.
    expect(card("OSV.dev lookup")).not.toHaveTextContent("Not read yet");
    expect(card("Workflow and dependency files")).toHaveTextContent("Read from commit abcdef1");
    expect(card("Branch rules and settings")).toHaveTextContent("Read on 1 Mar 2026, 10:03.");
  });

  it("gives the time once for the workflow files and the branch settings, whose own sentence already carries it", () => {
    render(<SourcesPanel report={securityReport()} />);
    const times = (text: string) => text.match(/1 Mar 2026, 10:0\d/g) ?? [];
    expect(times(card("Workflow and dependency files").textContent ?? "")).toHaveLength(1);
    expect(times(card("Branch rules and settings").textContent ?? "")).toHaveLength(1);
  });

  it("says how to switch on each source that is off, with a link to the Dependabot settings", () => {
    const base = securityReport();
    render(
      <SourcesPanel
        report={{
          ...base,
          sources: {
            dependabot: state({ status: "off", reason: "disabled", readAt: null }),
            code_scanning: state({ status: "off", reason: "needs_advanced_security", readAt: null }),
            secret_scanning: state({ status: "no_access", reason: "admin_only_or_off", readAt: null }),
            osv: base.sources.osv,
          },
        }}
      />,
    );
    const dependabot = card("Dependabot alerts");
    expect(dependabot).toHaveTextContent(
      "How to switch it on. Open the repository's Settings, choose Advanced Security in the Security section of the sidebar, and switch on Dependabot alerts",
    );
    expect(within(dependabot).getByRole("link", { name: new RegExp(copy.security.settingsLink) })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/settings/security_analysis",
    );
    expect(card("Code scanning")).toHaveTextContent("GitHub Code Security");
    expect(card("Code scanning")).toHaveTextContent("Switched off");
    expect(card("Secret scanning")).toHaveTextContent("No access");
    expect(card("Secret scanning")).toHaveTextContent("only be read by a repository administrator");
    expect(within(card("Code scanning")).queryByRole("link")).not.toBeInTheDocument();
    expect(card("OSV.dev lookup")).toHaveTextContent("OSV_LOOKUP=on");
    expect(card("OSV.dev lookup")).toHaveTextContent("never your repository name, a path or a token");
  });

  it("shows an OSV lookup that Dependabot made unnecessary as neutral information, not as a failure", () => {
    const base = securityReport();
    render(
      <SourcesPanel
        report={{ ...base, sources: { ...base.sources, osv: state({ status: "off", reason: "dependabot_ok", readAt: null }) } }}
      />,
    );
    const osv = card("OSV.dev lookup");
    expect(osv).toHaveTextContent(copy.security.sources.notNeeded);
    // Something that is not needed was never going to be read, so it has no read line at all.
    expect(osv).not.toHaveTextContent(copy.security.sources.notYet);
    expect(osv).not.toHaveTextContent(/Read on/);
    expect(osv).not.toHaveTextContent(copy.security.passFail.unmet);
    expect(osv.querySelector(".checks-none")).not.toBeNull();
    expect(osv.querySelector(".checks-failing")).toBeNull();
    // A source that is off for another reason is still drawn as not met.
    const off = card("Dependabot alerts");
    expect(off.querySelector(".checks-failing")).toBeNull();
    expect(off.querySelector(".checks-passing")).not.toBeNull();
  });

  it("draws a source that is off or refused as not met, and one never read as neutral", () => {
    const base = securityReport();
    render(
      <SourcesPanel
        report={{
          ...base,
          sources: {
            dependabot: state({ status: "off", reason: "disabled", readAt: null }),
            code_scanning: state({ status: "no_access", reason: "forbidden", readAt: null }),
            secret_scanning: state({ status: "not_read", reason: null, readAt: null }),
            osv: state({ status: "error", error: "down", readAt: null }),
          },
        }}
      />,
    );
    expect(card("Dependabot alerts").querySelector(".checks-failing")).not.toBeNull();
    expect(card("Code scanning").querySelector(".checks-failing")).not.toBeNull();
    expect(card("Secret scanning").querySelector(".checks-none")).not.toBeNull();
    expect(card("OSV.dev lookup").querySelector(".checks-failing")).not.toBeNull();
  });

  it("offers no settings link when the stored address is not a web address", () => {
    const base = securityReport();
    render(
      <SourcesPanel
        report={{
          ...base,
          settingsUrl: "javascript:alert(1)",
          sources: { ...base.sources, dependabot: state({ status: "off", reason: "disabled", readAt: null }) },
        }}
      />,
    );
    expect(within(card("Dependabot alerts")).queryByRole("link")).not.toBeInTheDocument();
    expect(card("Dependabot alerts")).toHaveTextContent("How to switch it on.");
  });

  it("says a failed read keeps the earlier results", () => {
    const base = securityReport();
    render(
      <SourcesPanel
        report={{ ...base, sources: { ...base.sources, code_scanning: state({ status: "error", error: "GitHub is down" }) } }}
      />,
    );
    expect(card("Code scanning")).toHaveTextContent("Failed");
    expect(card("Code scanning")).toHaveTextContent('"GitHub is down". Earlier results are kept.');
  });

  it("says the files and the settings have not been read when they have not", () => {
    render(<SourcesPanel report={noSecurity()} />);
    expect(card("Workflow and dependency files")).toHaveTextContent("These files have not been read yet.");
    expect(card("Workflow and dependency files")).toHaveTextContent("CODE_ANALYSIS=on");
    expect(card("Branch rules and settings")).toHaveTextContent("They have not been read yet.");
    expect(card("Branch rules and settings")).toHaveTextContent("Most repository settings need a repository administrator.");
  });
});
