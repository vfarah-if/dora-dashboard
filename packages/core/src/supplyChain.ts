/**
 * Supply chain facts read from a clone's files: how its workflows use actions and permissions, which security tools CI
 * runs, how its Dockerfiles are written, and which files that keep dependencies and secrets in order exist (ADR 0032).
 * Everything is pure: the caller supplies paths and contents, and nothing is run.
 *
 * Workflows are read line by line with indentation, as `enforcingLines` in `codeTooling.ts` is, with no YAML parser.
 * That is a heuristic: it recognises the forms people write, not every legal YAML spelling. Every loop is bounded,
 * because the text is untrusted. Lines are cut at 2,000 characters and a file is read to 20,000 lines. At most 500
 * workflows and 50 Dockerfiles are read, and the rest are reported as unread. At most 2,000 findings of each risk are
 * kept from one file and again across the repository, so advice can never crowd out a finding that is graded. At most
 * 10,000 action uses of each kind are kept the same way, pinned and unpinned counted apart, so pinned uses and GitHub's
 * own actions cannot crowd out an unpinned one. What the caps leave out is counted. A `run:` block is scanned once
 * however deeply its keys nest, a step is looked at within 200 rows, and nothing pushes a large array through a spread
 * argument, which would overflow the call stack. A joined line is cut at 8,000 characters.
 *
 * A composite action and a reusable workflow run with the event of the workflow that calls them, so each is reached
 * along routes: the triggers of every workflow in the repository that calls it by local path, directly or through
 * another such file, through the jobs whose `if:` conditions leave an outsider's event open. A step that a condition
 * provably keeps from an outsider's event is not reported, and a finding records the routes and conditions that did not
 * rule it out (ADR 0039). One called only from other repositories is read with its own triggers alone, which are none
 * for a composite action.
 */
import { baseName, commandsByFile, isActionPath, isTestPath, isWorkflowPath, type CandidateFile } from "./codeTooling.js";
import { isLockfile, isReadableLockfile } from "./lockfiles.js";
import {
  SUPPLY_CHAIN_VERSION,
  type ActionUse,
  type DockerfileFacts,
  type KeyFile,
  type LockfileSummary,
  type SecurityTool,
  type SecurityToolCategory,
  type SupplyChainFacts,
  type WorkflowFinding,
  type WorkflowRisk,
} from "./securityTypes.js";
import { BLOCK_SCALAR_VALUE, MAX_JOINED, MAX_LINE, MAX_LINES, rowsOf, structureOf, unquote, type Row } from "./workflowRows.js";
import {
  BASE_RUN_WORLD,
  HEAD_WORLDS,
  NO_REACH_HASH,
  PRIVILEGED_WORLDS,
  PULL_REQUEST_WORLDS,
  guardsOf,
  blankStrings,
  lineHashOf,
  reachOf,
  reasoner,
  type Guards,
  type ReachEntry,
  type Reason,
  type WorldSet,
} from "./workflowReach.js";
import { byPath, compareText, shallowestFirst } from "./stats.js";

export type { WorldTrigger } from "./workflowReach.js";

const MAX_WORKFLOWS = 500;
const MAX_DOCKERFILES = 50;
const MAX_SUPPORT_FILES = 100;
const MAX_ACTIONS = 10_000;
const MAX_FINDINGS = 2_000;
const MAX_LISTED = 200;
const MAX_EVIDENCE = 200;
const MAX_STEP_ROWS = 200;

// ---- candidates -----------------------------------------------------------------------------------------------------

const DOCKERFILE = /^(?:dockerfile(?:\..+)?|.+\.dockerfile|containerfile)$/i;
/** `Dockerfile.md` and `Dockerfile.dockerignore` sit beside a Dockerfile but are not one. */
const NOT_A_DOCKERFILE = /\.(?:md|dockerignore|txt|json|ya?ml|sh)$/i;
/** Whether a path names a Dockerfile, as the clone is read; the web uses it to say how a finding was found. */
export const isDockerfile = (path: string): boolean => {
  const name = baseName(path);
  return DOCKERFILE.test(name) && !NOT_A_DOCKERFILE.test(name) && !isTestPath(path);
};
const isSupportFile = (path: string) =>
  /^(?:makefile|GNUmakefile)$/i.test(baseName(path)) ||
  (baseName(path) === "package.json" && !path.split("/").includes("node_modules"));

/**
 * The files to read, each list shallowest first. `workflows` holds workflow files first and then composite actions,
 * at most 500 in all. `lockfiles` leaves out the kinds that cannot be read (pnpm and the like); `supplyChainFacts`
 * still reports them from `paths`. `tooling` holds the Makefiles and package.json files that a workflow's `make` and
 * `npm run` commands lead to, so a security tool run that way is found.
 */
export function supplyChainCandidates(paths: readonly string[]): {
  workflows: string[];
  lockfiles: string[];
  dockerfiles: string[];
  tooling: string[];
  /** The key files that will be listed, whose blob ids a caller may read from the commit's tree. Never to be opened. */
  keyFiles: string[];
} {
  const sorted = (found: string[]) => found.sort(shallowestFirst);
  return {
    workflows: [...sorted(paths.filter(isWorkflowPath)), ...sorted(paths.filter(isActionPath))].slice(0, MAX_WORKFLOWS),
    lockfiles: sorted(paths.filter(isReadableLockfile)),
    dockerfiles: sorted(paths.filter(isDockerfile)).slice(0, MAX_DOCKERFILES),
    tooling: sorted(paths.filter((path) => isSupportFile(path) && !isTestPath(path))).slice(0, MAX_SUPPORT_FILES),
    keyFiles: keyFiles(paths, null).map((file) => file.path),
  };
}

// ---- reading a workflow ---------------------------------------------------------------------------------------------

/** Whether a top-level `permissions:` exists, how many jobs are without their own, and the ids of those jobs. */
function permissionsOf(rows: readonly Row[]): { top: boolean; jobs: number; withoutOwn: number; ids: string[] } {
  const top = rows.some((row) => row.indent === 0 && !row.scalar && /^permissions\s*:/.test(row.text));
  const start = rows.findIndex((row) => row.indent === 0 && !row.scalar && /^jobs\s*:$/.test(row.text));
  if (start < 0) return { top, jobs: 0, withoutOwn: 0, ids: [] };
  let end = start + 1;
  while (end < rows.length && rows[end]!.indent > 0) end++;
  const children = rows.slice(start + 1, end);
  const base = children[0]?.indent ?? 0;
  const jobStarts = children.flatMap((row, i) => (row.indent === base && !row.dash && !row.scalar ? [i] : []));
  const ids: string[] = [];
  jobStarts.forEach((from, n) => {
    const body = children.slice(from + 1, jobStarts[n + 1] ?? children.length);
    const inner = body[0]?.indent ?? -1;
    if (!body.some((row) => row.indent === inner && !row.scalar && /^permissions\s*:/.test(row.text))) {
      ids.push(unquote(children[from]!.text.split(":")[0]!.trim()));
    }
  });
  return { top, jobs: jobStarts.length, withoutOwn: ids.length, ids };
}

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;

/** What a `uses:` value refers to: a local path, a docker image, or `owner/repo[/path]@ref`. */
function parseUses(value: string): Omit<ActionUse, "file" | "line"> {
  if (value.startsWith("./")) return { action: value, ref: null, pinned: true, kind: "local" };
  if (value.startsWith("docker://")) {
    const image = value.slice("docker://".length);
    const at = image.indexOf("@");
    if (at >= 0) {
      const ref = image.slice(at + 1);
      return { action: `docker://${image.slice(0, at)}`, ref, pinned: DIGEST.test(ref), kind: "docker" };
    }
    const colon = image.lastIndexOf(":");
    if (colon > image.lastIndexOf("/")) {
      return { action: `docker://${image.slice(0, colon)}`, ref: image.slice(colon + 1), pinned: false, kind: "docker" };
    }
    return { action: value, ref: null, pinned: false, kind: "docker" };
  }
  const at = value.indexOf("@");
  const action = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? null : value.slice(at + 1) || null;
  const owner = action.split("/")[0]!.toLowerCase();
  return {
    action,
    ref,
    pinned: ref !== null && SHA.test(ref),
    kind: owner === "actions" || owner === "github" ? "github" : "other",
  };
}

/** Text that an outsider controls, named in a `${{ }}` expression. */
const UNTRUSTED = new RegExp(
  "\\bgithub\\.(?:event\\.(?:" +
    [
      "issue\\.(?:title|body)",
      "pull_request\\.(?:title|body|head\\.(?:ref|label|repo\\.default_branch))",
      "comment\\.body",
      "review\\.body",
      "review_comment\\.body",
      "discussion\\.(?:title|body)",
      "pages(?:\\.\\*|\\.\\w+|\\[[^\\]\\s]{0,20}\\])\\.page_name",
      "commits(?:\\.\\*|\\.\\w+|\\[[^\\]\\s]{0,20}\\])\\.(?:message|author\\.(?:email|name))",
      "head_commit\\.(?:message|author\\.(?:email|name))",
      "workflow_run\\.(?:head_branch|head_commit\\.(?:message|author\\.(?:email|name))|display_title)",
    ].join("|") +
    ")|head_ref)\\b",
  "i",
);

const UNTRUSTED_EVERYWHERE = new RegExp(UNTRUSTED.source, "gi");

/**
 * The worlds an untrusted reference reaches. When the upstream run was not headed by a fork, such as one that a
 * `pull_request_target` or a comment started, the run's branch and head commit are the base repository's, so that world
 * is left out for them, while the run's title still comes from the outsider (ADR 0039).
 */
const untrustedWorlds = (reference: string): WorldSet =>
  /workflow_run\.(?:head_branch|head_commit)/i.test(reference) ? PRIVILEGED_WORLDS & ~BASE_RUN_WORLD : PRIVILEGED_WORLDS;

/**
 * What a checkout of a pull request's own code looks like: its head commit or branch, its merge commit, a workflow
 * run's head, or a `pull/N/head` or `pull/N/merge` ref, with or without `refs/`. A URL such as `.../pull/12/head` does
 * not count, because the ref must not follow a slash.
 */
const HEAD_REFERENCE = new RegExp(
  [
    "github\\.event\\.pull_request\\.(?:head\\.(?:sha|ref)|merge_commit_sha)",
    "github\\.head_ref",
    "github\\.event\\.workflow_run\\.(?:head_(?:sha|branch)|pull_requests)",
    "refs\\/pull\\/",
    "(?<![\\w/-])pull\\/(?:\\d+|\\$\\{\\{[^}]{0,100}\\}\\})\\/(?:head|merge)\\b",
  ].join("|"),
  "i",
);
/** A `repository:` value that names the pull request's fork, which a checkout then reads from. */
const HEAD_REPOSITORY =
  /github\.event\.(?:pull_request\.head\.repo|workflow_run\.head_repository)\.(?:full_name|name|clone_url)/i;
/**
 * The worlds a head reference reaches. A workflow run's `head_sha` and `head_branch` are the base repository's when the
 * upstream run was not headed by a fork, so that world is left out for them; its `pull_requests`, its head repository and
 * every other reference reach every head world.
 */
const headWorldsOf = (reference: string): WorldSet =>
  /workflow_run\.head_(?:sha|branch)$/i.test(reference) ? HEAD_WORLDS & ~BASE_RUN_WORLD : HEAD_WORLDS;
const HEAD_REFERENCE_EVERYWHERE = new RegExp(HEAD_REFERENCE.source, "gi");

/** The worlds that every head reference in the text reaches together, or 0 when it holds none. */
function headWorldsIn(text: string, pattern: RegExp): WorldSet {
  let set = 0;
  for (const match of text.matchAll(pattern)) set |= headWorldsOf(match[0]);
  return set;
}
const CHECKOUT_COMMAND = /\b(?:git\s+(?:checkout|fetch)|gh\s+pr\s+checkout)\b/;

/** Whether an expression can only produce true or false, so none of the event's text reaches the script. */
function isBoolean(bare: string): boolean {
  let depth = 0;
  let firstClose = -1;
  let comparison = false;
  for (let i = 0; i < bare.length; i++) {
    const char = bare[i]!;
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0 && firstClose < 0) firstClose = i;
    } else if (depth === 0) {
      const two = bare.slice(i, i + 2);
      // `a && b` and `a || b` return one of their operands, so the text can still come through.
      if (two === "&&" || two === "||") return false;
      if (two === "==" || two === "!=" || char === "<" || char === ">") comparison = true;
    }
  }
  if (comparison || /^!(?!=)/.test(bare)) return true;
  return /^(?:contains|startsWith|endsWith)\s*\(/.test(bare) && firstClose === bare.length - 1;
}

/** Interpreter flags that run code given on the command line, or a module, rather than the downloaded script. */
const PYTHON_OWN_CODE = /(?:^|\s)-[A-Za-z]*[cm]/;
const NODE_OWN_CODE = /(?:^|\s)(?:-[pe]{1,2}|--eval|--print)(?=\s|$|=)/;

/**
 * `curl` or `wget` piped into an interpreter that runs what it receives, or run through process substitution. Null when
 * there is none. `| python3 -c ...`, `| node -p ...` and `| jq` do not run the download, so they are not reported.
 */
function curlPipeShell(line: string): string | null {
  const piped =
    /\b(curl|wget)\b[^|\n]{0,300}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(sh|bash|zsh|python[\d.]*|node)(?![\w-])([^|;&\n]{0,200})/g;
  for (const match of line.matchAll(piped)) {
    const [, fetcher, interpreter, args] = match as unknown as [string, string, string, string];
    if (interpreter.startsWith("python") && PYTHON_OWN_CODE.test(args)) continue;
    if (interpreter === "node" && NODE_OWN_CODE.test(args)) continue;
    return `${fetcher} | ${interpreter}`;
  }
  const substituted = /\b(sh|bash|zsh)\s+(?:<\(|-c\s+["']?\$\()\s*(curl|wget)\b/.exec(line);
  return substituted ? `${substituted[2]} | ${substituted[1]}` : null;
}

interface TextLine {
  no: number;
  text: string;
}

/**
 * Joins a line that ends in a backslash, or in a pipe when `pipes` is set, to the line after it, as a shell and a
 * Dockerfile do, so `curl URL \` followed by `| bash` reads as one command. The result keeps the number of the first
 * line and is cut at `MAX_JOINED` characters.
 */
function joinContinuations(lines: readonly TextLine[], pipes: boolean): TextLine[] {
  const joined: TextLine[] = [];
  let current: TextLine | null = null;
  for (const { no, text } of lines) {
    const slash = text.endsWith("\\");
    const continues = slash || (pipes && /(?:^|[^|])\|$/.test(text));
    const piece = slash ? text.slice(0, -1).trimEnd() : text;
    if (current === null) current = { no, text: piece };
    else if (current.text.length < MAX_JOINED) current.text = `${current.text} ${piece}`.slice(0, MAX_JOINED);
    if (!continues) {
      joined.push(current);
      current = null;
    }
  }
  if (current !== null) joined.push(current);
  return joined;
}

const clip = (text: string) => text.slice(0, MAX_EVIDENCE);

/** A list that keeps at most `limit` items of each group, so one group cannot crowd out another, and counts the rest. */
function capped<T>(limit: number, groupOf: (item: T) => string): { items: T[]; add: (item: T) => void; dropped: () => number } {
  const items: T[] = [];
  const counts = new Map<string, number>();
  let dropped = 0;
  return {
    items,
    add: (item) => {
      const group = groupOf(item);
      const count = counts.get(group) ?? 0;
      if (count < limit) {
        items.push(item);
        counts.set(group, count + 1);
      } else dropped++;
    },
    dropped: () => dropped,
  };
}

const findingGroup = (finding: WorkflowFinding) => finding.risk;
const actionGroup = (use: ActionUse) => `${use.kind}|${use.pinned}`;

// ---- security tools -------------------------------------------------------------------------------------------------

const TOOL_ACTIONS: [string, string, SecurityToolCategory][] = [
  ["github/codeql-action", "codeql", "sast"],
  ["actions/dependency-review-action", "dependency-review", "dependency_review"],
  ["ossf/scorecard-action", "scorecard", "scorecard"],
  ["aquasecurity/trivy-action", "trivy", "container_scan"],
  ["anchore/scan-action", "anchore", "container_scan"],
  ["gitleaks/gitleaks-action", "gitleaks", "secret_scan"],
  ["trufflesecurity/trufflehog", "trufflehog", "secret_scan"],
  ["returntocorp/semgrep-action", "semgrep", "sast"],
  ["semgrep/semgrep-action", "semgrep", "sast"],
  ["snyk/actions", "snyk", "audit"],
  ["bridgecrewio/checkov-action", "checkov", "iac_scan"],
  ["aquasecurity/tfsec-action", "tfsec", "iac_scan"],
  ["google/osv-scanner-action", "osv-scanner", "audit"],
];

function toolOfAction(action: string): { tool: string; category: SecurityToolCategory } | null {
  const lower = action.toLowerCase();
  const match = TOOL_ACTIONS.find(([prefix]) => lower === prefix || lower.startsWith(`${prefix}/`));
  return match ? { tool: match[1], category: match[2] } : null;
}

/** A command may sit behind `sudo`, `npx`, `poetry run` and the like. */
const RUNNER = "(?:(?:sudo|npx|uvx|poetry\\s+run|pipenv\\s+run|bundle\\s+exec|python3?\\s+-m|time|exec)\\s+)*";
const COMMAND_TOOLS: [RegExp, string, SecurityToolCategory][] = (
  [
    ["npm\\s+audit", "npm audit", "audit"],
    ["yarn\\s+(?:npm\\s+)?audit", "yarn audit", "audit"],
    ["pnpm\\s+audit", "pnpm audit", "audit"],
    ["pip[-_]audit", "pip-audit", "audit"],
    ["safety\\s+(?:check|scan)", "safety", "audit"],
    ["cargo\\s+audit", "cargo audit", "audit"],
    ["(?:bundle\\s+audit|bundler-audit)", "bundler-audit", "audit"],
    ["osv-scanner", "osv-scanner", "audit"],
    ["govulncheck", "govulncheck", "audit"],
    ["trivy", "trivy", "container_scan"],
    ["grype", "grype", "container_scan"],
    ["hadolint", "hadolint", "container_scan"],
    ["semgrep", "semgrep", "sast"],
    ["gitleaks", "gitleaks", "secret_scan"],
    ["trufflehog", "trufflehog", "secret_scan"],
    ["checkov", "checkov", "iac_scan"],
    ["tfsec", "tfsec", "iac_scan"],
  ] as [string, string, SecurityToolCategory][]
).map(([body, tool, category]) => [new RegExp(`^${RUNNER}${body}\\b`), tool, category]);

// ---- one workflow ---------------------------------------------------------------------------------------------------

interface WorkflowReading {
  actions: ActionUse[];
  findings: WorkflowFinding[];
  tools: SecurityTool[];
  findingsDropped: number;
  actionsDropped: number;
}

/**
 * The lines a `run:` key holds: its own value and every deeper line after it, which covers `|` and `>` blocks, with
 * continuation lines joined and full-line comments in a block left out. `next` is the index of the first row after the
 * block, so the caller can skip any `run:` key nested inside it instead of scanning the same rows again.
 */
function runLines(rows: readonly Row[], k: number): { lines: TextLine[]; next: number } {
  const row = rows[k]!;
  const lines: TextLine[] = [];
  const value = row.body.replace(/^run\s*:\s*/, "");
  if (value && !BLOCK_SCALAR_VALUE.test(value.replace(/\s#.*$/, ""))) lines.push({ no: row.no, text: value });
  let next = k + 1;
  for (; next < rows.length && rows[next]!.indent > row.keyIndent; next++) {
    const inner = rows[next]!;
    if (inner.scalar && inner.body.startsWith("#")) continue;
    lines.push({ no: inner.no, text: inner.body });
  }
  return { lines: joinContinuations(lines, true), next };
}

const PERSIST_FALSE = /^persist-credentials\s*:\s*["']?false\b/i;

/**
 * Whether the step holding the `uses:` row at `k` says `persist-credentials: false`, given which rows say it. A step is
 * read within 200 rows.
 */
function persistsCredentials(rows: readonly Row[], k: number, saysFalse: readonly boolean[]): boolean {
  const row = rows[k]!;
  const keyIndent = row.keyIndent;
  let from = k;
  if (!row.dash) {
    for (let j = k - 1; j >= 0 && j >= k - MAX_STEP_ROWS; j--) {
      const earlier = rows[j]!;
      if (earlier.keyIndent === keyIndent && earlier.dash) {
        from = j;
        break;
      }
      if (earlier.indent < keyIndent) break;
      from = j;
    }
  }
  let to = k + 1;
  while (to < rows.length && to <= k + MAX_STEP_ROWS && rows[to]!.indent >= keyIndent) to++;
  for (let j = from; j < to; j++) if (saysFalse[j]) return false;
  return true;
}

/** `self-hosted` as a whole runner label, not part of a longer word such as `my-self-hosted-linux`. */
const SELF_HOSTED_LABEL = /(?:^|[[,\s"'])self-hosted(?=$|[\],\s"'])/i;

/** The text of a `runs-on` value: the rest of its line and the rows deeper than the key, as a block list or map has. */
function runsOnValue(rows: readonly Row[], k: number, inline: string): string[] {
  const key = rows[k]!;
  const parts = [inline];
  for (let j = k + 1; j < rows.length && j <= k + 10; j++) {
    const next = rows[j]!;
    // A block list may sit at the key's own indent, but only when the key has no value of its own.
    const listed = !inline && next.dash && next.indent === key.keyIndent;
    if (next.indent <= key.keyIndent && !listed) break;
    parts.push(next.text);
  }
  return parts;
}

/**
 * What a finding records about how an event reaches it. `routesDropped` and `conditionsDropped` are written only when
 * above zero, so a stored finding stays small.
 */
const reasonFields = (reason: Reason): Partial<WorkflowFinding> => ({
  routes: reason.routes,
  ...(reason.routesDropped > 0 && { routesDropped: reason.routesDropped }),
  conditions: reason.conditions,
  ...(reason.conditionsDropped > 0 && { conditionsDropped: reason.conditionsDropped }),
  reachHash: reason.reachHash,
});

function readWorkflow(
  file: CandidateFile,
  rows: readonly Row[],
  entries: readonly ReachEntry[],
  commands: readonly string[],
): WorkflowReading {
  const isAction = isActionPath(file.path);
  // The cheap gate: whether any route brings a world of the kind a check asks about. Which of them a line's own
  // conditions leave open is asked only for a line that matches, through `reasonAt`. See ADR 0039.
  const reached = entries.reduce((set, entry) => set | entry.worlds, 0);
  const privileged = (reached & PRIVILEGED_WORLDS) !== 0;
  const headTrigger = (reached & HEAD_WORLDS) !== 0;
  const onPullRequest = (reached & PULL_REQUEST_WORLDS) !== 0;
  let guards: Guards | undefined;
  const reasonFor = reasoner(entries);
  /** Null when the step and job holding row `k` rule every world of `mask` out, which is when nothing is reported. */
  const reasonAt = (k: number, mask: WorldSet): Reason | null =>
    reasonFor((guards ??= guardsOf(file.path, rows, structureOf(rows))).at(k), mask);

  const actions = capped(MAX_ACTIONS, actionGroup);
  const findings = capped(MAX_FINDINGS, findingGroup);
  const tools: SecurityTool[] = [];
  /**
   * `source` is the text of the flagged line, hashed whole, whitespace collapsed. A finding with no reason, which reads no
   * route and no condition, gets the reach hash of no reach.
   */
  const found = (
    risk: WorkflowRisk,
    line: number | null,
    evidence: string,
    source: string,
    extra: Partial<WorkflowFinding> = {},
  ) => {
    findings.add({
      file: file.path,
      line,
      risk,
      evidence: clip(evidence),
      reachHash: NO_REACH_HASH,
      ...extra,
      lineHash: lineHashOf(source),
    });
  };
  const addTool = (tool: string, category: SecurityToolCategory) => {
    if (!tools.some((t) => t.tool === tool)) tools.push({ tool, category, file: file.path });
  };

  // The end of the `run:` block last scanned. A `run:` key nested inside it was already read with it.
  let scannedTo = 0;
  // Which rows say `persist-credentials: false`, read at the first checkout, so many checkouts read each row once.
  let saysFalse: boolean[] | undefined;
  rows.forEach((row, k) => {
    if (/ACTIONS_ALLOW_UNSECURE_COMMANDS\s*[:=]\s*["']?true\b/i.test(row.text)) {
      found("unsecureCommands", row.no, "ACTIONS_ALLOW_UNSECURE_COMMANDS", row.text);
    }
    if (row.scalar) return;

    const uses = /^uses\s*:\s*(.+)$/.exec(row.text);
    if (uses) {
      const parsed = parseUses(unquote(uses[1]!.trim()));
      actions.add({ file: file.path, line: row.no, ...parsed });
      const tool = toolOfAction(parsed.action);
      if (tool) addTool(tool.tool, tool.category);
      if (
        privileged &&
        parsed.action.toLowerCase() === "actions/checkout" &&
        persistsCredentials(rows, k, (saysFalse ??= rows.map((r) => PERSIST_FALSE.test(r.text))))
      ) {
        const reason = reasonAt(k, PRIVILEGED_WORLDS);
        if (reason) {
          found(
            "persistCredentials",
            row.no,
            `${parsed.action}${parsed.ref ? `@${parsed.ref}` : ""}`,
            row.text,
            reasonFields(reason),
          );
        }
      }
      return;
    }

    if (/^run\s*:/.test(row.text)) {
      if (k < scannedTo) return;
      const block = runLines(rows, k);
      scannedTo = block.next;
      for (const { no, text } of block.lines) {
        if (privileged) {
          for (const expression of text.matchAll(/\$\{\{(.{0,500}?)\}\}/g)) {
            // Strings are blanked so a name inside quotes is not read as a reference to the event, and so a literal,
            // which may be a hardcoded token, is never stored as evidence.
            const bare = blankStrings(expression[1]!);
            let worlds = 0;
            if (!isBoolean(bare)) for (const match of bare.matchAll(UNTRUSTED_EVERYWHERE)) worlds |= untrustedWorlds(match[0]);
            if (worlds) {
              const reason = reasonAt(k, worlds);
              if (reason) found("scriptInjection", no, bare, text, reasonFields(reason));
            }
          }
        }
        if (headTrigger && CHECKOUT_COMMAND.test(text)) {
          const worlds = headWorldsIn(text, HEAD_REFERENCE_EVERYWHERE) | (/\bgh\s+pr\s+checkout\b/.test(text) ? HEAD_WORLDS : 0);
          const first = HEAD_REFERENCE.exec(text)?.[0];
          // A `pull/${{ }}/head` reference holds an expression, whose literals are never stored.
          const reference = first === undefined ? (worlds ? "gh pr checkout" : null) : blankStrings(first);
          const reason = reference ? reasonAt(k, worlds) : null;
          if (reference && reason) found("prHeadCheckout", no, reference, text, reasonFields(reason));
        }
        const piped = curlPipeShell(text);
        if (piped) found("curlPipeShell", no, piped, text);
      }
      return;
    }

    if (headTrigger) {
      const ref = /^(ref|repository)\s*:\s*(.+)$/.exec(row.text);
      const reference = ref ? (ref[1] === "ref" ? HEAD_REFERENCE : HEAD_REPOSITORY).exec(ref[2]!)?.[0] : undefined;
      const reason = reference
        ? reasonAt(k, ref![1] === "ref" ? headWorldsIn(ref![2]!, HEAD_REFERENCE_EVERYWHERE) : HEAD_WORLDS)
        : null;
      if (reference && reason) found("prHeadCheckout", row.no, blankStrings(reference), row.text, reasonFields(reason));
    }
    if (/^secrets\s*:\s*["']?inherit["']?$/.test(row.text)) found("secretsInherit", row.no, "secrets: inherit", row.text);
    if (!isAction && /^permissions\s*:\s*["']?write-all["']?$/.test(row.text))
      found("writeAll", row.no, "permissions: write-all", row.text);
    const runsOn = /^runs-on\s*:\s*(.*)$/.exec(row.text);
    if (runsOn && !isAction && runsOnValue(rows, k, runsOn[1]!).some((part) => SELF_HOSTED_LABEL.test(part))) {
      // Reported whatever the triggers, but a pull request counts only when a world of one reaches the job.
      const reason = onPullRequest ? reasonAt(k, PULL_REQUEST_WORLDS) : null;
      found("selfHosted", row.no, "self-hosted", row.text, {
        onPullRequest: reason !== null,
        ...(reason && reasonFields(reason)),
      });
    }
  });

  if (!isAction) {
    const { top, jobs, withoutOwn, ids } = permissionsOf(rows);
    // With no line to hash, the finding is identified by the jobs that set no permissions.
    if (!top && jobs > 0 && withoutOwn > 0) found("noPermissions", null, "permissions", ids.sort(compareText).join(","));
  }

  for (const command of commands) {
    const tool = COMMAND_TOOLS.find(([pattern]) => pattern.test(command));
    if (tool) addTool(tool[1], tool[2]);
  }
  return {
    actions: actions.items,
    findings: findings.items,
    tools,
    findingsDropped: findings.dropped(),
    actionsDropped: actions.dropped(),
  };
}

// ---- Dockerfiles ----------------------------------------------------------------------------------------------------

/** Whether a base image runs as a user other than root when the Dockerfile sets none. */
function defaultsToNonRoot(image: string): boolean {
  const lower = image.toLowerCase();
  if (lower.startsWith("cgr.dev/")) return true;
  const colon = lower.lastIndexOf(":");
  const tag = colon > lower.lastIndexOf("/") ? lower.slice(colon + 1) : "";
  // The distroless `:nonroot` and `:debug-nonroot` tags, and any `-nonroot` flavour of another image.
  return /(?:^|[-_.])nonroot(?:$|[-_.])/.test(tag);
}

function readDockerfile(file: CandidateFile, blobs: ReadonlyMap<string, string> | null): DockerfileFacts {
  const stages = new Map<string, { user: string | null; nonRootBase: boolean }>();
  let stage = { user: null as string | null, nonRootBase: false };
  let images = 0;
  let unpinnedImages = 0;
  let latestImages = 0;
  let sawFrom = false;
  let addsRemote = false;
  let piped = false;
  const lines: TextLine[] = [];
  file.content.split("\n", MAX_LINES).forEach((raw, i) => {
    const text = raw.slice(0, MAX_LINE).trim();
    if (text && !text.startsWith("#")) lines.push({ no: i + 1, text });
  });
  for (const { text: line } of joinContinuations(lines, false)) {
    if (curlPipeShell(line)) piped = true;
    const instruction = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!instruction) continue;
    const args = instruction[2]!;
    switch (instruction[1]!.toUpperCase()) {
      case "FROM": {
        sawFrom = true;
        const tokens = args.split(/\s+/).filter((token) => !token.startsWith("--"));
        const image = tokens[0] ?? "";
        const alias = tokens[1]?.toUpperCase() === "AS" ? tokens[2] : undefined;
        const parent = stages.get(image.toLowerCase());
        // A stage built on an earlier one starts with that stage's user.
        stage = parent ? { ...parent } : { user: null, nonRootBase: defaultsToNonRoot(image) };
        if (image && image.toLowerCase() !== "scratch" && !parent) {
          images++;
          if (!image.includes("@sha256:")) {
            unpinnedImages++;
            const colon = image.lastIndexOf(":");
            const tag = colon > image.lastIndexOf("/") ? image.slice(colon + 1) : null;
            if (!image.includes("$") && (tag === null || tag.toLowerCase() === "latest")) latestImages++;
          }
        }
        if (alias) stages.set(alias.toLowerCase(), stage);
        break;
      }
      case "USER":
        stage.user = args.split(/\s+/)[0]!;
        break;
      case "ADD":
        if (/^(?:--\S+\s+)*["']?https?:\/\//i.test(args)) addsRemote = true;
        break;
    }
  }
  const { user } = stage;
  const runsAsRoot = sawFrom && (user === null ? !stage.nonRootBase : ["root", "0"].includes(user.split(":")[0]!.toLowerCase()));
  return {
    path: file.path,
    blob: blobs?.get(file.path) ?? null,
    images,
    unpinnedImages,
    latestImages,
    runsAsRoot,
    addsRemote,
    curlPipeShell: piped,
  };
}

// ---- repository files -----------------------------------------------------------------------------------------------

const UPDATE_CONFIGS = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
];

const SECURITY_POLICY = /^(?:(\.github|docs)\/)?security(?:\.md|\.txt)?$/i;
const SECURITY_POLICY_PLACES = ["", ".github", "docs"];

function securityPolicy(paths: readonly string[]): string | null {
  const found = paths.filter((path) => SECURITY_POLICY.test(path));
  for (const place of SECURITY_POLICY_PLACES) {
    const match = found.find((path) => (SECURITY_POLICY.exec(path)?.[1] ?? "") === place);
    if (match) return match;
  }
  return null;
}

const STRONG_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const STRONG_KEY_EXTENSIONS = [".ppk", ".p12", ".pfx", ".jks", ".keystore"];
const WEAK_KEY_EXTENSIONS = [".pem", ".key"];
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/i;
/**
 * Files with a strong name that are routinely committed on purpose: environment files for tests, development and CI
 * (named exactly, so `.env.dev-something` stays strong), and the debug keystore every Android project carries. They are
 * listed as weak, for a person to look at, and never lower the grade.
 */
const COMMITTED_ON_PURPOSE = new Set([".env.test", ".env.development", ".env.dev", ".env.ci", "debug.keystore"]);
const FIXTURE_DIRECTORIES = new Set(["testdata", "fixtures", "__fixtures__"]);

/** Strong names first, then weak, each in path order and each cut at 200, so many weak files cannot push a strong one out. */
function keyFiles(paths: readonly string[], blobs: ReadonlyMap<string, string> | null): KeyFile[] {
  const strong: KeyFile[] = [];
  const weak: KeyFile[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    if (isTestPath(path) || segments.slice(0, -1).some((segment) => FIXTURE_DIRECTORIES.has(segment.toLowerCase()))) continue;
    const name = baseName(path).toLowerCase();
    let strength: KeyFile["strength"] | null = null;
    if (COMMITTED_ON_PURPOSE.has(name)) strength = "weak";
    else if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATE.test(name)) strength = "strong";
    else if (STRONG_KEY_NAMES.has(name) || STRONG_KEY_EXTENSIONS.some((extension) => name.endsWith(extension)))
      strength = "strong";
    else if (WEAK_KEY_EXTENSIONS.some((extension) => name.endsWith(extension))) strength = "weak";
    const blob = blobs?.get(path) ?? null;
    if (strength === "strong") strong.push({ path, blob, strength });
    else if (strength === "weak") weak.push({ path, blob, strength });
  }
  return [...strong.sort(byPath).slice(0, MAX_LISTED), ...weak.sort(byPath).slice(0, MAX_LISTED)];
}

// ---- ecosystems and lockfiles ---------------------------------------------------------------------------------------

/** The Dependabot name of the ecosystem a manifest file belongs to, from its base name. */
const MANIFEST_ECOSYSTEMS = new Map<string, string>([
  ["package.json", "npm"],
  ["Cargo.toml", "cargo"],
  ["Gemfile", "bundler"],
  ["pyproject.toml", "pip"],
  ["setup.py", "pip"],
  ["Pipfile", "pip"],
  ["go.mod", "gomod"],
  ["pom.xml", "maven"],
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["composer.json", "composer"],
  ["pubspec.yaml", "pub"],
  ["mix.exs", "mix"],
  ["Package.swift", "swift"],
]);

function manifestEcosystem(name: string): string | null {
  const known = MANIFEST_ECOSYSTEMS.get(name);
  if (known) return known;
  if (/^requirements[^/]*\.txt$/.test(name)) return "pip";
  if (name.endsWith(".csproj") || name.endsWith(".fsproj")) return "nuget";
  if (name.endsWith(".gemspec")) return "bundler";
  return null;
}

/** The ecosystems Dependabot can be set up for, in the order a generated configuration lists them. */
const ECOSYSTEM_ORDER = [
  "npm",
  "pip",
  "cargo",
  "bundler",
  "gomod",
  "maven",
  "gradle",
  "nuget",
  "composer",
  "docker",
  "github-actions",
  "terraform",
  "pub",
];

/** The lockfile names that satisfy a manifest, and the manifest names that need one. */
const LOCKFILE_RULES: { ecosystem: string; manifests: string[]; lockfiles: Set<string> }[] = [
  {
    ecosystem: "npm",
    manifests: ["package.json"],
    lockfiles: new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]),
  },
  { ecosystem: "cargo", manifests: ["Cargo.toml"], lockfiles: new Set(["Cargo.lock"]) },
  { ecosystem: "bundler", manifests: ["Gemfile"], lockfiles: new Set(["Gemfile.lock"]) },
];

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** True when the directory or any parent of it is in the set. */
function coveredByParent(directories: ReadonlySet<string>, directory: string): boolean {
  for (let dir = directory; ; dir = dirOf(dir)) {
    if (directories.has(dir)) return true;
    if (dir === "") return false;
  }
}

// ---- the facts ------------------------------------------------------------------------------------------------------

/**
 * What `supplyChainFacts` reads. `workflows` holds the workflow files and composite actions listed by
 * `supplyChainCandidates`, `lockfiles` the summaries from `readLockfile`, and `unread` the listed paths that could not
 * be read. `dockerfiles` holds the Dockerfile contents and `tooling` the Makefiles and package.json files that make
 * targets and package scripts in a workflow lead to; both are optional and default to none.
 */
export interface SupplyChainInput {
  /** The full listing. A workflow, composite action or Dockerfile in it that was not given is reported as unread. */
  paths: readonly string[];
  /**
   * False when the listing stopped short of the whole clone, such as at a limit on entries or depth, or because a
   * directory could not be read, so a file missing from `paths` may still exist.
   */
  listingComplete: boolean;
  workflows: readonly CandidateFile[];
  lockfiles: readonly LockfileSummary[];
  unread: readonly string[];
  dockerfiles?: readonly CandidateFile[];
  tooling?: readonly CandidateFile[];
  /**
   * Git blob ids by path, read from the commit's tree for the key files and Dockerfiles, which tell an acceptance whether
   * a file has changed (ADR 0040). A path without one gets a null blob and cannot be accepted. Null when the lookup
   * failed, which gives every path a null blob and the facts a false `blobsRead`. A caller with nothing to look up
   * passes an empty map.
   */
  blobs: ReadonlyMap<string, string> | null;
}

/** Every field of `SupplyChainFacts`, worked out from paths and the contents the caller read. Never reads a key file. */
export function supplyChainFacts(input: SupplyChainInput): SupplyChainFacts {
  const paths = input.paths;

  const readable = input.workflows.filter((file) => isWorkflowPath(file.path) || isActionPath(file.path)).sort(byPath);
  const files = readable.slice(0, MAX_WORKFLOWS);
  const commands = commandsByFile(files, input.tooling ?? []);
  const reach = reachOf(files);
  const actions = capped(MAX_ACTIONS, actionGroup);
  const findings = capped(MAX_FINDINGS, findingGroup);
  const securityTools: SecurityTool[] = [];
  let findingsDropped = 0;
  let actionsDropped = 0;
  // Each list is added to one item at a time: a spread argument of a large array overflows the call stack.
  for (const file of files) {
    const reading = readWorkflow(file, rowsOf(file.content), reach.get(file.path) ?? [], commands.get(file.path) ?? []);
    for (const use of reading.actions) actions.add(use);
    for (const finding of reading.findings) findings.add(finding);
    for (const tool of reading.tools) securityTools.push(tool);
    findingsDropped += reading.findingsDropped;
    actionsDropped += reading.actionsDropped;
  }

  const dockerfileFiles = (input.dockerfiles ?? [])
    .filter((file) => isDockerfile(file.path))
    .sort(byPath)
    .slice(0, MAX_DOCKERFILES);
  const dockerfiles = dockerfileFiles.map((file) => readDockerfile(file, input.blobs));

  // Whatever the listing holds that was not given is reported, so a count cap or a size cap never hides a file. A path
  // the caller passed as unread joins them, and goes with the Dockerfiles when that is what it is.
  const isWorkflowFile = (path: string) => isWorkflowPath(path) || isActionPath(path);
  const workflowsGiven = new Set(files.map((file) => file.path));
  const dockerfilesGiven = new Set(dockerfileFiles.map((file) => file.path));
  const workflowsUnread = new Set<string>();
  const dockerfilesUnread = new Set<string>();
  for (const path of input.unread) {
    if (!isWorkflowFile(path) && isDockerfile(path)) dockerfilesUnread.add(path);
    else workflowsUnread.add(path);
  }
  for (const file of readable.slice(MAX_WORKFLOWS)) workflowsUnread.add(file.path);
  for (const path of [...paths].sort(compareText)) {
    if (isWorkflowFile(path)) {
      if (!workflowsGiven.has(path)) workflowsUnread.add(path);
    } else if (isDockerfile(path) && !dockerfilesGiven.has(path)) dockerfilesUnread.add(path);
  }

  const configs = new Set(paths);

  // Manifests, the lockfiles that satisfy them, and the Dependabot ecosystems the repository needs.
  const counts = new Map<string, number>();
  const missing: string[] = [];
  const lockDirectories = new Map<string, Set<string>>(LOCKFILE_RULES.map((rule) => [rule.ecosystem, new Set<string>()]));
  const needed = new Set<string>();
  for (const path of paths) {
    if (isTestPath(path) || path.split("/").includes("node_modules")) continue;
    const name = baseName(path);
    const ecosystem = manifestEcosystem(name);
    if (ecosystem) {
      counts.set(ecosystem, (counts.get(ecosystem) ?? 0) + 1);
      needed.add(ecosystem);
    }
    if (isDockerfile(path)) needed.add("docker");
    if (isWorkflowPath(path) || isActionPath(path)) needed.add("github-actions");
    if (name.endsWith(".tf")) needed.add("terraform");
    for (const rule of LOCKFILE_RULES) if (rule.lockfiles.has(name)) lockDirectories.get(rule.ecosystem)!.add(dirOf(path));
  }
  // A listing that stopped short may have left out the lockfile that covers a manifest, so it reports none missing.
  for (const path of input.listingComplete ? paths : []) {
    if (isTestPath(path) || path.split("/").includes("node_modules")) continue;
    const rule = LOCKFILE_RULES.find((r) => r.manifests.includes(baseName(path)));
    if (rule && !coveredByParent(lockDirectories.get(rule.ecosystem)!, dirOf(path))) missing.push(path);
  }

  // A lockfile that is never read still exists, so report it as one instead of leaving it out.
  const summaries = new Map<string, LockfileSummary>(input.lockfiles.map((summary) => [summary.path, summary]));
  for (const path of paths) {
    if (isLockfile(path) && !isReadableLockfile(path) && !summaries.has(path)) {
      summaries.set(path, { path, read: "not_supported", packages: 0, publicPackages: 0, capped: false });
    }
  }

  return {
    version: SUPPLY_CHAIN_VERSION,
    workflowsRead: files.filter((file) => isWorkflowPath(file.path)).length,
    workflowsUnread: [...workflowsUnread].slice(0, MAX_WORKFLOWS),
    dockerfilesUnread: [...dockerfilesUnread].slice(0, MAX_LISTED),
    dockerfilesUnreadTotal: dockerfilesUnread.size,
    actions: actions.items,
    findings: findings.items,
    findingsDropped: findingsDropped + findings.dropped(),
    actionsDropped: actionsDropped + actions.dropped(),
    securityTools,
    updateConfig: UPDATE_CONFIGS.find((path) => configs.has(path)) ?? null,
    securityPolicy: securityPolicy(paths),
    manifestsByEcosystem: Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b))),
    missingLockfiles: missing.sort().slice(0, MAX_LISTED),
    lockfiles: [...summaries.values()].sort(byPath),
    keyFiles: keyFiles(paths, input.blobs),
    dockerfiles,
    ecosystems: ECOSYSTEM_ORDER.filter((ecosystem) => needed.has(ecosystem)),
    listingComplete: input.listingComplete,
    blobsRead: input.blobs !== null,
  };
}
