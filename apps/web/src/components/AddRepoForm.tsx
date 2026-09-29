import { useId, useState, type FormEvent } from "react";
import { useAddRepo, type AddRepoBody } from "../api/hooks";
import { errorText } from "../api/client";
import { copy } from "../copy";

const splitList = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

export function AddRepoForm() {
  const add = useAddRepo();
  const [repo, setRepo] = useState("");
  const [workflows, setWorkflows] = useState("");
  const [branch, setBranch] = useState("");
  const [addedName, setAddedName] = useState<string | null>(null);
  const ids = {
    repo: useId(),
    repoHint: useId(),
    workflow: useId(),
    workflowHint: useId(),
    branch: useId(),
    branchHint: useId(),
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = repo.trim();
    if (!trimmed) return;
    const body: AddRepoBody = { repo: trimmed };
    const deployWorkflows = splitList(workflows);
    if (deployWorkflows.length) body.deployWorkflows = deployWorkflows;
    if (branch.trim()) body.deployBranch = branch.trim();
    setAddedName(null);
    add.mutate(body, {
      onSuccess: (created) => {
        setAddedName(`${created.owner}/${created.name}`);
        setRepo("");
        setWorkflows("");
        setBranch("");
      },
    });
  };

  return (
    <section className="card add-repo" aria-labelledby={`${ids.repo}-title`}>
      <h2 id={`${ids.repo}-title`} className="section-title">
        {copy.repos.addTitle}
      </h2>
      <form onSubmit={submit} className="add-repo-form" noValidate>
        <div className="field field-wide">
          <label htmlFor={ids.repo}>{copy.repos.repoLabel}</label>
          <input
            id={ids.repo}
            className="input"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder={copy.repos.repoPlaceholder}
            aria-describedby={ids.repoHint}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p id={ids.repoHint} className="field-hint">
            {copy.repos.repoHint}
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.workflow}>{copy.repos.workflowLabel}</label>
          <input
            id={ids.workflow}
            className="input"
            value={workflows}
            onChange={(event) => setWorkflows(event.target.value)}
            placeholder={copy.repos.workflowPlaceholder}
            aria-describedby={ids.workflowHint}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={ids.workflowHint} className="field-hint">
            {copy.repos.workflowHint}
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.branch}>{copy.repos.branchLabel}</label>
          <input
            id={ids.branch}
            className="input"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={copy.repos.branchPlaceholder}
            aria-describedby={ids.branchHint}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={ids.branchHint} className="field-hint">
            {copy.repos.branchHint}
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={add.isPending || !repo.trim()}>
            {add.isPending ? copy.repos.adding : copy.repos.addButton}
          </button>
        </div>
      </form>
      {add.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(add.error)}
        </p>
      )}
      {addedName && (
        <p className="notice notice-info" role="status">
          {copy.repos.added(addedName)}
        </p>
      )}
    </section>
  );
}
