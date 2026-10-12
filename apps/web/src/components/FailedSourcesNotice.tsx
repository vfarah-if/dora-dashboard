import { Link } from "react-router";
import type { SecurityReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatDateTime } from "../lib/format";
import { failedSources, joinWords } from "../lib/security";

const c = copy.security.failedSources;

/**
 * A warning naming each source whose last attempt failed, with when it last worked, so figures that come from an
 * earlier read are never taken for fresh ones. It shows nothing when every source answered.
 */
export function FailedSourcesNotice({
  report,
  sourcesOnPage,
  leaveOutUnreadNamed = false,
}: {
  report: SecurityReport;
  /** True where the sources panel is on the same page, so the link stays on it; else it goes to the detail page. */
  sourcesOnPage: boolean;
  leaveOutUnreadNamed?: boolean;
}) {
  const failed = failedSources(report, leaveOutUnreadNamed);
  if (failed.length === 0) return null;
  const names = joinWords(
    failed.map((source) => (source.lastGoodAt ? c.since(source.name, formatDateTime(source.lastGoodAt)) : c.never(source.name))),
  );
  return (
    <aside className="notice notice-warning">
      <p className="notice-title">{c.title}</p>
      <p>{c.body(names)}</p>
      {sourcesOnPage ? (
        <a href="#security-sources" className="screen-only">
          {c.link}
        </a>
      ) : (
        <Link to={{ pathname: `/repos/${report.repo.id}/security`, hash: "#security-sources" }} className="screen-only">
          {c.link}
        </Link>
      )}
    </aside>
  );
}
