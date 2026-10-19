import type { SupplyChainItem, SupplyChainLine } from "@dora-dashboard/core";
import { copy } from "../copy";
import { whySentences } from "../lib/findingWhy";
import { foundByItem, lineItemText, safeHttpUrl } from "../lib/security";
import { canAccept } from "../lib/securityAcceptance";
import { clearingStep } from "../lib/securityFixes";
import { AcceptFinding } from "./AcceptFinding";
import { CopySnippet } from "./CopySnippet";
import { ExternalLink } from "./ExternalLink";
import { PathText } from "./PathText";

const c = copy.security.findingDetail;

/**
 * One place a check found something. It shows the linked path and the evidence, and a disclosure that answers the three
 * questions a person asks next: why it is a risk here, how it was found and what would clear it. Where the finding can
 * be accepted, the button sits beneath it.
 */
export function FindingRow({ repoId, line, item }: { repoId: number; line: SupplyChainLine; item: SupplyChainItem }) {
  const place = lineItemText(item);
  const url = safeHttpUrl(item.url);
  const text = <PathText text={place} />;
  const clear = clearingStep(line.check, item);
  return (
    <li className="finding-row">
      <div className="finding-place mono">
        {url ? <ExternalLink href={url}>{text}</ExternalLink> : text}
        {item.detail && <code className="finding-evidence">{item.detail}</code>}
      </div>
      <details className="action-details finding-details">
        <summary>
          {c.summary} <span className="visually-hidden">{place}</span>
        </summary>
        <div className="action-body">
          <dl className="finding-facts">
            <dt className="action-heading">{c.whyTitle}</dt>
            <dd>
              {whySentences(line.check, item).map((sentence, index) => (
                <p key={index}>{sentence}</p>
              ))}
            </dd>
            <dt className="action-heading">{c.foundTitle}</dt>
            <dd>
              <p>{foundByItem(line.check, item)}</p>
            </dd>
            <dt className="action-heading">{c.clearTitle}</dt>
            <dd>
              {clear.steps.length === 1 ? (
                <p>{clear.steps[0]}</p>
              ) : (
                <ol className="action-steps">
                  {clear.steps.map((step, index) => (
                    <li key={`${index}-${step}`}>{step}</li>
                  ))}
                </ol>
              )}
              {clear.snippet && (
                <CopySnippet
                  label={clear.snippet.label}
                  code={clear.snippet.code}
                  note={clear.snippet.note}
                  instead={clear.snippet.instead}
                />
              )}
            </dd>
          </dl>
        </div>
      </details>
      {canAccept(item) ? (
        <AcceptFinding
          repoId={repoId}
          target={{ check: line.check, path: item.path, fingerprint: item.fingerprint }}
          place={place}
        />
      ) : (
        <p className="field-hint screen-only finding-hint">{copy.security.acceptance.cannotAcceptYet}</p>
      )}
    </li>
  );
}
