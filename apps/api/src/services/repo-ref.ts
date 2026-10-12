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

/**
 * A branch name that is safe to hand to git and to put in a request path: empty (meaning the default), no leading `-`,
 * no whitespace or control characters, and no `.` or `..` segment, which a path would resolve to another address.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they are rejected.
const PLAIN = /^(?!-)[^\s\u0000-\u001f\u007f]*$/u;
export const isSafeBranch = (branch: string): boolean =>
  PLAIN.test(branch) && !branch.split("/").some((segment) => segment === "." || segment === "..");
