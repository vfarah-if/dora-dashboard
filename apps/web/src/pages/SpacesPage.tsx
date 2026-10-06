import { Link } from "react-router";
import { useHealth, useSpaces, type SpaceListItem } from "../api/hooks";
import { copy } from "../copy";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { formatDateTime, formatNumber } from "../lib/format";

function SpaceRow({ space }: { space: SpaceListItem }) {
  return (
    <li className="card repo-row">
      <div className="repo-row-body">
        <h2 className="repo-name">
          <Link to={`/spaces/${space.id}`}>{space.name}</Link> <span className="mono text-muted">{space.key}</span>
        </h2>
        <dl className="repo-facts">
          <div>
            <dt>{copy.spaces.site}</dt>
            <dd className="mono">{space.siteUrl}</dd>
          </div>
          <div>
            <dt>{copy.spaces.issues}</dt>
            <dd>{formatNumber(space.workItemCount, 0)}</dd>
          </div>
          <div>
            <dt>{copy.spaces.lastCrawled}</dt>
            <dd>{space.lastCrawledAt ? formatDateTime(space.lastCrawledAt) : copy.spaces.neverCrawled}</dd>
          </div>
          <div>
            <dt>{copy.spaces.linkedRepos}</dt>
            <dd>{space.repos.length ? space.repos.map((r) => r.name).join(", ") : copy.spaces.noLinkedRepos}</dd>
          </div>
        </dl>
        {space.crawlStatus === "failed" && (
          <div className="notice notice-error" role="alert">
            <p className="notice-title">{copy.spaces.crawlFailedTitle}</p>
            {space.crawlError && <p>{copy.spaces.crawlFailedReason(space.crawlError)}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

function Header() {
  return (
    <header className="page-header">
      <h1>{copy.spaces.title}</h1>
      <p className="lede">{copy.spaces.lede}</p>
    </header>
  );
}

function SpaceList() {
  const spaces = useSpaces();
  if (spaces.isPending) return <Skeleton height={160} label={copy.spaces.loading} />;
  if (spaces.isError) return <ErrorState error={spaces.error} onRetry={() => void spaces.refetch()} />;
  if (spaces.data.length === 0) {
    return (
      <EmptyState title={copy.spaces.emptyTitle}>
        <p>{copy.spaces.emptyBody}</p>
        <Link to="/repos" className="button button-secondary">
          {copy.spaces.toRepos}
        </Link>
      </EmptyState>
    );
  }
  return (
    <ul className="repo-list">
      {spaces.data.map((space) => (
        <SpaceRow key={space.id} space={space} />
      ))}
    </ul>
  );
}

/**
 * The spaces tracked from Jira. The list is asked for only once the server says Jira is on. When that answer cannot be
 * read, the page says so with a retry rather than guessing, because Jira may well be on.
 */
export function SpacesPage() {
  const health = useHealth();
  const off = health.isSuccess && health.data.jira !== true;
  return (
    <div className="page">
      <Header />
      {health.isPending && <Skeleton height={160} label={copy.spaces.loading} />}
      {off && (
        <EmptyState title={copy.spaces.offTitle}>
          <p>{copy.spaces.offBody}</p>
        </EmptyState>
      )}
      {health.isError && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
      {health.isSuccess && !off && <SpaceList />}
    </div>
  );
}
