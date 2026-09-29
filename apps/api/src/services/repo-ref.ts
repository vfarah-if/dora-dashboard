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
  if (!owner || !name || owner === "." || name === ".") return null;
  return { owner, name };
}
