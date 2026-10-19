import { describe, expect, it } from "vitest";
import type { WorkflowCondition, WorkflowRoute } from "@dora-dashboard/core";
import { SUPPLY_CHAIN_CHECK_IDS } from "./security";
import { copy } from "../copy";
import { chainItem } from "../test/fixtures";
import { conditionSentence, outsiderOf, routeSentence, whySentences } from "./findingWhy";

const via = (file: string, job: string | null) => ({ file, job });
const condition = (verdict: WorkflowCondition["verdict"], text = "always()"): WorkflowCondition => ({
  file: ".github/workflows/deploy.yml",
  line: 19,
  text,
  verdict,
});

describe("outsiderOf", () => {
  it.each([
    ["workflow_run", "a pull request"],
    ["pull_request", "a pull request"],
    ["pull_request_target", "a pull request"],
    ["pull_request_review", "a pull request"],
    ["pull_request_review_comment", "a pull request"],
    ["issue_comment", "a comment or an issue from an outsider"],
    ["issues", "a comment or an issue from an outsider"],
    ["push", "an outsider's event"],
    [null, "an outsider's event"],
  ])("names who starts a run under %s", (trigger, words) => {
    expect(outsiderOf(trigger)).toBe(words);
  });
});

describe("routeSentence", () => {
  it("names the trigger and each call it goes through, with the job where there is one", () => {
    const route: WorkflowRoute = { trigger: "workflow_run", via: [via(".github/workflows/deploy.yml", "deploy-db")] };
    expect(routeSentence(route)).toBe("It runs under workflow_run, through .github/workflows/deploy.yml job deploy-db.");
  });

  it("joins several calls in order, and names a composite action by its file alone", () => {
    const route: WorkflowRoute = {
      trigger: "pull_request_target",
      via: [via("a.yml", "build"), via(".github/actions/setup/action.yml", null)],
    };
    expect(routeSentence(route)).toBe(
      "It runs under pull_request_target, through a.yml job build and then .github/actions/setup/action.yml.",
    );
  });

  it("says the file's own trigger starts it when no call is in between", () => {
    expect(routeSentence({ trigger: "pull_request_target", via: [] })).toBe(
      "It runs under pull_request_target, started by this file's own trigger.",
    );
  });

  it("says the triggers could not be read, and that it is treated as one any outsider's event can start", () => {
    expect(routeSentence({ trigger: null, via: [] })).toMatch(
      /could not be read, so it is treated as one that any outsider's event can start\.$/,
    );
    expect(routeSentence({ trigger: null, via: [via("a.yml", "build")] })).toMatch(
      /could not be read, so it is treated as one that any outsider's event can start, through a\.yml job build\.$/,
    );
  });

  it("says the callers that were not followed are treated as having no condition for an overflow route", () => {
    expect(routeSentence({ trigger: "workflow_run", via: null })).toBe(copy.security.findingDetail.route.overflow);
    expect(routeSentence({ trigger: null, via: null })).toContain(
      "the callers it did not follow are treated as having no condition. Conditions in this file still count.",
    );
  });
});

describe("conditionSentence", () => {
  it("says a condition that holds for the outsider's event does not stop it, with the file, the line and the text", () => {
    expect(conditionSentence(condition("holds"), "a pull request")).toBe(
      "The condition at .github/workflows/deploy.yml line 19 (always()) does not stop a run that a pull request started.",
    );
  });

  it("says a condition on something unknowable, such as a label or an input, is not counted as a guard", () => {
    expect(
      conditionSentence(condition("unknown", "contains(github.event.pull_request.labels.*.name, '')"), "a pull request"),
    ).toBe(
      "The condition at .github/workflows/deploy.yml line 19 (contains(github.event.pull_request.labels.*.name, '')) names something the dashboard cannot know, such as a label or an input, so it is not counted as a guard.",
    );
  });

  it("says an unreadable condition was treated as open", () => {
    expect(conditionSentence(condition("unreadable", "a ===== b"), "a pull request")).toBe(
      "The condition at .github/workflows/deploy.yml line 19 (a ===== b) could not be read, so it was treated as open.",
    );
  });

  it("leaves out the brackets when the text is empty", () => {
    expect(conditionSentence(condition("unreadable", ""), "a pull request")).toBe(
      "The condition at .github/workflows/deploy.yml line 19 could not be read, so it was treated as open.",
    );
  });
});

describe("whySentences", () => {
  it("starts with why the check matters, for every check", () => {
    for (const check of SUPPLY_CHAIN_CHECK_IDS) {
      const [first, ...rest] = whySentences(check, chainItem("a", 1));
      expect(first).toBe(copy.security.findingDetail.why[check]);
      expect(first!.length).toBeGreaterThan(40);
      expect(rest).toEqual([]);
    }
  });

  it("adds each route and each condition, nearest first, then says how many were left out", () => {
    const item = chainItem(".github/workflows/db-migrate.yml", 231, "github.event.workflow_run.head_sha", {
      risk: "prHeadCheckout",
      routes: [{ trigger: "workflow_run", via: [via(".github/workflows/deploy.yml", "deploy-db")] }],
      routesDropped: 2,
      conditions: [condition("holds"), condition("unknown", "github.event.inputs.go")],
      conditionsDropped: 1,
    });
    expect(whySentences("prHeadCheckout", item)).toEqual([
      copy.security.findingDetail.why.prHeadCheckout,
      "It runs under workflow_run, through .github/workflows/deploy.yml job deploy-db.",
      "2 more routes lead to this line and are not listed.",
      "The condition at .github/workflows/deploy.yml line 19 (always()) does not stop a run that a pull request started.",
      "The condition at .github/workflows/deploy.yml line 19 (github.event.inputs.go) names something the dashboard cannot know, such as a label or an input, so it is not counted as a guard.",
      "1 more condition was left out of this list.",
    ]);
  });

  it("says one more route in the singular", () => {
    const item = chainItem("a", 1, null, { routes: [{ trigger: "push", via: [] }], routesDropped: 1 });
    expect(whySentences("scriptInjection", item)).toContain("1 more route leads to this line and is not listed.");
  });

  it("words a condition by the first trigger that is known, and an outsider's event when none is", () => {
    const comment = chainItem("a", 1, null, {
      routes: [
        { trigger: null, via: [] },
        { trigger: "issue_comment", via: [] },
      ],
      conditions: [condition("holds")],
    });
    expect(whySentences("scriptInjection", comment).at(-1)).toContain(
      "a run that a comment or an issue from an outsider started",
    );
    const none = chainItem("a", 1, null, { routes: [{ trigger: null, via: null }], conditions: [condition("holds")] });
    expect(whySentences("scriptInjection", none).at(-1)).toContain("a run that an outsider's event started");
  });
});
