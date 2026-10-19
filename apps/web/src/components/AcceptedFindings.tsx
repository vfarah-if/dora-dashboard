import { useEffect } from "react";
import type { AcceptanceView, SecurityReport } from "@dora-dashboard/core";
import { ApiError, errorText } from "../api/client";
import { useRemoveAcceptance } from "../api/hooks";
import { copy } from "../copy";
import { focusAcceptedHeading, setAcceptNotice, useAcceptNotice } from "../lib/acceptNotice";
import { formatDate } from "../lib/format";
import { safeHttpUrl, supplyChainTitle } from "../lib/security";
import { isLive, reopenRule, statusSentence } from "../lib/securityAcceptance";
import { ExternalLink } from "./ExternalLink";
import { PathText } from "./PathText";
import { SecurityBlock, Tag } from "./SecurityParts";
import { ShowAllList } from "./ShowAllList";

const c = copy.security.acceptance;
const s = c.section;

function Entry({ repoId, view }: { repoId: number; view: AcceptanceView }) {
  const { acceptance } = view;
  const remove = useRemoveAcceptance(repoId);
  const title = supplyChainTitle[acceptance.check];
  const live = isLive(view);
  const place = acceptance.path === null ? s.absent : copy.security.chain.line(acceptance.path, acceptance.line);
  const url = acceptance.path === null ? null : safeHttpUrl(view.items[0]?.url ?? null);
  const text = <PathText text={place} />;

  const press = async () => {
    try {
      await remove.mutateAsync(acceptance.id);
    } catch (error) {
      // Gone already, for example removed in another tab. The report and the list were read again, so the entry leaves
      // with this button and the result is announced where the list is. Any other failure shows from the mutation's error.
      if (error instanceof ApiError && error.status === 404) {
        setAcceptNotice(repoId, c.alreadyRemoved);
        focusAcceptedHeading();
      }
      return;
    }
    // The entry leaves the list with this button, so the result is announced where the list is.
    setAcceptNotice(repoId, c.removed);
    focusAcceptedHeading();
  };

  return (
    <li className="accepted-entry">
      <div className="check-row-head">
        <span className="check-row-title">{title}</span>
        <Tag>{c.reasons[acceptance.reason].label}</Tag>
      </div>
      <p className="mono accepted-place">{url ? <ExternalLink href={url}>{text}</ExternalLink> : text}</p>
      <dl className="accepted-facts">
        <dt>{s.reason}</dt>
        <dd>{c.reasons[acceptance.reason].label}</dd>
        <dt>{s.note}</dt>
        <dd className="accepted-note">{acceptance.note}</dd>
      </dl>
      <p className="chart-subtitle">{s.acceptedOn(formatDate(acceptance.acceptedAt))}</p>
      {view.covers > 1 && <p className="chart-subtitle">{s.covers(view.covers)}</p>}
      <p className="chart-subtitle">{reopenRule(acceptance.fingerprint)}</p>
      <p className={live ? "chart-subtitle" : "accepted-status"}>{statusSentence(view)}</p>
      {remove.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(remove.error)}
        </p>
      )}
      <button type="button" className="button button-ghost screen-only" disabled={remove.isPending} onClick={() => void press()}>
        {remove.isPending ? s.removing : live ? s.undo : s.remove}{" "}
        <span className="visually-hidden">{s.forEntry(title, place)}</span>
      </button>
    </li>
  );
}

/**
 * The findings a person accepted, each with the reason, the note, the date and when it stops applying. The section prints
 * in full, because the acceptances explain the grade, and only its buttons are left out of the printed copy. With nothing
 * accepted it is still on the page, so focus has somewhere to land, and it is left out of the printed copy.
 */
export function AcceptedFindings({ report }: { report: SecurityReport }) {
  const repoId = report.repo.id;
  const notice = useAcceptNotice(repoId);
  const views = report.acceptances;
  // A message belongs to the repository it was said for, so it goes when the section leaves or the repository changes.
  useEffect(() => () => setAcceptNotice(repoId, null), [repoId]);
  return (
    <SecurityBlock id="security-accepted" title={s.title} lede={s.lede} focusable>
      <div role="status" className="screen-only">
        {notice && (
          <p key={notice.sequence} className="notice notice-info">
            {notice.text}
          </p>
        )}
      </div>
      {report.acceptancesUnreadable > 0 && <p className="notice notice-warning">{c.unreadable(report.acceptancesUnreadable)}</p>}
      {views.length === 0 ? (
        <p className="chart-empty accepted-empty">{s.empty}</p>
      ) : (
        <ShowAllList total={views.length} what={s.what}>
          {(limit) => (
            <ul className="accepted-list">
              {views.slice(0, limit).map((view) => (
                <Entry key={view.acceptance.id} repoId={report.repo.id} view={view} />
              ))}
            </ul>
          )}
        </ShowAllList>
      )}
    </SecurityBlock>
  );
}
