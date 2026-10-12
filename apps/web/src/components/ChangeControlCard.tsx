import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDate, formatNumber, formatPercent } from "../lib/format";
import { reviewNotGraded, safeHttpUrl } from "../lib/security";
import { ExternalLink } from "./ExternalLink";
import { SecurityBlock, Tag } from "./SecurityParts";
import { ShowAllList } from "./ShowAllList";
import { StatTile } from "./StatTile";

const c = copy.security.control;

/** Whether merged changes were reviewed by someone else, with no names, because the page is about habits and not people. */
export function ChangeControlCard({ report }: { report: SecurityReport }) {
  const { review, reviewInRange } = report;
  const notGraded = reviewNotGraded(review, report.thresholds);
  return (
    <SecurityBlock id="security-control" title={c.title} lede={c.lede}>
      {review.merged === 0 ? (
        <p className="chart-empty">{c.noneYet(report.thresholds.reviewWindowDays)}</p>
      ) : (
        <div className="tile-grid tile-grid-flow">
          <StatTile
            label={c.merged}
            value={formatNumber(review.merged, 0)}
            hint={c.mergedHint(report.thresholds.reviewWindowDays)}
          />
          <StatTile
            label={c.unapproved}
            value={formatNumber(review.unapproved, 0)}
            hint={c.unapprovedHint(formatPercent(review.share))}
          />
          <StatTile label={c.selfMerged} value={formatNumber(review.selfMergedUnapproved, 0)} hint={c.selfMergedHint} />
        </div>
      )}
      {notGraded && <p className="notice notice-info">{notGraded}</p>}
      <p className="chart-subtitle">
        {c.limits(
          formatPercent(report.thresholds.unapprovedLimits.elite),
          formatPercent(report.thresholds.unapprovedLimits.high),
        )}
      </p>
      {reviewInRange.merged > 0 && <p className="chart-subtitle">{c.inRange(reviewInRange.merged, reviewInRange.unapproved)}</p>}
      <section aria-labelledby="security-control-list" className="card">
        <h3 id="security-control-list" className="chart-title">
          {c.listTitle}
        </h3>
        <p className="chart-subtitle">{c.listSubtitle}</p>
        {review.pullRequests.length === 0 ? (
          <p className="chart-empty">{c.none}</p>
        ) : (
          <ShowAllList total={review.pullRequests.length}>
            {(limit) => (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">{c.listTitle}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{c.number}</th>
                      <th scope="col">{c.titleColumn}</th>
                      <th scope="col">{c.mergedAt}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.pullRequests.slice(0, limit).map((pr) => {
                      const url = safeHttpUrl(pr.url);
                      return (
                        <tr key={pr.number}>
                          <th scope="row">
                            {url ? <ExternalLink href={url}>{c.pullRequest(pr.number)}</ExternalLink> : c.pullRequest(pr.number)}
                          </th>
                          <td>
                            {pr.title}
                            {pr.selfMerged && <Tag>{copy.security.tags.selfMerged}</Tag>}
                          </td>
                          <td>{formatDate(pr.mergedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </ShowAllList>
        )}
      </section>
    </SecurityBlock>
  );
}
