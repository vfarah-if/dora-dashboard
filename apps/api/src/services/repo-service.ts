import type { Repo } from "@dora-dashboard/core";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import type { RepoCounts, RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import { isSafeBranch, parseRepoRef } from "./repo-ref.js";

/** Workflow file names that usually ship to production, offered when none is configured. */
const DEPLOY_HINT = /deploy|release|publish/i;

export interface AddRepoInput {
  repo: string;
  deployWorkflows?: string[];
  deployBranch?: string;
}

export type RepoWithCounts = Repo & RepoCounts;

export class RepoService {
  constructor(
    private readonly store: RepoStore,
    private readonly provider: SourceProvider,
  ) {}

  list(): RepoWithCounts[] {
    return this.store.listRepos().map((repo) => ({ ...repo, ...this.store.counts(repo.id) }));
  }

  get(id: number): Repo {
    const repo = this.store.getRepo(id);
    if (!repo) throw new NotFoundError(`Unknown repository ${id}`);
    return repo;
  }

  /**
   * Registers a repository. With no deploy workflow named, the first workflow whose file name looks
   * like a deployment is chosen; doing that lookup also proves the credential can see the repository.
   */
  async add(token: string, input: AddRepoInput): Promise<Repo> {
    const ref = parseRepoRef(input.repo);
    if (!ref) throw new ValidationError("Enter a repository as owner/name or a repository URL");
    if (this.store.findRepo(ref.owner, ref.name)) throw new ConflictError(`${ref.owner}/${ref.name} is already added`);

    let workflows = cleanList(input.deployWorkflows);
    if (workflows.length === 0) {
      const available = await this.provider.listWorkflows(token, ref.owner, ref.name);
      workflows = available.filter((w) => DEPLOY_HINT.test(w)).slice(0, 1);
    }
    return this.store.addRepo(ref.owner, ref.name, workflows, cleanBranch(input.deployBranch));
  }

  configure(id: number, deployWorkflows: string[], deployBranch: string): Repo {
    this.get(id);
    this.store.updateRepoConfig(id, cleanList(deployWorkflows), cleanBranch(deployBranch));
    return this.get(id);
  }

  remove(id: number): void {
    this.store.deleteRepo(id);
  }

  async workflows(token: string, id: number): Promise<string[]> {
    const repo = this.get(id);
    return this.provider.listWorkflows(token, repo.owner, repo.name);
  }
}

const cleanList = (values: string[] | undefined) => (values ?? []).map((v) => v.trim()).filter(Boolean);
const cleanBranch = (branch: string | undefined) => {
  if (branch !== undefined && !isSafeBranch(branch.trim())) throw new ValidationError("That is not a usable branch name");
  return branch?.trim() || "main";
};
