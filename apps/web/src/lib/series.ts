import type { RepoReport } from "@dora-dashboard/core";

export const MAX_SERIES = 4;

/** A series colour by its fixed slot. Slots are assigned per repository, never by rank. */
export function seriesColour(slot: number): string {
  return `var(--series-${(slot % MAX_SERIES) + 1})`;
}

export function repoName(repo: Pick<RepoReport["repo"], "owner" | "name">): string {
  return `${repo.owner}/${repo.name}`;
}

export interface SeriesMeta {
  /** Stable key used as the data field for this repository in chart rows. */
  key: string;
  label: string;
  shortLabel: string;
  colour: string;
}

/**
 * Colour follows the repository. The slot is the repository's position in the list the reader asked for
 * (the `ids` in the address), so sorting any table or chart never moves a colour to another repository.
 */
export function seriesFor(reports: readonly RepoReport[], ids: readonly number[]): SeriesMeta[] {
  return reports.map((report) => {
    const slot = Math.max(0, ids.indexOf(report.repo.id));
    return {
      key: `r${report.repo.id}`,
      label: repoName(report.repo),
      shortLabel: report.repo.name,
      colour: seriesColour(slot),
    };
  });
}
