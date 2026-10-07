import { Link } from "react-router";
import type { RepoListing } from "@dora-dashboard/core";
import { useRepos } from "../api/hooks";
import { copy } from "../copy";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { formatDateTime, formatNumber } from "../lib/format";
import { reposWithIssues } from "../lib/issues";

function IssueRepoRow({ repo }: { repo: RepoListing }) {
  const name = `${repo.owner}/${repo.name}`;
  return (
    <li className="card repo-row">
      <div className="repo-row-body">
        <h2 className="repo-name">
          <Link to={`/issues/${repo.id}`} aria-label={copy.issues.openReport(name)}>
            {name}
          </Link>
        </h2>
        <dl className="repo-facts">
          <div>
            <dt>{copy.issues.issues}</dt>
            <dd>{formatNumber(repo.issues, 0)}</dd>
          </div>
          <div>
            <dt>{copy.issues.lastCrawled}</dt>
            <dd>{repo.lastCrawledAt ? formatDateTime(repo.lastCrawledAt) : copy.issues.neverCrawled}</dd>
          </div>
        </dl>
        {repo.issueError && (
          <div className="notice notice-error" role="alert">
            <p className="notice-title">{copy.issues.errorTitle}</p>
            <p>{copy.issues.errorReason(repo.issueError)}</p>
          </div>
        )}
      </div>
    </li>
  );
}

function IssueRepoList() {
  const repos = useRepos();
  if (repos.isPending) return <Skeleton height={160} label={copy.issues.loading} />;
  if (repos.isError) return <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />;
  const withIssues = reposWithIssues(repos.data);
  if (withIssues.length === 0) {
    return (
      <EmptyState title={copy.issues.emptyTitle}>
        <p>{copy.issues.emptyBody}</p>
        <Link to="/repos" className="button button-secondary">
          {copy.issues.toRepos}
        </Link>
      </EmptyState>
    );
  }
  return (
    <ul className="repo-list">
      {withIssues.map((repo) => (
        <IssueRepoRow key={repo.id} repo={repo} />
      ))}
    </ul>
  );
}

/**
 * The repositories with issues, or with something to say about them, taken from the repositories list, so the page
 * needs no API route of its own.
 */
export function IssuesPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.issues.title}</h1>
        <p className="lede">{copy.issues.lede}</p>
      </header>
      <IssueRepoList />
    </div>
  );
}
