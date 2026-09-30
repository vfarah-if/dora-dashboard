import { useState } from "react";
import { useNavigate } from "react-router";
import { useRepos, type RepoWithCounts } from "../api/hooks";
import { copy } from "../copy";
import { AddRepoForm } from "../components/AddRepoForm";
import { RepoRow } from "../components/RepoRow";
import { EmptyState, ErrorState, SkeletonGrid } from "../components/States";
import { StickyPanel } from "../components/StickyPanel";
import { MAX_SERIES } from "../lib/series";

/** Adds or removes an id from the selection. A repository chosen again moves to the end. */
function toggleSelection(current: number[], id: number, on: boolean): number[] {
  const others = current.filter((x) => x !== id);
  return on ? [...others, id] : others;
}

function CompareBar({ chosen }: { chosen: number[] }) {
  const navigate = useNavigate();
  const canCompare = chosen.length >= 2 && chosen.length <= MAX_SERIES;
  return (
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
  );
}

interface RepoListProps {
  repos: RepoWithCounts[];
  chosen: number[];
  onSelect: (id: number, on: boolean) => void;
}

function RepoList({ repos, chosen, onSelect }: RepoListProps) {
  if (repos.length === 0) {
    return (
      <EmptyState title={copy.repos.emptyTitle}>
        <p>{copy.repos.emptyBody}</p>
      </EmptyState>
    );
  }
  return (
    <ul className="repo-list">
      {repos.map((repo) => (
        <RepoRow
          key={repo.id}
          repo={repo}
          selected={chosen.includes(repo.id)}
          selectable={chosen.length < MAX_SERIES}
          onSelect={(on) => onSelect(repo.id, on)}
        />
      ))}
    </ul>
  );
}

export function ReposPage() {
  const repos = useRepos();
  const [selected, setSelected] = useState<number[]>([]);

  const present = new Set(repos.data?.map((r) => r.id) ?? []);
  const chosen = selected.filter((id) => present.has(id));
  const select = (id: number, on: boolean) => setSelected((current) => toggleSelection(current, id, on));

  return (
    <div className="page">
      <StickyPanel>
        <header className="page-header">
          <h1>{copy.repos.title}</h1>
          <p className="lede">{copy.repos.lede}</p>
        </header>
      </StickyPanel>

      <AddRepoForm />

      <section className="repo-list-section" aria-labelledby="repo-list-title">
        <div className="section-bar">
          <h2 id="repo-list-title" className="section-title">
            {copy.repos.listTitle}
          </h2>
          {repos.data && repos.data.length > 1 && <CompareBar chosen={chosen} />}
        </div>

        {repos.isPending && <SkeletonGrid count={3} height={140} />}
        {repos.isError && <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />}
        {repos.data && <RepoList repos={repos.data} chosen={chosen} onSelect={select} />}
      </section>
    </div>
  );
}
