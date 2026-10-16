import type { SecurityAction, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import {
  ACTION_EFFORT,
  actionKey,
  actionSentence,
  dependabotAlertsOn,
  safeHttpUrl,
  severityLabel,
  updateConfigPath,
} from "../lib/security";
import {
  LEARN_MORE,
  codeAlertAdvice,
  settingsLinkFor,
  snippetsFor,
  upgradeInstruction,
  type FixContext,
} from "../lib/securityFixes";
import { CopySnippet } from "./CopySnippet";
import { ExternalLink } from "./ExternalLink";
import { PathText } from "./PathText";
import { EffortTag, LikelyExploitedTag, SecurityBlock, SecurityList, Tag } from "./SecurityParts";

const c = copy.security;

export function fixContext(report: SecurityReport): FixContext {
  return {
    ecosystems: report.ecosystems,
    branch: report.repo.deployBranch,
    settingsUrl: report.settingsUrl,
    versionUpdates: report.dependabotVersionUpdates,
    updateConfig: updateConfigPath(report),
    dependabotAlertsOn: dependabotAlertsOn(report),
    // The CodeQL upload needs GitHub code scanning, which a private repository has only with GitHub Code Security.
    codeScanning: report.posture?.value.visibility === "public" || report.sources.code_scanning.status === "ok",
    thresholds: report.thresholds,
    privateReporting: report.posture?.value.settings.privateVulnerabilityReporting === true,
  };
}

function Refs({ refs }: { refs: SecurityAction["refs"] }) {
  if (refs.length === 0) return null;
  return (
    <>
      <h3 className="action-heading">{c.affected}</h3>
      <ul className="action-refs">
        {refs.map((ref, i) => {
          const url = safeHttpUrl(ref.url);
          return (
            <li key={`${ref.label}-${i}`} className="mono">
              {url ? <ExternalLink href={url}>{ref.label}</ExternalLink> : <PathText text={ref.label} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * One thing to fix. The explanation sits in a native disclosure, and the printed report keeps it as it is on screen,
 * so what is closed on screen stays closed on paper.
 */
export function ActionItem({ action, context }: { action: SecurityAction; context: FixContext }) {
  const fix = c.fix[action.kind];
  const alt =
    action.kind === "enable_dependabot" && context.versionUpdates
      ? c.dependabotAlerts
      : action.kind === "enable_security_updates" && (context.updateConfig || context.dependabotAlertsOn)
        ? c.securityUpdates
        : null;
  const sentence = actionSentence(
    action,
    context.versionUpdates ?? null,
    context.thresholds ?? null,
    context.updateConfig ?? null,
    context.dependabotAlertsOn ?? false,
  );
  const snippets = snippetsFor(action, context);
  const settings = settingsLinkFor(action.kind, context.settingsUrl);
  const settingsUrl = settings ? safeHttpUrl(settings.url) : null;
  const instruction = upgradeInstruction(action) ?? codeAlertAdvice(action);
  const learn = LEARN_MORE[action.kind];
  const learnUrl = learn ? safeHttpUrl(learn) : null;
  return (
    <li className="action-item">
      <p className="action-sentence">{sentence}</p>
      <p className="action-tags">
        <EffortTag effort={ACTION_EFFORT[action.kind]} />
        {action.severity && <Tag>{severityLabel(action.severity)}</Tag>}
        {action.onPath && action.band && <Tag tone="accent">{c.tags.holdsGrade(copy.dora.band[action.band])}</Tag>}
        {action.band === null && <Tag>{c.tags.advice}</Tag>}
        {action.likelyExploited && <LikelyExploitedTag />}
      </p>
      <details className="action-details">
        <summary>
          {c.fixTitle}
          <span className="visually-hidden"> {sentence}</span>
        </summary>
        <div className="action-body">
          <h3 className="action-heading">{c.why}</h3>
          <p>{alt ? alt.why : fix.why}</p>
          <h3 className="action-heading">{c.steps}</h3>
          <ol className="action-steps">
            {(alt ? alt.steps : fix.steps).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {instruction && <p className="action-instruction">{instruction}</p>}
          {snippets.map((snippet) => (
            <CopySnippet
              key={snippet.id}
              label={snippet.label}
              code={snippet.code}
              note={snippet.note}
              instead={snippet.instead}
            />
          ))}
          <Refs refs={action.refs} />
          <p className="action-links">
            {settings && settingsUrl && (
              <ExternalLink href={settingsUrl}>{settings.branch ? c.branchSettingsLink : c.settingsLink}</ExternalLink>
            )}
            {learnUrl && <ExternalLink href={learnUrl}>{c.learnMore}</ExternalLink>}
          </p>
        </div>
      </details>
    </li>
  );
}

/** What to fix first, as a numbered list with the first ten shown and the rest behind a button. Prints as it shows. */
export function SecurityActions({ report }: { report: SecurityReport }) {
  const context = fixContext(report);
  const actions = report.actions;
  return (
    <SecurityBlock id="security-actions" title={c.actions.title} lede={c.actions.lede}>
      {actions.length === 0 ? (
        <p className="chart-empty">{c.actions.none}</p>
      ) : (
        <>
          <p className="chart-subtitle">{c.actions.counting(actions.length)}</p>
          <SecurityList total={actions.length} limit={10} what={c.actions.what}>
            {(limit) => (
              <ol className="action-list">
                {actions.slice(0, limit).map((action, index) => (
                  <ActionItem key={actionKey(action, index)} action={action} context={context} />
                ))}
              </ol>
            )}
          </SecurityList>
        </>
      )}
    </SecurityBlock>
  );
}
