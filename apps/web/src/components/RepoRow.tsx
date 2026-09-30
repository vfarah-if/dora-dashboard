import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useCrawl, useDeleteRepo, useUpdateRepo, useWorkflows, type RepoWithCounts } from "../api/hooks";
import { errorText } from "../api/client";
import { copy } from "../copy";
import { formatDateTime, formatNumber } from "../lib/format";

function ConfigureDeploy({ repo, onDone }: { repo: RepoWithCounts; onDone: () => void }) {
  const name = `${repo.owner}/${repo.name}`;
  const workflows = useWorkflows(repo.id, true);
  const update = useUpdateRepo(repo.id);
  const [selected, setSelected] = useState<string[]>(repo.deployWorkflows);
  const [branch, setBranch] = useState(repo.deployBranch);
  const branchId = useId();
  const titleId = useId();

  const options = [...new Set([...(workflows.data ?? []), ...repo.deployWorkflows])].sort();

  const toggle = (file: string) =>
    setSelected((current) => (current.includes(file) ? current.filter((f) => f !== file) : [...current, file]));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ deployWorkflows: selected, deployBranch: branch.trim() || repo.deployBranch });
  };

  return (
    <form className="configure-panel" onSubmit={submit} aria-labelledby={titleId}>
      <h3 id={titleId} className="configure-title">
        {copy.configure.title(name)}
      </h3>
      <fieldset className="checkbox-group">
        <legend>{copy.configure.workflowsLegend}</legend>
        <p className="field-hint">{copy.configure.workflowsHint}</p>
        {workflows.isPending && <p role="status">{copy.configure.loadingWorkflows}</p>}
        {workflows.isError && (
          <p className="notice notice-error" role="alert">
            {errorText(workflows.error)}
          </p>
        )}
        {workflows.isSuccess && options.length === 0 && <p>{copy.configure.noWorkflows}</p>}
        {options.map((file) => (
          <label key={file} className="checkbox">
            <input type="checkbox" checked={selected.includes(file)} onChange={() => toggle(file)} />
            <span className="mono">{file}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={branchId}>{copy.configure.branchLabel}</label>
        <input
          id={branchId}
          className="input"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {update.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(update.error)}
        </p>
      )}
      {update.isSuccess && (
        <p className="notice notice-info" role="status">
          {copy.configure.saved}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={update.isPending}>
          {update.isPending ? copy.common.saving : copy.common.save}
        </button>
        <button type="button" className="button button-ghost" onClick={onDone}>
          {copy.common.close}
        </button>
      </div>
    </form>
  );
}

export interface RepoRowProps {
  repo: RepoWithCounts;
  selected: boolean;
  selectable: boolean;
  onSelect: (selected: boolean) => void;
}

function deployDescription(repo: RepoWithCounts): string {
  return repo.deployWorkflows.length
    ? copy.repos.deployDescription(repo.deployWorkflows.join(", "), repo.deployBranch)
    : copy.repos.noDeployWorkflow;
}

function RepoFacts({ repo }: { repo: RepoWithCounts }) {
  const hasWorkflows = repo.deployWorkflows.length > 0;
  return (
    <dl className="repo-facts">
      <div>
        <dt>{copy.repos.pullRequests}</dt>
        <dd>{formatNumber(repo.pullRequests, 0)}</dd>
      </div>
      <div>
        <dt>{copy.repos.deployRuns}</dt>
        <dd>{formatNumber(repo.deployRuns, 0)}</dd>
      </div>
      <div>
        <dt>{copy.repos.lastCrawled}</dt>
        <dd>{repo.lastCrawledAt ? formatDateTime(repo.lastCrawledAt) : copy.repos.neverCrawled}</dd>
      </div>
      <div>
        <dt>{copy.repos.deployConfig}</dt>
        <dd className={hasWorkflows ? "mono" : "text-muted"}>{deployDescription(repo)}</dd>
      </div>
    </dl>
  );
}

function CrawlStatus({ repo }: { repo: RepoWithCounts }) {
  const crawling = repo.crawlStatus === "crawling";
  return (
    <div className="repo-status" role="status" aria-live="polite">
      <span className={`status-pill status-pill-${repo.crawlStatus}`}>
        {crawling && <span className="spinner" aria-hidden="true" />}
        {copy.repos.status[repo.crawlStatus]}
      </span>
      {crawling && <span className="crawl-progress">{repo.crawlProgress ?? copy.repos.crawlingFallback}</span>}
    </div>
  );
}

interface RepoActionsProps {
  crawling: boolean;
  crawlPending: boolean;
  removePending: boolean;
  configuring: boolean;
  onCrawl: (full: boolean) => void;
  onToggleConfigure: () => void;
  onRemove: () => void;
}

function RepoActions({
  crawling,
  crawlPending,
  removePending,
  configuring,
  onCrawl,
  onToggleConfigure,
  onRemove,
}: RepoActionsProps) {
  const crawlDisabled = crawling || crawlPending;
  return (
    <div className="repo-actions">
      <button type="button" className="button button-secondary" disabled={crawlDisabled} onClick={() => onCrawl(false)}>
        {copy.repos.recrawl}
      </button>
      <button type="button" className="button button-secondary" disabled={crawlDisabled} onClick={() => onCrawl(true)}>
        {copy.repos.fullRecrawl}
      </button>
      <button type="button" className="button button-secondary" aria-expanded={configuring} onClick={onToggleConfigure}>
        {copy.repos.configure}
      </button>
      <button type="button" className="button button-danger" disabled={removePending} onClick={onRemove}>
        {copy.repos.remove}
      </button>
    </div>
  );
}

export function RepoRow({ repo, selected, selectable, onSelect }: RepoRowProps) {
  const name = `${repo.owner}/${repo.name}`;
  const crawl = useCrawl();
  const remove = useDeleteRepo();
  const [configuring, setConfiguring] = useState(false);
  const mutationError = crawl.isError || remove.isError;

  const confirmRemove = () => {
    if (window.confirm(copy.repos.confirmRemove(name))) remove.mutate(repo.id);
  };

  return (
    <li className={`card repo-row status-${repo.crawlStatus}`}>
      <div className="repo-row-main">
        <label className="checkbox repo-select">
          <input
            type="checkbox"
            checked={selected}
            disabled={!selected && !selectable}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={copy.repos.selectForCompare(name)}
          />
        </label>
        <div className="repo-row-body">
          <h3 className="repo-name">
            <Link to={`/repos/${repo.id}`} aria-label={copy.repos.openDashboard(name)}>
              {name}
            </Link>
          </h3>
          <RepoFacts repo={repo} />
          <CrawlStatus repo={repo} />
          {repo.crawlStatus === "failed" && repo.crawlError && (
            <p className="notice notice-error" role="alert">
              {repo.crawlError}
            </p>
          )}
          {mutationError && (
            <p className="notice notice-error" role="alert">
              {errorText(crawl.error ?? remove.error)}
            </p>
          )}
        </div>
      </div>
      <RepoActions
        crawling={repo.crawlStatus === "crawling"}
        crawlPending={crawl.isPending}
        removePending={remove.isPending}
        configuring={configuring}
        onCrawl={(full) => crawl.mutate({ id: repo.id, full })}
        onToggleConfigure={() => setConfiguring((open) => !open)}
        onRemove={confirmRemove}
      />
      {configuring && <ConfigureDeploy repo={repo} onDone={() => setConfiguring(false)} />}
    </li>
  );
}
