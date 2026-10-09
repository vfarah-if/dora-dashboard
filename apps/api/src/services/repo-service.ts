import {
  DEFAULT_ISSUE_LABELS,
  ISSUE_LABEL_LIMITS,
  type IssueLabelDefaults,
  type IssueLabelRules,
  type Repo,
  type RepoListing,
} from "@dora-dashboard/core";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import { isSafeBranch, parseRepoRef } from "./repo-ref.js";

/** Workflow file names that usually ship to production, offered when none is configured. */
const DEPLOY_HINT = /deploy|release|publish/i;

export interface AddRepoInput {
  repo: string;
  deployWorkflows?: string[];
  deployBranch?: string;
}

export class RepoService {
  constructor(
    private readonly store: RepoStore,
    private readonly provider: SourceProvider,
  ) {}

  list(): RepoListing[] {
    return this.store.listRepos().map((repo) => this.listing(repo));
  }

  private listing(repo: Repo): RepoListing {
    const { enabled, labels, labelsUnreadable, error } = this.store.issueState(repo.id);
    return {
      ...repo,
      ...this.store.counts(repo.id),
      issuesEnabled: enabled,
      issueLabels: labels,
      issueLabelsUnreadable: labelsUnreadable,
      issueError: error,
    };
  }

  /** The label names every repository starts with, and the limits a saved override must keep to. */
  issueLabelDefaults(): IssueLabelDefaults {
    return { ...DEFAULT_ISSUE_LABELS, limits: { ...ISSUE_LABEL_LIMITS } };
  }

  /**
   * Saves the repository's label override and returns its listing row. Names are trimmed, blanks and repeats (without
   * case) dropped, keys left with no names dropped, and an override with nothing left is the defaults again (null).
   * The rules are read at report time, so this starts no crawl.
   */
  setIssueLabels(id: number, rules: IssueLabelRules | null): RepoListing {
    const repo = this.get(id);
    this.store.setIssueLabels(id, cleanRules(rules));
    return this.listing(repo);
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

/** The names trimmed, with blanks and repeats (compared without case) dropped; the first spelling of a repeat is kept. */
function cleanNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const name of names.map((n) => n.trim())) {
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
  }
  return kept;
}

function cleanGroup<K extends string>(group: Partial<Record<K, string[]>> | undefined): Partial<Record<K, string[]>> | null {
  const kept: Partial<Record<K, string[]>> = {};
  for (const [key, names] of Object.entries(group ?? {}) as [K, string[] | undefined][]) {
    const clean = cleanNames(names ?? []);
    if (clean.length > 0) kept[key] = clean;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function cleanRules(rules: IssueLabelRules | null): IssueLabelRules | null {
  if (rules === null) return null;
  const kinds = cleanGroup(rules.kinds);
  const priorities = cleanGroup(rules.priorities);
  return kinds || priorities ? { ...(kinds ? { kinds } : {}), ...(priorities ? { priorities } : {}) } : null;
}
