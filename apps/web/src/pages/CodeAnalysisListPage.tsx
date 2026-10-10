import { Link } from "react-router";
import type { RepoListing } from "@dora-dashboard/core";
import { useRepos } from "../api/hooks";
import { copy } from "../copy";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { formatDateTime } from "../lib/format";

function CodeRepoRow({ repo }: { repo: RepoListing }) {
  const name = `${repo.owner}/${repo.name}`;
  return (
    <li className="card repo-row">
      <div className="repo-row-body">
        <h2 className="repo-name">
          <Link to={`/repos/${repo.id}/code`} aria-label={copy.codeAnalysis.listOpen(name)}>
            {name}
          </Link>
        </h2>
        <dl className="repo-facts">
          <div>
            <dt>{copy.codeAnalysis.listLastCrawled}</dt>
            <dd>{repo.lastCrawledAt ? formatDateTime(repo.lastCrawledAt) : copy.codeAnalysis.listNeverCrawled}</dd>
          </div>
          <div>
            <dt>{copy.codeAnalysis.listCrawlStatus}</dt>
            <dd>{copy.repos.status[repo.crawlStatus]}</dd>
          </div>
        </dl>
      </div>
    </li>
  );
}

function CodeRepoList() {
  const repos = useRepos();
  if (repos.isPending) return <Skeleton height={160} label={copy.codeAnalysis.listLoading} />;
  if (repos.isError) return <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />;
  if (repos.data.length === 0) {
    return (
      <EmptyState title={copy.codeAnalysis.listEmptyTitle}>
        <p>{copy.codeAnalysis.listEmptyBody}</p>
        <Link to="/repos" className="button button-secondary">
          {copy.codeAnalysis.listToRepos}
        </Link>
      </EmptyState>
    );
  }
  return (
    <ul className="repo-list">
      {repos.data.map((repo) => (
        <CodeRepoRow key={repo.id} repo={repo} />
      ))}
    </ul>
  );
}

/** Every repository, linking to its detailed code analysis. Built from the repositories list, so it needs no API route. */
export function CodeAnalysisListPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.codeAnalysis.listTitle}</h1>
        <p className="lede">{copy.codeAnalysis.listLede}</p>
      </header>
      <CodeRepoList />
    </div>
  );
}
