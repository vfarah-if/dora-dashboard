import type { PrTimings } from "@dora-dashboard/core";

export interface AuthorOption {
  login: string;
  count: number;
}

/** Each named author with how many of the given pull requests they opened, most active first, then by login. */
export function prAuthors(prs: readonly PrTimings[]): AuthorOption[] {
  const counts = new Map<string, number>();
  for (const pr of prs) {
    if (pr.author) counts.set(pr.author, (counts.get(pr.author) ?? 0) + 1);
  }
  return [...counts]
    .map(([login, count]) => ({ login, count }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/** The pull requests opened by one author, or all of them when no author is chosen. */
export function filterByAuthor(prs: readonly PrTimings[], author: string | null): readonly PrTimings[] {
  return author ? prs.filter((pr) => pr.author === author) : prs;
}
