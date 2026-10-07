import { instant, rangeOf, sinceCreated, toFirstPr, toProduction, type Range } from "./delivery.js";
import { shippedPrs } from "./dora.js";
import { issueKeysOf } from "./features.js";
import { isBot } from "./pullRequests.js";
import { hoursBetween, median, summarise, weekRange, weekStart, type Summary } from "./stats.js";
import type {
  DeployRun,
  PullRequest,
  Repo,
  StatusCategory,
  TrackerSpace,
  WorkItem,
  WorkItemLevel,
  WorkItemTransition,
} from "./types.js";

/**
 * Delivery measured from a tracker space (ADR 0021). Every figure counts delivery items only: standard issues
 * such as stories, bugs, tasks and features. A sub-task is not counted, but a pull request naming it links to its
 * parent, and epics are not counted.
 * Names are distinct from DORA lead time on purpose (ADR 0020).
 */

/** A repository linked to the space, with what was crawled from it. */
export interface LinkedRepoData {
  repo: Pick<Repo, "id" | "owner" | "name" | "deployBranch">;
  prs: PullRequest[];
  runs: DeployRun[];
}

export interface SpaceReportOptions {
  /** YYYY-MM-DD; defaults to the earliest item's creation. */
  from?: string;
  /** YYYY-MM-DD, inclusive; defaults to `now`. */
  to?: string;
  /** The instant the report is built at, ISO. Passed in so the report stays pure. */
  now: string;
  /** Include assignee names in hygiene findings. Off by default (ADR 0008). */
  people?: boolean;
}

/** One delivery item named in a finding or a list. */
export interface ItemRef {
  key: string;
  type: string;
  summary: string;
  /** Whether anyone is assigned. It names nobody, so it is always present, with or without `people`. */
  assigned: boolean;
  /**
   * Present only when `people` was asked for: the assignee's display name, or null when nobody is assigned or the
   * space holds no name for the assignee, as for a space crawled before names were recorded. `assigned` tells the two
   * apart.
   */
  assignee?: string | null;
}

export interface SpaceWeekRow {
  /** Monday, YYYY-MM-DD. */
  week: string;
  /** Delivery items done that week, by type name. */
  doneByType: Record<string, number>;
  done: number;
  /** Delivery items in an in-progress status at the last millisecond of the week, or at the end of the range when that is earlier. */
  inProgress: number;
  /** True when the week runs past the end of the range. */
  partial: boolean;
}

export interface ColumnTime {
  /** A board column's name, or null for time in statuses that map to no column of the board. */
  column: string | null;
  /** Mean hours per done item, so columns add up across the cycle. */
  meanHours: number;
  /** Median hours over the items that spent time in the column; a column is listed only when at least one did. */
  medianHours: number;
  /** Done items that spent any time in this column. */
  items: number;
}

export interface AgeingItem extends ItemRef {
  status: string;
  startedAt: string;
  ageHours: number;
}

export type SpaceHygieneCheck =
  | "pr_without_key"
  | "done_without_pr"
  | "skipped_in_progress"
  | "bulk_move"
  | "reopened"
  | "stale_in_progress"
  | "in_progress_unassigned";

/** The checks whose findings list delivery items and nothing else. */
export type SpaceHygieneItemCheck = Exclude<SpaceHygieneCheck, "pr_without_key" | "bulk_move">;

/** What every hygiene finding carries, whatever it lists. */
interface SpaceHygieneTally {
  /** How many items or pull requests were found. */
  count: number;
  /** Out of how many were checked, so a share can be shown; null when a share means nothing. */
  of: number | null;
}

/** Merged pull requests that name no issue key. */
export interface SpaceHygienePullRequestFinding extends SpaceHygieneTally {
  check: "pr_without_key";
  pullRequests: { repo: string; number: number; title: string; url: string }[];
}

/** Delivery items moved into done in batches. */
export interface SpaceHygieneBulkMoveFinding extends SpaceHygieneTally {
  check: "bulk_move";
  /** Every item in any batch. */
  items: ItemRef[];
  /** Each batch, when it happened and which items moved. */
  batches: { at: string; keys: string[] }[];
}

/** Any other check: the delivery items it found. */
export interface SpaceHygieneItemFinding extends SpaceHygieneTally {
  check: SpaceHygieneItemCheck;
  items: ItemRef[];
}

/** One hygiene check's result. `check` says which variant it is, so each carries only the list its check fills. */
export type SpaceHygieneFinding = SpaceHygienePullRequestFinding | SpaceHygieneBulkMoveFinding | SpaceHygieneItemFinding;

export interface SpaceReport {
  /** The space, with how its latest crawl went, so a page can say when the figures come from an older crawl. */
  space: Pick<TrackerSpace, "id" | "key" | "name" | "siteUrl" | "lastCrawledAt" | "crawlStatus" | "crawlError" | "board">;
  range: { from: string; to: string };
  repos: { id: number; name: string }[];
  totals: {
    /** Delivery items done in the range. */
    done: number;
    /** Delivery items in progress at the end of the range. */
    inProgress: number;
    /** Delivery items created in the range. */
    created: number;
    /** Epics whose current category is not done, as of now rather than the end of the range; shown apart, never counted. */
    epicsOpen: number;
  };
  /** Started to done, hours. */
  issueCycleTime: Summary;
  /** Created to done, hours. */
  issueLeadTime: Summary;
  weekly: SpaceWeekRow[];
  /** Oldest first. */
  ageing: AgeingItem[];
  columns: ColumnTime[];
  /** Active hours divided by started-to-done hours, over done items; null when nothing was measured. */
  flowEfficiency: number | null;
  ideaToProduction: {
    /** Created to the first linked pull request opened, hours. */
    toFirstPr: Summary;
    /** Created to the latest deploy among those that shipped its merged linked pull requests, hours; an item counts only when every one has shipped. */
    toProduction: Summary;
    /** Done delivery items with at least one linked pull request, out of all done delivery items. */
    linked: number;
    of: number;
  };
  hygiene: SpaceHygieneFinding[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A bulk move is this many distinct items moved into done within the window of the first move (ADR 0021). */
const BULK_MIN_ITEMS = 5;
const BULK_WINDOW_MS = 10 * 60_000;
/** Work in progress with no update for longer than this is stale. */
const STALE_MS = 7 * DAY_MS;
/**
 * In-progress statuses whose names say the item is waiting rather than being worked on. Each word must stand alone,
 * so "Blocked", "On hold", "Waiting for QA", "Ready for QA" and "Queued" match, while "Already in progress" and
 * "Blockchain" do not. Anything other than a letter separates words, so "ON_HOLD" matches too.
 */
const WAITING =
  /(?<![a-z])(?:block(?:ed|ers?|s)?|hold(?:ing|s)?|held|a?wait(?:ed|ing|s)?|ready|queue(?:d|s|ing)?|queuing)(?![a-z])/i;

/** Keys in natural order, so WID-2 comes before WID-10. */
const byKey = new Intl.Collator("en", { numeric: true }).compare;

/** The level recorded by the crawl, or one inferred from the type name for items crawled before it was. */
function levelOf(item: WorkItem): WorkItemLevel {
  if (item.level) return item.level;
  if (/^sub-?task$/i.test(item.type)) return "subtask";
  return /^epic$/i.test(item.type) ? "epic" : "standard";
}

/** A delivery item with its history in time order and the two moments every measure starts from. */
interface Tracked {
  item: WorkItem;
  /** In time order. The last move carries the item's own category when the space does not know the status it reached. */
  history: WorkItemTransition[];
  /** The first move into an in-progress status. */
  startedAt: string | null;
  /** The start of the final stretch in done, for an item that is done now. */
  doneAt: string | null;
}

/** A move into done from a status that is not done. A move between two done statuses, such as Done to Released, is not. */
const entersDone = (t: WorkItemTransition) => t.toCategory === "done" && t.fromCategory !== "done";
/** A move out of done, the mirror of `entersDone`: to any status that is not done, including one of unknown category. */
const leavesDone = (t: WorkItemTransition) => t.fromCategory === "done" && t.toCategory !== "done";

function track(item: WorkItem): Tracked {
  const history = [...item.transitions].sort((a, b) => instant(a.at) - instant(b.at));
  // The last move reached the item's current status, so when the space no longer lists that status, the category the
  // item carries now is the category of where it moved to.
  const last = history.at(-1);
  if (last && last.toCategory === null) history[history.length - 1] = { ...last, toCategory: item.statusCategory };
  const startedAt = history.find((t) => t.toCategory === "in_progress")?.at ?? null;
  // Done now with no move into done in the history, as when a status was recategorised as done after the move: counted
  // from the last move, or from creation without any history, rather than left out of every done figure.
  const doneAt = item.statusCategory === "done" ? (history.findLast(entersDone)?.at ?? last?.at ?? item.createdAt) : null;
  return { item, history, startedAt, doneAt };
}

/** The item's status category at `ms`, replayed from its history; null before it existed or in an unknown status. */
function categoryAt({ item, history }: Tracked, ms: number): StatusCategory | null {
  if (history.length === 0) return instant(item.createdAt) <= ms ? item.statusCategory : null;
  let category: StatusCategory | null = null;
  for (const step of history) {
    if (instant(step.at) > ms) break;
    category = step.toCategory;
  }
  return category;
}

/** A pull request from a linked repository, with the keys it names and when it reached production. */
interface LinkedPr {
  repo: string;
  pr: PullRequest;
  keys: string[];
  /** Completion of the deploy that shipped it, paired as DORA lead time pairs it (ADR 0007); null when not shipped. */
  deployedAt: string | null;
}

function linkedPrsOf(linked: readonly LinkedRepoData[]): LinkedPr[] {
  return linked.flatMap(({ repo, prs, runs }) => {
    const shipped = new Map<PullRequest, string>(
      shippedPrs(prs, runs, repo.deployBranch).map(({ pr, deploy }) => [pr, deploy.completedAt]),
    );
    return prs.map((pr) => ({
      repo: `${repo.owner}/${repo.name}`,
      pr,
      keys: issueKeysOf(pr),
      deployedAt: shipped.get(pr) ?? null,
    }));
  });
}

/** Each delivery item's pull requests: those naming its own key or the key of one of its sub-tasks. */
function prsByItem(items: readonly WorkItem[], delivery: readonly Tracked[], prs: readonly LinkedPr[]) {
  const subtaskKeys = new Map<string, string[]>();
  for (const item of items.filter((i) => levelOf(i) === "subtask" && i.parentKey !== null)) {
    subtaskKeys.set(item.parentKey!, [...(subtaskKeys.get(item.parentKey!) ?? []), item.key]);
  }
  const naming = new Map<string, LinkedPr[]>();
  for (const pr of prs) for (const key of pr.keys) naming.set(key, [...(naming.get(key) ?? []), pr]);
  return new Map(
    delivery.map(({ item }) => {
      const keys = [item.key, ...(subtaskKeys.get(item.key) ?? [])];
      return [item.key, [...new Set(keys.flatMap((key) => naming.get(key) ?? []))]];
    }),
  );
}

/** An assignee's display name, read only from the space's own entries so a key such as `constructor` finds nothing. */
function nameOf(people: TrackerSpace["people"], accountId: string | null): string | null {
  if (accountId === null || !people || !Object.hasOwn(people, accountId)) return null;
  return people[accountId]!;
}

interface Segment {
  status: string;
  category: StatusCategory | null;
  hours: number;
}

/** Time spent in each status between starting and finishing; moments of no length are left out. */
function segmentsOf({ history, startedAt, doneAt }: Tracked): Segment[] {
  const start = instant(startedAt!);
  const end = instant(doneAt!);
  return history.flatMap((step, i) => {
    const next = history[i + 1];
    const from = Math.max(instant(step.at), start);
    const to = Math.min(next ? instant(next.at) : end, end);
    return to > from ? [{ status: step.to, category: step.toCategory, hours: (to - from) / HOUR_MS }] : [];
  });
}

/**
 * How a status name becomes a column, and the order columns are shown in. On a board, a status that no column holds
 * becomes null, shown last. Without a board every status is its own column, so null never appears.
 */
function columnsOf(space: TrackerSpace): { nameOf: (status: string) => string | null; order: (string | null)[] } {
  const statusNamed = (name: string) =>
    space.statuses.find((s) => s.name === name) ?? space.statuses.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (space.columns.length === 0) {
    return { nameOf: (status: string) => statusNamed(status)?.name ?? status, order: space.statuses.map((s) => s.name) };
  }
  const nameOf = (status: string) => {
    const id = statusNamed(status)?.id;
    return space.columns.find((c) => id !== undefined && c.statusIds.includes(id))?.name ?? null;
  };
  return { nameOf, order: [...space.columns.map((c) => c.name), null] };
}

function columnTimes(space: TrackerSpace, walked: readonly Tracked[]): ColumnTime[] {
  const { nameOf, order } = columnsOf(space);
  const perColumn = new Map<string | null, number[]>();
  for (const tracked of walked) {
    const hoursIn = new Map<string | null, number>();
    for (const { status, hours } of segmentsOf(tracked)) {
      const column = nameOf(status);
      hoursIn.set(column, (hoursIn.get(column) ?? 0) + hours);
    }
    for (const [column, hours] of hoursIn) perColumn.set(column, [...(perColumn.get(column) ?? []), hours]);
  }
  const rank = (column: string | null) => (order.includes(column) ? order.indexOf(column) : order.length);
  // Only unknown statuses on a space with no board share a rank, and those always have a name to sort by.
  return [...perColumn]
    .sort(([a], [b]) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
    .map(([column, hours]) => ({
      column,
      meanHours: hours.reduce((sum, h) => sum + h, 0) / walked.length,
      // Every listed column holds at least one item's hours, so there is always a median.
      medianHours: median(hours)!,
      items: hours.length,
    }));
}

/** Active in-progress hours over started-to-done hours, summed across the items. */
function flowEfficiencyOf(walked: readonly Tracked[]): number | null {
  let active = 0;
  let total = 0;
  for (const tracked of walked) {
    total += hoursBetween(tracked.startedAt, tracked.doneAt)!;
    for (const { status, category, hours } of segmentsOf(tracked)) {
      if (category === "in_progress" && !WAITING.test(status)) active += hours;
    }
  }
  return total > 0 ? active / total : null;
}

function weeklyRows(range: Range, delivery: readonly Tracked[], doneItems: readonly Tracked[]): SpaceWeekRow[] {
  const weeks = weekRange(weekStart(new Date(range.start).toISOString()), weekStart(new Date(range.end).toISOString()));
  return weeks.map((week) => {
    const weekMs = instant(`${week}T00:00:00Z`);
    const doneThisWeek = doneItems.filter((t) => weekStart(t.doneAt!) === week);
    const doneByType: Record<string, number> = {};
    for (const { item } of doneThisWeek) doneByType[item.type] = (doneByType[item.type] ?? 0) + 1;
    const cutoff = Math.min(weekMs + WEEK_MS - 1, range.end);
    return {
      week,
      doneByType,
      done: doneThisWeek.length,
      inProgress: delivery.filter((t) => categoryAt(t, cutoff) === "in_progress").length,
      partial: weekMs + WEEK_MS > range.end + 1, // `end` is the last millisecond of the range
    };
  });
}

/**
 * Batches of moves into done, each taking every move within the window of its first, kept at five items or more.
 * A move between two done statuses is not one of them. A batch may start at any move: when a window holds too few,
 * the next move is tried; when it holds enough, the search carries on after the batch.
 */
function bulkMoves(delivery: readonly Tracked[], inRange: (iso: string) => boolean) {
  const moves = delivery
    .flatMap((tracked) => tracked.history.filter((t) => entersDone(t) && inRange(t.at)).map((t) => ({ tracked, at: t.at })))
    .sort((a, b) => instant(a.at) - instant(b.at) || byKey(a.tracked.item.key, b.tracked.item.key));
  const batches: { at: string; keys: string[] }[] = [];
  const moved = new Map<string, Tracked>();
  for (let i = 0; i < moves.length;) {
    const first = moves[i]!;
    let next = i;
    while (next < moves.length && instant(moves[next]!.at) - instant(first.at) <= BULK_WINDOW_MS) next++;
    const batch = new Map(moves.slice(i, next).map((m) => [m.tracked.item.key, m.tracked]));
    if (batch.size < BULK_MIN_ITEMS) {
      i++;
      continue;
    }
    batches.push({ at: first.at, keys: [...batch.keys()].sort(byKey) });
    for (const [key, tracked] of batch) moved.set(key, tracked);
    i = next;
  }
  return { batches, items: [...moved.values()] };
}

export function buildSpaceReport(
  space: TrackerSpace,
  items: WorkItem[],
  linked: LinkedRepoData[],
  options: SpaceReportOptions,
): SpaceReport {
  const range = rangeOf(items, options);
  const inRange = (iso: string) => instant(iso) >= range.start && instant(iso) <= range.end;
  const refOf = (item: WorkItem): ItemRef => {
    const ref: ItemRef = { key: item.key, type: item.type, summary: item.summary, assigned: item.assigneeId !== null };
    if (options.people) ref.assignee = nameOf(space.people, item.assigneeId);
    return ref;
  };
  const refsOf = (list: readonly Tracked[]) => list.map((t) => refOf(t.item)).sort((a, b) => byKey(a.key, b.key));
  const itemFinding = <C extends SpaceHygieneItemCheck | "bulk_move">(
    check: C,
    found: readonly Tracked[],
    of: number | null,
  ) => ({
    check,
    count: found.length,
    of,
    items: refsOf(found),
  });

  const delivery = items.filter((i) => levelOf(i) === "standard").map(track);
  const doneItems = delivery.filter((t) => t.doneAt !== null && inRange(t.doneAt));
  const walked = doneItems.filter((t) => t.startedAt !== null);
  const inProgressNow = delivery.filter((t) => t.item.statusCategory === "in_progress");

  const prs = linkedPrsOf(linked);
  const prsOf = prsByItem(items, delivery, prs);
  const withPr = new Set(doneItems.filter((t) => prsOf.get(t.item.key)!.length > 0));
  const mergedHuman = prs.filter((p) => p.pr.mergedAt !== null && inRange(p.pr.mergedAt) && !isBot(p.pr));
  const withoutKey = mergedHuman
    .filter((p) => p.keys.length === 0)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
  const bulk = bulkMoves(delivery, inRange);
  const reopened = delivery.filter((t) => t.history.some((s) => leavesDone(s) && inRange(s.at)));

  return {
    space: {
      id: space.id,
      key: space.key,
      name: space.name,
      siteUrl: space.siteUrl,
      lastCrawledAt: space.lastCrawledAt,
      crawlStatus: space.crawlStatus,
      crawlError: space.crawlError,
      board: space.board,
    },
    range: { from: range.from, to: range.to },
    repos: linked.map(({ repo }) => ({ id: repo.id, name: `${repo.owner}/${repo.name}` })),
    totals: {
      done: doneItems.length,
      inProgress: delivery.filter((t) => categoryAt(t, range.end) === "in_progress").length,
      created: delivery.filter((t) => inRange(t.item.createdAt)).length,
      epicsOpen: items.filter((i) => levelOf(i) === "epic" && i.statusCategory !== "done").length,
    },
    issueCycleTime: summarise(walked.map((t) => hoursBetween(t.startedAt, t.doneAt))),
    issueLeadTime: summarise(doneItems.map((t) => sinceCreated(t.item, t.doneAt!))),
    weekly: weeklyRows(range, delivery, doneItems),
    ageing: inProgressNow
      .map(({ item, startedAt }) => {
        const since = startedAt ?? item.createdAt;
        return { ...refOf(item), status: item.status, startedAt: since, ageHours: hoursBetween(since, options.now)! };
      })
      .sort((a, b) => b.ageHours - a.ageHours || byKey(a.key, b.key)),
    columns: columnTimes(space, walked),
    flowEfficiency: flowEfficiencyOf(walked),
    ideaToProduction: {
      toFirstPr: summarise(doneItems.map((t) => toFirstPr(t.item, prsOf.get(t.item.key)!))),
      toProduction: summarise(doneItems.map((t) => toProduction(t.item, prsOf.get(t.item.key)!))),
      linked: withPr.size,
      of: doneItems.length,
    },
    hygiene: [
      {
        check: "pr_without_key",
        count: withoutKey.length,
        of: mergedHuman.length,
        pullRequests: withoutKey.map(({ repo, pr }) => ({ repo, number: pr.number, title: pr.title, url: pr.url })),
      },
      itemFinding(
        "done_without_pr",
        doneItems.filter((t) => !withPr.has(t)),
        doneItems.length,
      ),
      itemFinding(
        "skipped_in_progress",
        doneItems.filter((t) => t.startedAt === null),
        doneItems.length,
      ),
      { ...itemFinding("bulk_move", bulk.items, null), batches: bulk.batches },
      itemFinding("reopened", reopened, null),
      itemFinding(
        "stale_in_progress",
        inProgressNow.filter((t) => range.now - instant(t.item.updatedAt) > STALE_MS),
        inProgressNow.length,
      ),
      itemFinding(
        "in_progress_unassigned",
        inProgressNow.filter((t) => t.item.assigneeId === null),
        inProgressNow.length,
      ),
    ],
  };
}
