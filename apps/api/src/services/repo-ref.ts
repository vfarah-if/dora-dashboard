export interface RepoRef {
  owner: string;
  name: string;
}

/** Accepts `owner/name`, a web URL, or an SSH or HTTPS clone URL. */
export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const match = /(?:^|[/:])([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name || [".", ".."].includes(owner) || [".", ".."].includes(name)) return null;
  return { owner, name };
}

/** A branch name that is safe to hand to git: empty (meaning the default), no leading `-`, no whitespace or control characters. */
export const isSafeBranch = (branch: string): boolean => /^(?!-)[^\s\u0000-\u001f\u007f]*$/u.test(branch);
