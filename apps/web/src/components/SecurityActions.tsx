import type { SecurityAction, SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { usePrinting } from "../lib/print";
import { ACTION_EFFORT, actionSentence, safeHttpUrl, severityLabel } from "../lib/security";
import { LEARN_MORE, settingsLinkFor, snippetsFor, upgradeInstruction, type FixContext } from "../lib/securityFixes";
import { CopySnippet } from "./CopySnippet";
import { ExternalLink } from "./ExternalLink";
import { PathText } from "./PathText";
import { EffortTag, LikelyExploitedTag, SecurityBlock, Tag } from "./SecurityParts";
import { ShowAllList } from "./ShowAllList";

const c = copy.security;

export function fixContext(report: SecurityReport): FixContext {
  return {
    repo: report.repo,
    ecosystems: report.ecosystems,
    branch: report.posture?.branch.name ?? "main",
    settingsUrl: report.settingsUrl,
    versionUpdates: report.dependabotVersionUpdates,
    // The CodeQL upload needs GitHub code scanning, which a private repository has only with GitHub Code Security.
    codeScanning: report.posture?.visibility === "public" || report.sources.code_scanning.status === "ok",
    thresholds: report.thresholds,
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
 * One thing to fix. The explanation sits in a native disclosure that is forced open when printing. Whether the page is
 * printing is passed in, because an item that only appears for the printed copy would start after the print event had
 * gone, and so would never learn of it.
 */
export function ActionItem({
  action,
  context,
  printing = false,
}: {
  action: SecurityAction;
  context: FixContext;
  printing?: boolean;
}) {
  const fix = c.fix[action.kind];
  const alt = action.kind === "enable_dependabot" && context.versionUpdates ? c.dependabotAlerts : null;
  const sentence = actionSentence(action, context.versionUpdates ?? null, context.thresholds ?? null);
  const snippets = snippetsFor(action, context);
  const settings = settingsLinkFor(action.kind, context.settingsUrl);
  const settingsUrl = settings ? safeHttpUrl(settings.url) : null;
  const instruction = action.kind === "upgrade_dependency" ? upgradeInstruction(action) : null;
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
      <details className="action-details" open={printing ? true : undefined}>
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

/** What to fix first, as a numbered list with the first ten shown and the rest behind a button. Printed in full. */
export function SecurityActions({ report }: { report: SecurityReport }) {
  const printing = usePrinting();
  const context = fixContext(report);
  const actions = report.actions;
  return (
    <SecurityBlock id="security-actions" title={c.actions.title} lede={c.actions.lede}>
      {actions.length === 0 ? (
        <p className="chart-empty">{c.actions.none}</p>
      ) : (
        <>
          <p className="chart-subtitle">{c.actions.counting(actions.length)}</p>
          <ShowAllList total={actions.length} limit={10}>
            {(limit) => (
              <ol className="action-list">
                {actions.slice(0, limit).map((action) => (
                  <ActionItem
                    key={`${action.kind}-${action.target ?? ""}-${action.manifestPath ?? ""}`}
                    action={action}
                    context={context}
                    printing={printing}
                  />
                ))}
              </ol>
            )}
          </ShowAllList>
        </>
      )}
    </SecurityBlock>
  );
}
