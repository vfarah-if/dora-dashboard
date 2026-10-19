import type { SupplyChainCheckId, SupplyChainItem, WorkflowCondition, WorkflowRoute, WorldTrigger } from "@dora-dashboard/core";
import { copy } from "../copy";

const c = copy.security.findingDetail;

// Typed by core's world triggers, so a name core does not start a world with fails the build.
const COMMENT_OR_ISSUE: ReadonlySet<string> = new Set<WorldTrigger>([
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
]);
const PULL_REQUEST: ReadonlySet<string> = new Set<WorldTrigger>([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
]);

/** Who started the run, in words, from the trigger the line is reached through; an unknown trigger is any outsider's event. */
export function outsiderOf(trigger: string | null): string {
  if (trigger !== null && PULL_REQUEST.has(trigger)) return c.subject.pullRequest;
  if (trigger !== null && COMMENT_OR_ISSUE.has(trigger)) return c.subject.commentOrIssue;
  return c.subject.other;
}

const hopsText = (via: NonNullable<WorkflowRoute["via"]>): string =>
  via.map((hop) => c.route.hop(hop.file, hop.job)).join(c.route.hopJoin);

/** One route as a sentence. An overflow route has no hops and stands for every route past the caps. */
export function routeSentence(route: WorkflowRoute): string {
  if (route.via === null) return c.route.overflow;
  if (route.trigger === null)
    return route.via.length === 0 ? c.route.unreadTrigger : c.route.unreadTriggerVia(hopsText(route.via));
  return route.via.length === 0 ? c.route.own(route.trigger) : c.route.via(route.trigger, hopsText(route.via));
}

/** One condition as a sentence, by what the dashboard could prove about it. */
export function conditionSentence(condition: WorkflowCondition, subject: string): string {
  const { file, line, text, verdict } = condition;
  if (verdict === "holds") return c.condition.holds(file, line, text, subject);
  return verdict === "unknown" ? c.condition.unknown(file, line, text) : c.condition.unreadable(file, line, text);
}

/**
 * Why a finding is a risk in this repository. The first sentence says what the check is about, and the rest come from
 * the routes the line is reached through and the conditions on the way that did not rule the event out.
 */
export function whySentences(check: SupplyChainCheckId, item: SupplyChainItem): string[] {
  const subject = outsiderOf(item.routes.find((route) => route.trigger !== null)?.trigger ?? null);
  return [
    c.why[check],
    ...item.routes.map(routeSentence),
    ...(item.routesDropped > 0 ? [c.route.dropped(item.routesDropped)] : []),
    ...item.conditions.map((condition) => conditionSentence(condition, subject)),
    ...(item.conditionsDropped > 0 ? [c.condition.dropped(item.conditionsDropped)] : []),
  ];
}
