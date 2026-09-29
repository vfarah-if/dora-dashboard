import { useState } from "react";
import { useNavigate } from "react-router";
import { useRepos } from "../api/hooks";
import { copy } from "../copy";
import { AddRepoForm } from "../components/AddRepoForm";
import { RepoRow } from "../components/RepoRow";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { MAX_SERIES } from "../lib/series";

export function ReposPage() {
  const repos = useRepos();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number[]>([]);

  const present = new Set(repos.data?.map((r) => r.id) ?? []);
  const chosen = selected.filter((id) => present.has(id));
  const canCompare = chosen.length >= 2 && chosen.length <= MAX_SERIES;

  const select = (id: number, on: boolean) =>
    setSelected((current) => (on ? [...current.filter((x) => x !== id), id] : current.filter((x) => x !== id)));

  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.repos.title}</h1>
        <p className="lede">{copy.repos.lede}</p>
      </header>

      <AddRepoForm />

      <section className="repo-list-section" aria-labelledby="repo-list-title">
        <div className="section-bar">
          <h2 id="repo-list-title" className="section-title">
            {copy.repos.listTitle}
          </h2>
          {repos.data && repos.data.length > 1 && (
            <div className="compare-bar">
              <span className="compare-hint" id="compare-hint">
                {chosen.length ? copy.repos.compareSelected(chosen.length) : copy.repos.compareHint}
              </span>
              <button
                type="button"
                className="button button-primary"
                disabled={!canCompare}
                aria-describedby="compare-hint"
                onClick={() => navigate(`/compare?ids=${chosen.join(",")}`)}
              >
                {copy.repos.compareButton}
              </button>
            </div>
          )}
        </div>

        {repos.isPending && <SkeletonGrid count={3} height={140} />}
        {repos.isError && <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />}
        {repos.data && repos.data.length === 0 && (
          <EmptyState title={copy.repos.emptyTitle}>
            <p>{copy.repos.emptyBody}</p>
          </EmptyState>
        )}
        {repos.data && repos.data.length > 0 && (
          <ul className="repo-list">
            {repos.data.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                selected={chosen.includes(repo.id)}
                selectable={chosen.length < MAX_SERIES}
                onSelect={(on) => select(repo.id, on)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
