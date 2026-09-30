import type { FeatureGroup, FeatureMember, OpenPullRequest, QueueEntry, Repo, ReviewLane } from "./types.js";

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
/** Look like ticket keys but are not. */
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "HTTP", "RFC", "CVE", "MD", "TLS", "SSL", "AES", "RSA"]);
/** Branches that many unrelated pull requests are opened from or against. */
const SHARED_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

/** Ticket keys such as `ABC-123` in the title, branch name and linked issues, in order of appearance, without repeats. */
export function ticketKeysOf(pr: Pick<OpenPullRequest, "title" | "headRef" | "linkedIssues">): string[] {
  const text = [pr.title, pr.headRef, ...pr.linkedIssues].join(" ");
  const keys = (text.match(TICKET_KEY) ?? []).filter((key) => !NOT_TICKETS.has(key.slice(0, key.lastIndexOf("-"))));
  return [...new Set(keys)];
}

/** Pull requests named on a `Related:` line of the body: `owner/name#12`, a pull request link, or `#12` in the same repository. */
function relatedRefs(body: string | undefined): { repo: string | null; number: number }[] {
  const refs: { repo: string | null; number: number }[] = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    const match = /^\s*related\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    for (const ref of match[1]!.matchAll(/([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)|#(\d+)/g)) {
      refs.push({ repo: ref[1] ?? null, number: Number(ref[2] ?? ref[3]) });
    }
  }
  return refs;
}

export interface FeatureCandidate {
  repo: Pick<Repo, "id" | "owner" | "name">;
  pr: OpenPullRequest;
  entry: Pick<QueueEntry, "key" | "lane" | "waitHours">;
}

type Evidence = FeatureGroup["evidence"][number];

class Groups {
  private readonly parent: number[];
  readonly evidence: Set<Evidence>[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.evidence = Array.from({ length: size }, () => new Set<Evidence>());
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }

  join(a: number, b: number, why: Evidence): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    const merged = new Set([...this.evidence[ra]!, ...this.evidence[rb]!, why]);
    this.parent[rb] = ra;
    this.evidence[ra] = merged;
  }
}

/** Joins every index sharing a value under `keyOf`; a candidate may yield several values. */
function joinBy(groups: Groups, count: number, why: Evidence, keyOf: (i: number) => string[]): void {
  const first = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    for (const key of keyOf(i)) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, i);
      else groups.join(seen, i, why);
    }
  }
}

const emptyLanes = (): Record<ReviewLane, number> => ({
  held: 0,
  with_author: 0,
  approved: 0,
  awaiting_review: 0,
  no_reviewer: 0,
});

/**
 * Groups open pull requests that look like parts of one piece of work, linked by any of four kinds of evidence: a shared
 * ticket key, a `Related:` line in the body, a shared head branch, or a stack (one pull request based on another's
 * branch). Only groups of two or more are returned, the longest waiting first.
 */
export function groupFeatures(candidates: FeatureCandidate[]): FeatureGroup[] {
  const n = candidates.length;
  const groups = new Groups(n);
  const keys = candidates.map((c) => ticketKeysOf(c.pr));
  const fullName = (c: FeatureCandidate) => `${c.repo.owner}/${c.repo.name}`;

  joinBy(groups, n, "ticket", (i) => keys[i]!);
  joinBy(groups, n, "branch", (i) => {
    const head = candidates[i]!.pr.headRef;
    return head && !SHARED_BRANCHES.has(head) ? [head] : [];
  });
  stackLinks(groups, candidates);

  const byName = new Map(candidates.map((c, i) => [`${fullName(c)}#${c.pr.number}`, i]));
  candidates.forEach((c, i) => {
    for (const ref of relatedRefs(c.pr.body)) {
      const other = byName.get(`${ref.repo ?? fullName(c)}#${ref.number}`);
      if (other !== undefined && other !== i) groups.join(i, other, "related");
    }
  });

  return collect(groups, candidates, keys).sort((a, b) => b.longestWaitHours - a.longestWaitHours || a.id.localeCompare(b.id));
}

/** Joins a pull request to whichever pull request in its repository is opened from the branch it is based on. */
function stackLinks(groups: Groups, candidates: FeatureCandidate[]): void {
  const byHead = new Map(candidates.map((c, i) => [`${c.repo.id}:${c.pr.headRef}`, i]));
  candidates.forEach((c, i) => {
    if (SHARED_BRANCHES.has(c.pr.baseRef)) return;
    const parent = byHead.get(`${c.repo.id}:${c.pr.baseRef}`);
    if (parent !== undefined && parent !== i) groups.join(i, parent, "stack");
  });
}

function collect(groups: Groups, candidates: FeatureCandidate[], keys: string[][]): FeatureGroup[] {
  const roots = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const root = groups.find(i);
    roots.set(root, [...(roots.get(root) ?? []), i]);
  });
  return [...roots.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([root, indexes]) => {
      const members: FeatureMember[] = indexes
        .map((i) => candidates[i]!)
        .map((c) => ({
          key: c.entry.key,
          repoId: c.repo.id,
          repo: `${c.repo.owner}/${c.repo.name}`,
          number: c.pr.number,
          title: c.pr.title,
          url: c.pr.url,
          lane: c.entry.lane,
          waitHours: c.entry.waitHours,
        }))
        .sort((a, b) => b.waitHours - a.waitHours || a.key.localeCompare(b.key));
      const lanes = emptyLanes();
      for (const m of members) lanes[m.lane]++;
      const ticketKeys = [...new Set(indexes.flatMap((i) => keys[i]!))];
      const evidence = (["ticket", "related", "branch", "stack"] as const).filter((e) => groups.evidence[root]!.has(e));
      return {
        id: members.map((m) => m.key).sort()[0]!,
        title: ticketKeys[0] ?? members[0]!.title,
        evidence,
        ticketKeys,
        members,
        lanes,
        longestWaitHours: members[0]!.waitHours,
      };
    });
}
