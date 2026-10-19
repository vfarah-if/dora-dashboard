/**
 * Which events can reach each line of a workflow, and what stands in their way (ADR 0039).
 *
 * A reusable workflow or composite action runs with the event of whatever calls it, so a file is reached along routes:
 * its own triggers, and each chain of local `uses:` calls from a file that has one. Each route carries the set of
 * attack worlds, an outsider's event as it would look to the condition, that the calling jobs' `if:` conditions leave
 * open. A check then asks whether any world of the kind it cares about survives the conditions on the line itself.
 *
 * A condition that cannot be read, or that names something unknowable such as a label, an input or a branch, leaves
 * every world open, and callers keep a finding while any world it needs is open. A world is closed only when an
 * expression is known to be false in it. A known answer that is wrong can still hide a finding, which is why each fact
 * of a world and each rule that closes one is pinned by a test whose answer was worked out by hand.
 */
import { isActionPath, type CandidateFile } from "./codeTooling.js";
import type { WorkflowCondition, WorkflowHop, WorkflowRoute } from "./securityTypes.js";
import { compareText } from "./stats.js";
import {
  EventNames,
  Opaque,
  UNKNOWN,
  conditionTruths,
  parseExpression,
  truthOf,
  type Expr,
  type Outcome,
  type Scope,
  type Value,
} from "./workflowExpressions.js";
import { rowsOf, structureOf, triggersOf, unquote, type ConditionSource, type Row, type Structure } from "./workflowRows.js";

// ---- attack worlds --------------------------------------------------------------------------------------------------

/** The pull request events whose head an outsider brings, as a fork. */
type ForkTrigger = "pull_request_target" | "pull_request" | "pull_request_review" | "pull_request_review_comment";

/** The triggers that start an attack world. */
export type WorldTrigger = "workflow_run" | ForkTrigger | "issue_comment" | "issues" | "discussion" | "discussion_comment";

/** Each world's name: its trigger, or for `workflow_run` which kind of head the upstream run had. */
export type WorldName = "workflow_run/fork" | "workflow_run/base" | Exclude<WorldTrigger, "workflow_run">;

/** An attack world: what a condition can know about an outsider's event. Keys are lower-case dotted paths. */
export interface World {
  name: WorldName;
  trigger: WorldTrigger;
  facts: ReadonlyMap<string, Value>;
}

/** One bit for each world, in the order of `WORLDS`. */
export type WorldSet = number;

const BASE_REPO = new Opaque("base-repo");
const FORK_REPO = new Opaque("fork-repo");
const BASE_OWNER = new Opaque("base-owner");
const FORK_OWNER = new Opaque("fork-owner");
const BASE_ID = new Opaque("base-id");
const FORK_ID = new Opaque("fork-id");

const COMMON: [string, Value][] = [
  ["github.repository", BASE_REPO],
  ["github.event.repository.full_name", BASE_REPO],
  ["github.repository_owner", BASE_OWNER],
  ["github.event.repository.owner.login", BASE_OWNER],
  ["github.repository_id", BASE_ID],
  ["github.event.repository.id", BASE_ID],
];

const world = (name: WorldName, trigger: WorldTrigger, facts: [string, Value][]): World => ({
  name,
  trigger,
  facts: new Map<string, Value>([...COMMON, ["github.event_name", trigger], ...facts]),
});

/** The upstream events whose run is headed by the pull request's own head, which is a fork when an outsider opened it. */
const FORK_HEADED_EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment"];
/** Events that an outsider cannot cause. */
const OWNER_ONLY_EVENTS = ["push", "schedule", "workflow_dispatch", "repository_dispatch", "merge_group"];

/**
 * A run that an outsider's event started, seen by the `workflow_run` workflow it triggers. In the fork-headed world the
 * upstream event was a pull request event whose run is headed by the fork, so its branch, commit and repository all come
 * from the outsider. In the base-headed world it was any other event an outsider can cause, such as `pull_request_target`,
 * which GitHub runs "in the context of the default branch of the base repository", or a comment. The run's head
 * repository is then the base repository (and not a fork), and its branch, commit and sha are the base's own. Only
 * `display_title`, which a `run-name` can fill with the outsider's text, and `pull_requests` still carry what the
 * outsider wrote. In either world the upstream event's name is known only as one of its world's set.
 */
const afterRun = (head: "fork" | "base"): World => {
  const fork = head === "fork";
  const event = fork ? new EventNames(FORK_HEADED_EVENTS) : new EventNames([...FORK_HEADED_EVENTS, ...OWNER_ONLY_EVENTS], true);
  return world(`workflow_run/${head}`, "workflow_run", [
    ["github.event.workflow_run.event", event],
    ["github.event.workflow_run.repository.full_name", BASE_REPO],
    ["github.event.workflow_run.head_repository.full_name", fork ? FORK_REPO : BASE_REPO],
    ["github.event.workflow_run.head_repository.fork", fork],
    ["github.event.workflow_run.head_repository.owner.login", fork ? FORK_OWNER : BASE_OWNER],
    ["github.event.workflow_run.head_repository.id", fork ? FORK_ID : BASE_ID],
  ]);
};

/** A pull request event whose head is a fork, because a fork is the only head an outsider can bring. */
const fromFork = (trigger: ForkTrigger): World =>
  world(trigger, trigger, [
    ["github.event.pull_request.head.repo.full_name", FORK_REPO],
    ["github.event.pull_request.head.repo.fork", true],
    ["github.event.pull_request.head.repo.owner.login", FORK_OWNER],
    ["github.event.pull_request.head.repo.id", FORK_ID],
    ["github.event.pull_request.base.repo.full_name", BASE_REPO],
    ["github.event.pull_request.base.repo.id", BASE_ID],
  ]);

/**
 * Everything else is unknown: `head_branch`, `head_sha`, `conclusion`, labels, `actor`, `inputs`, `vars`, `secrets`,
 * `env`, `matrix`, `steps` and the rest, so a branch filter or a label gate is never a guard. The four comment and
 * issue events know only their name.
 */
export const WORLDS: readonly World[] = [
  afterRun("fork"),
  afterRun("base"),
  fromFork("pull_request_target"),
  fromFork("pull_request"),
  fromFork("pull_request_review"),
  fromFork("pull_request_review_comment"),
  world("issue_comment", "issue_comment", []),
  world("issues", "issues", []),
  world("discussion", "discussion", []),
  world("discussion_comment", "discussion_comment", []),
];

/** The set of the worlds with these names. A name that no world has is a mistake in this file, so it throws. */
export function worldsNamed(...names: readonly WorldName[]): WorldSet {
  let set = 0;
  for (const name of names) {
    const i = WORLDS.findIndex((w) => w.name === name);
    if (i < 0) throw new Error(`No attack world is named ${name}`);
    set |= 1 << i;
  }
  return set;
}

export const ALL_WORLDS: WorldSet = worldsNamed(...WORLDS.map((w) => w.name));
/** Worlds in which a step can check out an outsider's code with secrets. */
export const HEAD_WORLDS: WorldSet = worldsNamed("workflow_run/fork", "workflow_run/base", "pull_request_target");
/**
 * The `workflow_run` world whose upstream run was not headed by a fork. Its `head_branch`, `head_sha` and `head_commit`
 * are the base repository's own, so a reference to one of them reaches every world of its kind except this one.
 */
export const BASE_RUN_WORLD: WorldSet = worldsNamed("workflow_run/base");
/** Worlds in which a step runs with secrets on text an outsider wrote. */
export const PRIVILEGED_WORLDS: WorldSet = worldsNamed(
  "workflow_run/fork",
  "workflow_run/base",
  "pull_request_target",
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
);
/**
 * Worlds that a pull request from a fork starts. The review events are here and not among the privileged worlds,
 * because GitHub gives a fork's run of them no secrets and a read-only token, as it does `pull_request`.
 */
export const PULL_REQUEST_WORLDS: WorldSet = worldsNamed(
  "pull_request_target",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
);

const TRIGGER_WORLDS = new Map<string, WorldSet>();
WORLDS.forEach((w, i) => TRIGGER_WORLDS.set(w.trigger, (TRIGGER_WORLDS.get(w.trigger) ?? 0) | (1 << i)));

/** The worlds a trigger can start. Null, a trigger list that could not be read, gives every world. */
export const worldsOf = (trigger: string | null): WorldSet =>
  trigger === null ? ALL_WORLDS : (TRIGGER_WORLDS.get(trigger) ?? 0);

const worldList = (set: WorldSet): number[] => WORLDS.flatMap((_, i) => (set & (1 << i) ? [i] : []));

// ---- conditions -----------------------------------------------------------------------------------------------------

const MAX_NOTE_TEXT = 200;
/** How many jobs are visited, and how many conditions kept, when a guard lists the conditions of the jobs it needs. */
const MAX_CLOSURE_JOBS = 50;
const MAX_GUARD_NOTES = 20;
const MAX_ENTRY_NOTES = 6;
const MAX_SITE_NOTES = 10;

/** A condition with its truth in each world, or `"unreadable"`. */
export interface ConditionNote {
  file: string;
  line: number;
  /** The text with its literals blanked, which alone may be stored. */
  text: Blanked;
  /** The hash of the condition as written, whitespace collapsed, for the reach hash. Never the text. */
  textHash: string;
  truth: readonly (boolean | null)[] | "unreadable";
  /** The condition as the reach hash counts it inside a `Digest`: its file, `textHash` and truth in every world. */
  digest: Digest;
}

/**
 * The worlds a line can run in, and the conditions on the way to it, nearest first, at most 20 of them for display.
 * `digest` counts every condition the guard rests on, however many there are.
 */
export interface Guard {
  open: WorldSet;
  notes: readonly ConditionNote[];
  digest: Digest;
}

/**
 * A sum of hashes in two 32-bit halves, which does not depend on the order of what was added, so that a list can be
 * counted whole for the reach hash while only its head is kept for display. Something reached twice, such as a job that
 * two needs share, is counted twice, which is still the same sum for the same workflows.
 */
export type Digest = readonly [hi: number, lo: number];
const NO_DIGEST: Digest = [0, 0];
const plus = (a: Digest, b: Digest): Digest => [(a[0] + b[0]) % 0x1_0000_0000, (a[1] + b[1]) % 0x1_0000_0000];

/** What stands in for text that cannot be told from a literal, after a quote that is never closed or is escaped. */
const CUT_MARKER = " ...";

declare const blanked: unique symbol;
/** Text that `blankStrings` has taken every literal out of. Only it makes one, so raw text cannot be stored by mistake. */
export type Blanked = string & { readonly [blanked]: true };

/**
 * Text that is stored, with every literal taken out, because a literal may be a hardcoded token, cut at `max`
 * characters. A quoted string, in single quotes with `''` inside, or in double quotes, becomes `''`. A quote that is never
 * closed, a double-quoted string holding a backslash, and a quote that a backslash escapes, opening or closing a string
 * of either kind, cannot be told from a literal that runs on, so the rest of the text is dropped and `''` and a marker
 * stand in for it. Anything from a `#` outside a string is cut, because it is a comment, or script text in a block, that
 * a person may have put a secret in. Whitespace is collapsed.
 */
export function blankStrings(text: string, max = Infinity): Blanked {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "#") break;
    if (char === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) {
      out += `''${CUT_MARKER}`;
      break;
    }
    if (char !== "'" && char !== '"') {
      out += char;
      continue;
    }
    let end = i + 1;
    for (; end < text.length; end++) {
      const at = text[end];
      if (at === "\\" && char === '"') {
        end = text.length;
        break;
      }
      if (at !== char) continue;
      if (char === "'" && text[end + 1] === "'") end++;
      else {
        if (text[end - 1] === "\\") end = text.length;
        break;
      }
    }
    if (end >= text.length) {
      out += `''${CUT_MARKER}`;
      break;
    }
    out += "''";
    i = end;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max) as Blanked;
}

const noteText = (source: ConditionSource): Blanked => blankStrings(source.text ?? source.raw, MAX_NOTE_TEXT);

const OPEN: Guard = { open: ALL_WORLDS, notes: [], digest: NO_DIGEST };

/** One condition, read once: the tree, or null when it is unreadable. */
interface Condition {
  source: ConditionSource;
  expr: Expr | null;
}

const conditionOf = (source: ConditionSource | null): Condition | null =>
  source ? { source, expr: source.text === null ? null : parseExpression(source.text) } : null;

export interface Guards {
  /** The guard of the step holding row `k`, or of its job when it is in none, or open when it is in neither. */
  at(k: number): Guard;
}

/**
 * The guard of any row, from its step's `if:`, its job's `if:`, and the jobs that its job needs. Jobs are visited in
 * the order of `needs`, by Kahn's algorithm so that a long chain costs no recursion. A job with a direct need that is
 * skipped in a world is skipped there too, unless its condition names a status function, which is the documented chain
 * rule. A need that runs because of `always()` therefore passes on its own result and not its needs'. In a
 * world where a direct need is known to be skipped, `needs.<id>.result` reads `'skipped'` and each of its outputs reads
 * null. Anything else under `needs` is unknown: the outputs as a whole, which are an empty map and truthy, and a job that
 * is not a direct need, which GitHub gives as null.
 *
 * A job with `needs` that cannot be read, that names a missing or repeated job, or that sits in a cycle, may run in
 * every world. Work is done on first use and kept, so a file with no match costs nothing and many matches in one step
 * cost one evaluation.
 */
export function guardsOf(path: string, rows: readonly Row[], structure: Structure): Guards {
  const { jobs, steps, jobOf, stepOf } = structure;
  const W = WORLDS.length;
  const byId = new Map<string, number>();
  jobs.forEach((job, j) => {
    const id = job.id.toLowerCase();
    byId.set(id, byId.has(id) ? -1 : j);
  });
  const needsOf: (readonly number[] | null)[] = jobs.map((job) => {
    if (job.needs === null) return null;
    const found = new Set<number>();
    for (const id of job.needs) {
      const n = byId.get(id.toLowerCase()) ?? -1;
      if (n < 0) return null;
      found.add(n);
    }
    return [...found];
  });

  // Per job and world: whether the job runs (true, false, or null for may).
  const runs: (boolean | null)[] = [];
  const jobNotes: (ConditionNote | null)[] = jobs.map(() => null);
  const jobConditions = jobs.map((job) => conditionOf(job.condition));
  let layered = false;

  const scopeOf = (j: number, w: number, success: Outcome): Scope => ({
    success: () => success,
    lookup: (names) => {
      if (names[0] === "needs") {
        const needs = j >= 0 ? needsOf[j] : null;
        const n = names.length >= 3 ? (byId.get(names[1]!) ?? -1) : -1;
        if (!needs || n < 0 || !needs.includes(n) || runs[n * W + w] !== false) return UNKNOWN;
        if (names.length === 3 && names[2] === "result") return { known: true, value: "skipped" };
        return names[2] === "outputs" && names.length >= 4 ? { known: true, value: null } : UNKNOWN;
      }
      const fact = WORLDS[w]!.facts.get(names.join("."));
      return fact === undefined ? UNKNOWN : { known: true, value: fact };
    },
  });

  const noteOf = (source: ConditionSource, truth: ConditionNote["truth"]): ConditionNote => {
    const textHash = lineHashOf(source.raw);
    return {
      file: path,
      line: source.line,
      text: noteText(source),
      textHash,
      truth,
      digest: fnv(JSON.stringify([path, textHash, truth])),
    };
  };
  // Per job: the digest of its own condition and of every job it needs, directly or not, worked out in `needs` order.
  const closures: Digest[] = jobs.map(() => NO_DIGEST);

  const layer = () => {
    if (layered) return;
    layered = true;
    const indegree = jobs.map((_, j) => needsOf[j]?.length ?? 0);
    const dependants: number[][] = jobs.map(() => []);
    needsOf.forEach((needs, j) => needs?.forEach((n) => dependants[n]!.push(j)));
    const order: number[] = [];
    indegree.forEach((count, j) => {
      if (count === 0) order.push(j);
    });
    for (let next = 0; next < order.length; next++)
      for (const d of dependants[order[next]!]!) if (--indegree[d]! === 0) order.push(d);
    // Jobs in a cycle, and those waiting on one, may run in every world, so they are read as having no `needs`.
    const visited = new Set(order);
    const held: number[] = [];
    jobs.forEach((_, j) => {
      if (!visited.has(j)) {
        needsOf[j] = null;
        held.push(j);
      }
    });
    for (const j of [...order, ...held]) {
      const needs = needsOf[j];
      const condition = jobConditions[j];
      const truth: (boolean | null)[] = [];
      for (let w = 0; w < W; w++) {
        // Each need's own `runs` already counts that need's own needs, so only a direct need matters here.
        const skipped = needs?.some((n) => runs[n * W + w] === false) ?? false;
        const success: Outcome = skipped
          ? { known: true, value: false }
          : needs?.length === 0
            ? { known: true, value: true }
            : UNKNOWN;
        const scope = scopeOf(j, w, success);
        if (!condition) runs[j * W + w] = truthOf(success);
        else if (!condition.expr) runs[j * W + w] = null;
        else {
          const truths = conditionTruths(condition.expr, scope);
          runs[j * W + w] = truths.full;
          truth.push(truths.own);
        }
        if (!visited.has(j)) runs[j * W + w] = null;
      }
      if (condition) jobNotes[j] = noteOf(condition.source, condition.expr ? truth : "unreadable");
      closures[j] = (needs ?? []).reduce((sum, n) => plus(sum, closures[n]!), jobNotes[j]?.digest ?? NO_DIGEST);
    }
  };

  const jobGuards = new Map<number, Guard>();
  const jobGuard = (j: number): Guard => {
    const cached = jobGuards.get(j);
    if (cached) return cached;
    layer();
    let open = 0;
    for (let w = 0; w < W; w++) if (runs[j * W + w] !== false) open |= 1 << w;
    // The conditions of the jobs this one needs, nearest first, from a walk that stops early so a long chain stays cheap.
    const notes: ConditionNote[] = [];
    const seen = new Set<number>([j]);
    const queue = [j];
    for (let next = 0; next < queue.length && next < MAX_CLOSURE_JOBS && notes.length < MAX_GUARD_NOTES; next++) {
      const at = queue[next]!;
      const note = jobNotes[at];
      if (note) notes.push(note);
      for (const n of needsOf[at] ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    const guard = { open, notes, digest: closures[j]! };
    jobGuards.set(j, guard);
    return guard;
  };

  const stepGuards = new Map<number, Guard>();
  const stepGuard = (i: number): Guard => {
    const cached = stepGuards.get(i);
    if (cached) return cached;
    const step = steps[i]!;
    const parent = step.job >= 0 ? jobGuard(step.job) : OPEN;
    const condition = conditionOf(step.condition);
    let guard = parent;
    if (condition) {
      const truth: (boolean | null)[] = [];
      let open = parent.open;
      for (let w = 0; w < W; w++) {
        const scope = scopeOf(step.job, w, UNKNOWN);
        if (!condition.expr) continue;
        const truths = conditionTruths(condition.expr, scope);
        truth.push(truths.own);
        if (truths.full === false) open &= ~(1 << w);
      }
      const note = noteOf(condition.source, condition.expr ? truth : "unreadable");
      guard = { open, notes: [note, ...parent.notes].slice(0, MAX_GUARD_NOTES), digest: plus(note.digest, parent.digest) };
    }
    stepGuards.set(i, guard);
    return guard;
  };

  return {
    at: (k) => {
      const i = stepOf[k]!;
      if (i >= 0) return stepGuard(i);
      const j = jobOf[k]!;
      return j >= 0 ? jobGuard(j) : OPEN;
    },
  };
}

// ---- routes ---------------------------------------------------------------------------------------------------------

/** One way an event reaches a file: its trigger, the calls it came through, and the callers' conditions. */
export interface ReachEntry {
  /** Null when the file's own triggers could not be read. */
  trigger: string | null;
  worlds: WorldSet;
  /** The calls from the file with the trigger down to this one; null for the overflow entry of a trigger. */
  via: WorkflowHop[] | null;
  /** The callers' conditions that did not rule the worlds out, nearest first, at most six of them for display. */
  conditions: readonly ConditionNote[];
  /** Every condition of the calling jobs along the route, however many, as the reach hash counts them. */
  digest: Digest;
  /**
   * For the overflow entry only, the hash of every local call in the repository and the worlds each leaves open. It
   * stands in the reach hash for the routes the entry was not followed along, so a call added or changed anywhere,
   * such as a caller past the caps, changes the reach hash of a finding the entry reaches.
   */
  calls?: string;
}

/** Routed entries held for one file, and the longest chain of calls followed. GitHub's own nesting limit is ten. */
const MAX_ROUTES = 20;
const MAX_ROUTE_HOPS = 10;

interface CallSite {
  target: string;
  hop: WorkflowHop;
  open: WorldSet;
  /** At most ten, for display. */
  notes: readonly ConditionNote[];
  /** The digests of the guards of every call merged into the site. */
  digest: Digest;
}

/**
 * The segments of a local `uses:` path after its `./`, with empty and `.` segments dropped and each `..` taking off the
 * segment before it, as GitHub resolves the path in the repository. Null when it climbs above the root.
 */
function localSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments;
}

const routeText = (entry: ReachEntry) => (entry.via ? entry.via.map((hop) => `${hop.file}#${hop.job ?? ""}`).join(">") : "");

const byRoute = (a: ReachEntry, b: ReachEntry): number =>
  Number(b.via === null) - Number(a.via === null) ||
  compareText(a.trigger ?? "", b.trigger ?? "") ||
  compareText(routeText(a), routeText(b));

/** Whether a condition, in the given worlds, could be true or unknown, which is when it belongs in an explanation. */
function verdictOf(note: ConditionNote, worlds: WorldSet): WorkflowCondition["verdict"] | null {
  if (note.truth === "unreadable") return "unreadable";
  let live = false;
  let unknown = false;
  for (const w of worldList(worlds)) {
    const truth = note.truth[w];
    if (truth !== false) live = true;
    if (truth === null) unknown = true;
  }
  return live ? (unknown ? "unknown" : "holds") : null;
}

/**
 * Every file's routes. Each file's rows are read once and dropped, so no more than one file's rows are held at a time.
 * A route is added once and never grows, and a file holds at most 20 routed entries and one overflow entry for each
 * trigger, so the work stays in proportion to the calls. Past 20 routes or 10 calls the trigger's overflow entry stands
 * for the rest: it lets every world of the trigger through, as if no caller had a condition, because the callers it
 * stands for were not followed. Conditions inside the file itself still apply to it.
 */
export function reachOf(files: readonly CandidateFile[]): Map<string, ReachEntry[]> {
  const known = new Set(files.map((file) => file.path));
  const entries = new Map<string, ReachEntry[]>();
  const sites = new Map<string, CallSite[]>();
  const queue: { path: string; entry: ReachEntry }[] = [];

  for (const { path, content } of files) {
    const rows = rowsOf(content);
    const seeded: ReachEntry[] = [];
    if (!isActionPath(path)) {
      const triggers = triggersOf(rows);
      for (const trigger of triggers === null ? [null] : [...triggers].sort(compareText)) {
        const worlds = worldsOf(trigger);
        if (worlds) seeded.push({ trigger, worlds, via: [], conditions: [], digest: NO_DIGEST });
      }
    }
    entries.set(path, seeded);
    for (const entry of seeded) queue.push({ path, entry });

    // A call is a `uses:` row that names a local path: `./.github/workflows/x.yml` for a reusable workflow, and
    // `./dir` for the composite action in `dir/action.yml` or `dir/action.yaml`. Only paths in `known` count.
    const calls: { k: number; target: string }[] = [];
    rows.forEach((row, k) => {
      if (row.scalar) return;
      const value = /^uses\s*:\s*(.+)$/.exec(row.text)?.[1];
      if (value === undefined) return;
      const target = unquote(value.trim());
      const dir = target.startsWith("./") ? localSegments(target.slice(2)) : null;
      if (dir === null) return;
      for (const candidate of [dir, [...dir, "action.yml"], [...dir, "action.yaml"]].map((segments) => segments.join("/")))
        if (known.has(candidate)) calls.push({ k, target: candidate });
    });
    if (calls.length === 0) continue;
    const structure = structureOf(rows);
    const guards = guardsOf(path, rows, structure);
    const merged = new Map<string, CallSite>();
    for (const { k, target } of calls) {
      const guard = guards.at(k);
      if (guard.open === 0) continue;
      const job = structure.jobs[structure.jobOf[k]!]?.id ?? null;
      const id = `${target}\0${job ?? ""}`;
      const site = merged.get(id);
      if (!site) {
        const notes = guard.notes.slice(0, MAX_SITE_NOTES);
        merged.set(id, { target, hop: { file: path, job }, open: guard.open, notes, digest: guard.digest });
      } else {
        site.open |= guard.open;
        const notes = [...site.notes];
        for (const note of guard.notes) if (!notes.includes(note) && notes.length < MAX_SITE_NOTES) notes.push(note);
        site.notes = notes;
        site.digest = plus(site.digest, guard.digest);
      }
    }
    sites.set(path, [...merged.values()]);
  }

  // Every call, with the conditions of its caller, summed so that the order in which calls are written does not matter.
  let callCount = 0;
  let callDigest = NO_DIGEST;
  for (const [path, list] of sites) {
    for (const site of list) {
      callCount++;
      callDigest = plus(callDigest, fnv(JSON.stringify([path, site.hop.job, site.target, site.open, site.digest])));
    }
  }
  const calls = shortHash(`${callCount}\0${callDigest[0]}\0${callDigest[1]}`);

  const routed = new Map<string, number>();
  const overflowed = new Set<string>();
  const overflow = (path: string, trigger: string | null) => {
    const id = `${path}\0${trigger ?? ""}`;
    if (overflowed.has(id)) return;
    overflowed.add(id);
    const entry: ReachEntry = { trigger, worlds: worldsOf(trigger), via: null, conditions: [], digest: NO_DIGEST, calls };
    entries.get(path)!.push(entry);
    queue.push({ path, entry });
  };

  for (let next = 0; next < queue.length; next++) {
    const { path, entry } = queue[next]!;
    for (const site of sites.get(path) ?? []) {
      const worlds = entry.worlds & site.open;
      if (worlds === 0) continue;
      const target = site.target;
      if (entry.via === null) {
        overflow(target, entry.trigger);
        continue;
      }
      if (target === path || entry.via.some((hop) => hop.file === target)) continue;
      if (entry.via.length >= MAX_ROUTE_HOPS || (routed.get(target) ?? 0) >= MAX_ROUTES) {
        overflow(target, entry.trigger);
        continue;
      }
      const via = [...entry.via, site.hop];
      const own = site.notes.filter((note) => verdictOf(note, worlds) !== null);
      const created: ReachEntry = {
        trigger: entry.trigger,
        worlds,
        via,
        conditions: [...own, ...entry.conditions].slice(0, MAX_ENTRY_NOTES),
        digest: plus(entry.digest, site.digest),
      };
      entries.get(target)!.push(created);
      routed.set(target, (routed.get(target) ?? 0) + 1);
      queue.push({ path: target, entry: created });
    }
  }
  for (const list of entries.values()) list.sort(byRoute);
  return entries;
}

// ---- reasons --------------------------------------------------------------------------------------------------------

/** At most this many routes and conditions are kept for a finding, so a contrived repository cannot make facts large. */
const MAX_REASON_ROUTES = 3;
const MAX_REASON_CONDITIONS = 3;

export interface Reason {
  routes: WorkflowRoute[];
  routesDropped: number;
  conditions: WorkflowCondition[];
  conditionsDropped: number;
  /** The hash of every route that reaches the line and every condition consulted on the way, before any cap. */
  reachHash: string;
}

/** The reach hash of a finding that reads no route and no condition, such as a command piped into a shell. */
export const NO_REACH_HASH = shortHash("");

/** A route as the reach hash counts it: its trigger, its calls and every condition of its callers, with no line numbers. */
const routeKey = (entry: ReachEntry): string =>
  JSON.stringify([
    "route",
    entry.trigger,
    entry.via && entry.via.map((hop) => [hop.file, hop.job]),
    entry.calls ?? null,
    entry.digest,
  ]);

/**
 * For a file's entries, a function that answers whether a line with the given guard can be reached by a world in `mask`,
 * and by which routes and past which conditions. Null when it cannot, which is when the finding is not reported. The
 * answer is kept for each guard and mask, so many matches in one step cost one evaluation.
 *
 * The reach hash covers every route that reaches the line and every condition it rests on, before any cap on what is
 * kept or shown. A route counts as its trigger, its calls and the digest of every condition of its callers, and the line
 * as the digest of every condition of its own step, its job and the jobs that job needs. In a digest a condition counts
 * as the hash of its text as written, whitespace collapsed, and its truth in each world. The conditions that are kept
 * for display, at most 20 of the line's own and six on each route, count once more with the verdict they would be shown
 * with. A changed literal, a changed verdict or a guard taken away therefore changes the hash however far along the
 * route it is, while moving the lines does not. The keys are sorted, so the order the routes were found in does not
 * matter, and only the hash of them is kept, never their text.
 */
export function reasoner(entries: readonly ReachEntry[]): (guard: Guard, mask: WorldSet) => Reason | null {
  const cache = new Map<Guard, Map<WorldSet, Reason | null>>();
  return (guard, mask) => {
    const byMask = cache.get(guard) ?? new Map<WorldSet, Reason | null>();
    cache.set(guard, byMask);
    if (byMask.has(mask)) return byMask.get(mask)!;
    const reached = entries.filter((entry) => entry.worlds & guard.open & mask);
    let reason: Reason | null = null;
    if (reached.length > 0) {
      const shown = reached.slice(0, MAX_REASON_ROUTES);
      const conditions: WorkflowCondition[] = [];
      const listed = new Set<string>();
      let dropped = 0;
      const consulted = new Map<string, string>();
      /** Counts each condition for the hash, once for each place and verdict, and lists it when `shown`, once for each place. */
      const consult = (notes: readonly ConditionNote[], worlds: WorldSet, shown: boolean) => {
        for (const note of notes) {
          const verdict = verdictOf(note, worlds);
          if (verdict === null) continue;
          consulted.set(`${note.file}\0${note.line}\0${verdict}`, JSON.stringify(["if", note.file, note.textHash, verdict]));
          const id = `${note.file}\0${note.line}`;
          if (!shown || listed.has(id)) continue;
          listed.add(id);
          if (conditions.length < MAX_REASON_CONDITIONS)
            conditions.push({ file: note.file, line: note.line, text: note.text, verdict });
          else dropped++;
        }
      };
      consult(
        guard.notes,
        reached.reduce((set, entry) => set | (entry.worlds & guard.open & mask), 0),
        true,
      );
      reached.forEach((entry, i) => consult(entry.conditions, entry.worlds & guard.open & mask, i < shown.length));
      const keys = reached.map(routeKey);
      keys.push(JSON.stringify(["guard", guard.digest]));
      for (const key of consulted.values()) keys.push(key);
      reason = {
        routes: shown.map((entry) => ({ trigger: entry.trigger, via: entry.via && entry.via.map((hop) => ({ ...hop })) })),
        routesDropped: reached.length - shown.length,
        conditions,
        conditionsDropped: dropped,
        reachHash: shortHash(keys.sort(compareText).join("\0")),
      };
    }
    byMask.set(mask, reason);
    return reason;
  };
}

// ---- hashing --------------------------------------------------------------------------------------------------------

/** FNV-1a over 64 bits, as its two 32-bit halves. See `shortHash`. */
function fnv(text: string): [hi: number, lo: number] {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    lo = (lo ^ text.charCodeAt(i)) >>> 0;
    // Multiply by 0x100000001b3, which is 2^40 + 0x1b3, modulo 2^64.
    const product = lo * 0x1b3;
    const carry = Math.floor(product / 0x1_0000_0000);
    hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) % 0x1_0000_0000;
    lo = product % 0x1_0000_0000;
  }
  return [hi, lo];
}

/**
 * FNV-1a over 64 bits, as 16 hex characters. It runs over UTF-16 code units, which are the bytes for ASCII, in two
 * 32-bit halves that stay exact in a double, with no `BigInt` and no `node:crypto`, because the web app imports core.
 * It tells one line from another and is not a secret: it is the whole line that is hashed, so a short secret in a quoted
 * string could be guessed from it, but the line is already readable in the repository itself.
 */
export function shortHash(text: string): string {
  const [hi, lo] = fnv(text);
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * The hash of a line with its whitespace collapsed, quoted text included, so that a changed literal, such as the address a
 * download comes from, changes it, while a change in spacing does not. It is never the text.
 */
export const lineHashOf = (text: string): string => shortHash(text.replace(/\s+/g, " ").trim());
