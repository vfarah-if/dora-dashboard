import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupplyChainItem, SupplyChainLine } from "@dora-dashboard/core";
import { copy } from "../copy";
import { chainItem } from "../test/fixtures";
import { renderRoute } from "../test/render";
import { FindingRow } from "./FindingRow";

const d = copy.security.findingDetail;
const URL = "https://github.com/acme/widgets/blob/abcdef1234567890/.github/workflows/db-migrate.yml#L231";

const lineFor = (check: SupplyChainLine["check"]): SupplyChainLine => ({
  check,
  met: false,
  graded: true,
  items: [],
  total: 1,
  accepted: 0,
  absence: null,
});

const checkout = (extra: Partial<SupplyChainItem> = {}) =>
  chainItem(".github/workflows/db-migrate.yml", 231, "github.event.workflow_run.head_sha", {
    url: URL,
    risk: "prHeadCheckout",
    fingerprint: "w2:0123456789abcdef",
    routes: [{ trigger: "workflow_run", via: [{ file: ".github/workflows/deploy.yml", job: "deploy-db" }] }],
    conditions: [{ file: ".github/workflows/deploy.yml", line: 19, text: "always()", verdict: "holds" }],
    ...extra,
  });

function show(item: SupplyChainItem, check: SupplyChainLine["check"] = "prHeadCheckout") {
  const result = renderRoute(
    <ul>
      <FindingRow repoId={1} line={lineFor(check)} item={item} />
    </ul>,
  );
  return { ...result, user: userEvent.setup(), row: result.container.querySelector<HTMLElement>(".finding-row")! };
}

describe("FindingRow", () => {
  it("shows the linked path and line with the evidence in code", () => {
    const { row } = show(checkout());
    const link = within(row).getByRole("link", { name: /db-migrate\.yml line 231/ });
    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(row).getByText("github.event.workflow_run.head_sha").tagName).toBe("CODE");
  });

  it("shows plain text when there is no link, and never links a javascript address", () => {
    const { row, unmount } = show(checkout({ url: null }));
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    unmount();
    const again = show(checkout({ url: "javascript:alert(1)" }));
    expect(within(again.row).queryByRole("link")).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("keeps the explanation closed in a disclosure, named for the place, until it is opened", async () => {
    const { row, user } = show(checkout());
    const details = row.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    const summary = within(row).getByText(d.summary, { selector: "summary" });
    expect(summary).toHaveAccessibleName(`${d.summary} .github/workflows/db-migrate.yml line 231`);
    await user.click(summary);
    expect(details).toHaveAttribute("open");
  });

  it("answers why, how it was found and what would clear it, as a list of terms and not as headings", () => {
    const { row } = show(checkout());
    expect(within(row).queryAllByRole("heading")).toHaveLength(0);
    const list = row.querySelector("dl")!;
    expect([...list.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([d.whyTitle, d.foundTitle, d.clearTitle]);
    expect(list.querySelectorAll("dd")).toHaveLength(3);
  });

  it("says a curl piped to a shell was read from the Dockerfile when the item is a Dockerfile, and from the workflow otherwise", () => {
    const dockerfile = show(chainItem("services/api/Dockerfile", 4, "curl | sh"), "curlPipeShell");
    expect(within(dockerfile.row).getByText(copy.security.chain.foundBy.dockerfile)).toBeInTheDocument();
    dockerfile.unmount();
    const workflow = show(chainItem(".github/workflows/ci.yml", 9, "curl | sh"), "curlPipeShell");
    expect(within(workflow.row).getByText(copy.security.chain.foundBy.workflowText)).toBeInTheDocument();
  });

  it("says a finding cannot be accepted until a later read identifies the file, when core sent no fingerprint", () => {
    const { row, unmount } = show(checkout({ fingerprint: null }));
    expect(within(row).queryByRole("button", { name: /Accept/ })).not.toBeInTheDocument();
    const hint = within(row).getByText(copy.security.acceptance.cannotAcceptYet);
    expect(hint).toHaveClass("screen-only");
    unmount();
    const accepted = show(checkout());
    expect(within(accepted.row).queryByText(copy.security.acceptance.cannotAcceptYet)).not.toBeInTheDocument();
  });

  it("explains why from the check, the route and a condition that holds", () => {
    const { row } = show(checkout());
    expect(within(row).getByText(d.why.prHeadCheckout)).toBeInTheDocument();
    expect(
      within(row).getByText("It runs under workflow_run, through .github/workflows/deploy.yml job deploy-db."),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(
        "The condition at .github/workflows/deploy.yml line 19 (always()) does not stop a run that a pull request started.",
      ),
    ).toBeInTheDocument();
  });

  it("explains a condition that names something unknowable as not counted as a guard", () => {
    const { row } = show(
      checkout({
        conditions: [
          { file: ".github/workflows/deploy.yml", line: 19, text: "github.event.inputs.go == ''", verdict: "unknown" },
        ],
      }),
    );
    expect(
      within(row).getByText(
        /names something the dashboard cannot know, such as a label or an input, so it is not counted as a guard\./,
      ),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/does not stop a run/)).not.toBeInTheDocument();
  });

  it("explains an unreadable condition as treated as open", () => {
    const { row } = show(
      checkout({
        conditions: [{ file: ".github/workflows/deploy.yml", line: 19, text: "a ===== b", verdict: "unreadable" }],
      }),
    );
    expect(within(row).getByText(/could not be read, so it was treated as open\./)).toBeInTheDocument();
  });

  it("explains a null trigger, an overflow route and the counts that were dropped", () => {
    const { row } = show(
      checkout({
        routes: [
          { trigger: null, via: [] },
          { trigger: "workflow_run", via: null },
        ],
        routesDropped: 4,
        conditions: [],
        conditionsDropped: 2,
      }),
    );
    expect(within(row).getByText(/triggers of the workflow that starts it could not be read/)).toBeInTheDocument();
    expect(within(row).getByText(d.route.overflow)).toBeInTheDocument();
    expect(within(row).getByText("4 more routes lead to this line and are not listed.")).toBeInTheDocument();
    expect(within(row).getByText("2 more conditions were left out of this list.")).toBeInTheDocument();
  });

  it("says how it was found, in the words for the check", () => {
    const { row } = show(checkout());
    expect(within(row).getByText("Read from the workflow text, with its conditions.")).toBeInTheDocument();
  });

  it("says what would clear a checkout under workflow_run, with the condition in a block to copy", () => {
    const { row } = show(checkout());
    expect(
      within(row).getByText(
        "Add this condition to job deploy-db in .github/workflows/deploy.yml, or to the job in this file, so that a run started by a pull request is skipped.",
      ),
    ).toBeInTheDocument();
    const block = within(row).getByRole("group", { name: copy.security.snippets.workflowRunPush });
    expect(within(block).getByText("if: github.event.workflow_run.event == 'push'")).toBeInTheDocument();
  });

  it("falls back to general wording when the job name is not safe to put in the text", () => {
    const { row } = show(
      checkout({ routes: [{ trigger: "workflow_run", via: [{ file: ".github/workflows/deploy.yml", job: "deploy db; rm" }] }] }),
    );
    expect(within(row).getByText(d.clear.workflowRunHere)).toBeInTheDocument();
    expect(row).not.toHaveTextContent("deploy db; rm job");
  });

  it("lists the generic steps when there is no more specific one, without a block when none fits", () => {
    const { row } = show(chainItem(".env.production", null, null, { fingerprint: `b:${"a".repeat(40)}` }), "keyFiles");
    const steps = within(row.querySelector("ol")!).getAllByRole("listitem");
    expect(steps.map((li) => li.textContent)).toEqual(copy.security.fix.remove_key_files.steps);
    expect(row.querySelector(".copy-snippet")).toBeNull();
  });

  it("offers Accept for a finding with a fingerprint, named for the place", () => {
    const { row } = show(checkout());
    expect(within(row).getByRole("button", { name: "Accept .github/workflows/db-migrate.yml line 231" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("offers no Accept for a finding that has no fingerprint", () => {
    const { row } = show(checkout({ fingerprint: null }));
    expect(within(row).queryByRole("button", { name: /^Accept/ })).not.toBeInTheDocument();
    // The explanation is still there.
    expect(within(row).getByText(d.whyTitle)).toBeInTheDocument();
  });
});
