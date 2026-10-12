/**
 * Supply chain facts read from a clone's files: how its workflows use actions and permissions, which security tools CI
 * runs, how its Dockerfiles are written, and which files that keep dependencies and secrets in order exist (ADR 0032).
 * Everything is pure: the caller supplies paths and contents, and nothing is run.
 *
 * Workflows are read line by line with indentation, as `enforcingLines` in `codeTooling.ts` is, with no YAML parser.
 * That is a heuristic: it recognises the forms people write, not every legal YAML spelling. Every loop is bounded,
 * because the text is untrusted. Lines are cut at 2,000 characters and a file is read to 20,000 lines. At most 500
 * workflows and 50 Dockerfiles are read, and the rest are reported as unread. A file yields at most 2,000 findings and 10,000 actions, a `run:` block is
 * scanned once however deeply its keys nest, a step is looked at within 200 rows, and nothing pushes a large array
 * through a spread argument, which would overflow the call stack. A joined line is cut at 8,000 characters.
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
import { byPath, compareText, shallowestFirst } from "./stats.js";

const MAX_LINE = 2_000;
const MAX_LINES = 20_000;
const MAX_WORKFLOWS = 500;
const MAX_DOCKERFILES = 50;
const MAX_SUPPORT_FILES = 100;
const MAX_ACTIONS = 10_000;
const MAX_FINDINGS = 2_000;
const MAX_LISTED = 200;
const MAX_EVIDENCE = 200;
const MAX_JOINED = 8_000;
const MAX_STEP_ROWS = 200;
const MAX_FLOW_ROWS = 200;

// ---- candidates -----------------------------------------------------------------------------------------------------

const DOCKERFILE = /^(?:dockerfile(?:\..+)?|.+\.dockerfile|containerfile)$/i;
/** `Dockerfile.md` and `Dockerfile.dockerignore` sit beside a Dockerfile but are not one. */
const NOT_A_DOCKERFILE = /\.(?:md|dockerignore|txt|json|ya?ml|sh)$/i;
const isDockerfile = (path: string) => {
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
} {
  const sorted = (found: string[]) => found.sort(shallowestFirst);
  return {
    workflows: [...sorted(paths.filter(isWorkflowPath)), ...sorted(paths.filter(isActionPath))].slice(0, MAX_WORKFLOWS),
    lockfiles: sorted(paths.filter(isReadableLockfile)),
    dockerfiles: sorted(paths.filter(isDockerfile)).slice(0, MAX_DOCKERFILES),
    tooling: sorted(paths.filter((path) => isSupportFile(path) && !isTestPath(path))).slice(0, MAX_SUPPORT_FILES),
  };
}

// ---- reading a workflow ---------------------------------------------------------------------------------------------

/** One meaningful line of a workflow, with its place in the indentation. */
interface Row {
  no: number;
  indent: number;
  /** Where the key starts, after any `- ` markers. */
  keyIndent: number;
  dash: boolean;
  /** The line after `- ` markers, comment kept. */
  body: string;
  /** `body` without a trailing comment. */
  text: string;
  /** Inside a block scalar such as `run: |`. */
  scalar: boolean;
}

const BLOCK_SCALAR_KEY = /^["']?[\w.-]+["']?\s*:\s*[|>][-+0-9]*$/;
const BLOCK_SCALAR_VALUE = /^[|>][-+0-9]*$/;

const unquote = (value: string): string => {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote) ? value.slice(1, -1) : value;
};

/**
 * Splits a workflow into rows. Blank and comment lines are dropped, except inside a block scalar, where a `#` line is
 * script text. The lines of a block scalar are kept and marked, so `uses:` written in a script is not read as a step.
 */
function rowsOf(content: string): Row[] {
  const rows: Row[] = [];
  let scalarKeyIndent = -1;
  content.split("\n", MAX_LINES).forEach((raw, i) => {
    const line = raw.slice(0, MAX_LINE).trimEnd();
    const trimmed = line.trimStart();
    if (!trimmed) return;
    const indent = line.length - trimmed.length;
    if (scalarKeyIndent >= 0) {
      if (indent > scalarKeyIndent) {
        rows.push({ no: i + 1, indent, keyIndent: indent, dash: false, body: trimmed, text: trimmed, scalar: true });
        return;
      }
      scalarKeyIndent = -1;
    }
    if (trimmed.startsWith("#")) return;
    const dashes = /^(?:-(?:\s+|$))+/.exec(trimmed)?.[0].length ?? 0;
    const body = trimmed.slice(dashes);
    const text = body.replace(/(^|\s)#.*$/, "").trimEnd();
    const keyIndent = indent + dashes;
    if (BLOCK_SCALAR_KEY.test(text)) scalarKeyIndent = keyIndent;
    rows.push({ no: i + 1, indent, keyIndent, dash: dashes > 0, body, text, scalar: false });
  });
  return rows;
}

const PRIVILEGED = new Set([
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
]);
const ON_KEY = /^(?:on|"on"|'on'|true)\s*:\s*(.*)$/;

/**
 * The names at the top level of a flow list or map such as `[push, pull_request]` or `{ push: { branches: [issues] } }`,
 * where only `push` is an event. Null when the brackets never close, so the names cannot be known.
 */
function flowNames(text: string): string[] | null {
  let depth = 0;
  let entry = "";
  let inKey = true;
  const names: string[] = [];
  const end = () => {
    const name = unquote(entry.trim());
    if (name) names.push(name);
    entry = "";
    inKey = true;
  };
  for (const char of text) {
    if (char === "[" || char === "{") {
      depth++;
      continue;
    }
    if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        end();
        return names;
      }
      continue;
    }
    if (depth !== 1) continue;
    if (char === ",") end();
    else if (char === ":") inKey = false;
    else if (inKey) entry += char;
  }
  return null;
}

/**
 * The events a workflow runs on, from `on: x`, a flow list or map (on one line or several), a block list or a block
 * map. Null when they cannot be known, which is a flow value whose brackets never close. A caller treats null as
 * possibly privileged, because a parser that cannot read the trigger must not hide a finding behind it. That costs
 * nothing in practice: GitHub rejects a workflow with an unclosed bracket, so a false finding can only land on a
 * file that never runs, and a legal spelling this reader failed to follow is still checked rather than skipped.
 */
function triggersOf(rows: readonly Row[]): Set<string> | null {
  const found = new Set<string>();
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]!;
    const key = row.indent === 0 && !row.scalar && !row.dash ? ON_KEY.exec(row.text) : null;
    if (!key) continue;
    const value = key[1]!.trim();
    if (value) {
      if (!/^[[{]/.test(value)) {
        found.add(unquote(value));
        return found;
      }
      let text = value;
      for (let j = k + 1; j < rows.length && j <= k + MAX_FLOW_ROWS && flowNames(text) === null; j++) {
        text = `${text} ${rows[j]!.text}`.slice(0, MAX_JOINED);
      }
      const names = flowNames(text);
      if (names === null) return null;
      for (const name of names) found.add(name);
      return found;
    }
    let base = -1;
    for (let j = k + 1; j < rows.length && (rows[j]!.indent > 0 || rows[j]!.dash); j++) {
      const child = rows[j]!;
      if (child.scalar) continue;
      if (base < 0) base = child.indent;
      if (child.indent === base) found.add(unquote((child.dash ? child.text : child.text.split(":")[0]!).trim()));
    }
    return found;
  }
  return found;
}

/** Whether a top-level `permissions:` exists, and how many jobs are without their own. */
function permissionsOf(rows: readonly Row[]): { top: boolean; jobs: number; withoutOwn: number } {
  const top = rows.some((row) => row.indent === 0 && !row.scalar && /^permissions\s*:/.test(row.text));
  const start = rows.findIndex((row) => row.indent === 0 && !row.scalar && /^jobs\s*:$/.test(row.text));
  if (start < 0) return { top, jobs: 0, withoutOwn: 0 };
  let end = start + 1;
  while (end < rows.length && rows[end]!.indent > 0) end++;
  const children = rows.slice(start + 1, end);
  const base = children[0]?.indent ?? 0;
  const jobStarts = children.flatMap((row, i) => (row.indent === base && !row.dash && !row.scalar ? [i] : []));
  let withoutOwn = 0;
  jobStarts.forEach((from, n) => {
    const body = children.slice(from + 1, jobStarts[n + 1] ?? children.length);
    const inner = body[0]?.indent ?? -1;
    if (!body.some((row) => row.indent === inner && !row.scalar && /^permissions\s*:/.test(row.text))) withoutOwn++;
  });
  return { top, jobs: jobStarts.length, withoutOwn };
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

/** Whether the step holding the `uses:` row at `k` says `persist-credentials: false`. A step is read within 200 rows. */
function persistsCredentials(rows: readonly Row[], k: number): boolean {
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
  for (let j = from; j < to; j++) if (/^persist-credentials\s*:\s*["']?false\b/i.test(rows[j]!.text)) return false;
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

function readWorkflow(file: CandidateFile, commands: readonly string[]): WorkflowReading {
  const isAction = isActionPath(file.path);
  const rows = rowsOf(file.content);
  const triggers = isAction ? new Set<string>() : triggersOf(rows);
  // Triggers that cannot be read count as privileged, so nothing is hidden; see `triggersOf`.
  const privileged = triggers === null || [...triggers].some((trigger) => PRIVILEGED.has(trigger));
  const headTrigger = triggers === null || triggers.has("pull_request_target") || triggers.has("workflow_run");
  const onPullRequest = triggers === null || triggers.has("pull_request") || triggers.has("pull_request_target");

  const actions: ActionUse[] = [];
  const findings: WorkflowFinding[] = [];
  const tools: SecurityTool[] = [];
  const found = (risk: WorkflowRisk, line: number | null, evidence: string, extra: Partial<WorkflowFinding> = {}) => {
    if (findings.length < MAX_FINDINGS) findings.push({ file: file.path, line, risk, evidence: clip(evidence), ...extra });
  };
  const addTool = (tool: string, category: SecurityToolCategory) => {
    if (!tools.some((t) => t.tool === tool)) tools.push({ tool, category, file: file.path });
  };

  // The end of the `run:` block last scanned. A `run:` key nested inside it was already read with it.
  let scannedTo = 0;
  rows.forEach((row, k) => {
    if (/ACTIONS_ALLOW_UNSECURE_COMMANDS\s*[:=]\s*["']?true\b/i.test(row.text)) {
      found("unsecureCommands", row.no, "ACTIONS_ALLOW_UNSECURE_COMMANDS");
    }
    if (row.scalar) return;

    const uses = /^uses\s*:\s*(.+)$/.exec(row.text);
    if (uses) {
      const parsed = parseUses(unquote(uses[1]!.trim()));
      if (actions.length < MAX_ACTIONS) actions.push({ file: file.path, line: row.no, ...parsed });
      const tool = toolOfAction(parsed.action);
      if (tool) addTool(tool.tool, tool.category);
      if (privileged && !isAction && parsed.action.toLowerCase() === "actions/checkout" && persistsCredentials(rows, k)) {
        found("persistCredentials", row.no, `${parsed.action}${parsed.ref ? `@${parsed.ref}` : ""}`);
      }
      return;
    }

    if (/^run\s*:/.test(row.text)) {
      if (k < scannedTo) return;
      const block = runLines(rows, k);
      scannedTo = block.next;
      for (const { no, text } of block.lines) {
        if (privileged && !isAction) {
          for (const expression of text.matchAll(/\$\{\{(.{0,500}?)\}\}/g)) {
            const inner = expression[1]!.trim();
            // Strings are blanked so a name inside quotes is not read as a reference to the event.
            const bare = inner.replace(/'[^']*'|"[^"]*"/g, "''");
            if (UNTRUSTED.test(bare) && !isBoolean(bare)) found("scriptInjection", no, inner);
          }
        }
        if (headTrigger && CHECKOUT_COMMAND.test(text)) {
          const reference = HEAD_REFERENCE.exec(text)?.[0] ?? (/\bgh\s+pr\s+checkout\b/.test(text) ? "gh pr checkout" : null);
          if (reference) found("prHeadCheckout", no, reference);
        }
        const piped = curlPipeShell(text);
        if (piped) found("curlPipeShell", no, piped);
      }
      return;
    }

    if (headTrigger) {
      const ref = /^(ref|repository)\s*:\s*(.+)$/.exec(row.text);
      const reference = ref ? (ref[1] === "ref" ? HEAD_REFERENCE : HEAD_REPOSITORY).exec(ref[2]!)?.[0] : undefined;
      if (reference) found("prHeadCheckout", row.no, reference);
    }
    if (/^secrets\s*:\s*["']?inherit["']?$/.test(row.text)) found("secretsInherit", row.no, "secrets: inherit");
    if (!isAction && /^permissions\s*:\s*["']?write-all["']?$/.test(row.text))
      found("writeAll", row.no, "permissions: write-all");
    const runsOn = /^runs-on\s*:\s*(.*)$/.exec(row.text);
    if (runsOn && !isAction && runsOnValue(rows, k, runsOn[1]!).some((part) => SELF_HOSTED_LABEL.test(part))) {
      found("selfHosted", row.no, "self-hosted", { onPullRequest });
    }
  });

  if (!isAction) {
    const { top, jobs, withoutOwn } = permissionsOf(rows);
    if (!top && jobs > 0 && withoutOwn > 0) found("noPermissions", null, "permissions");
  }

  for (const command of commands) {
    const tool = COMMAND_TOOLS.find(([pattern]) => pattern.test(command));
    if (tool) addTool(tool[1], tool[2]);
  }
  return { actions, findings, tools };
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

function readDockerfile(file: CandidateFile): DockerfileFacts {
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
  return { path: file.path, images, unpinnedImages, latestImages, runsAsRoot, addsRemote, curlPipeShell: piped };
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
function keyFiles(paths: readonly string[]): KeyFile[] {
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
    if (strength === "strong") strong.push({ path, strength });
    else if (strength === "weak") weak.push({ path, strength });
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
  workflows: readonly CandidateFile[];
  lockfiles: readonly LockfileSummary[];
  unread: readonly string[];
  dockerfiles?: readonly CandidateFile[];
  tooling?: readonly CandidateFile[];
}

/** Every field of `SupplyChainFacts`, worked out from paths and the contents the caller read. Never reads a key file. */
export function supplyChainFacts(input: SupplyChainInput): SupplyChainFacts {
  const paths = input.paths;

  const readable = input.workflows.filter((file) => isWorkflowPath(file.path) || isActionPath(file.path)).sort(byPath);
  const files = readable.slice(0, MAX_WORKFLOWS);
  const commands = commandsByFile(files, input.tooling ?? []);
  const actions: ActionUse[] = [];
  const findings: WorkflowFinding[] = [];
  const securityTools: SecurityTool[] = [];
  // Each list is added to one item at a time: a spread argument of a large array overflows the call stack.
  for (const file of files) {
    const reading = readWorkflow(file, commands.get(file.path) ?? []);
    for (const use of reading.actions) if (actions.length < MAX_ACTIONS) actions.push(use);
    for (const finding of reading.findings) if (findings.length < MAX_FINDINGS) findings.push(finding);
    for (const tool of reading.tools) securityTools.push(tool);
  }

  const dockerfileFiles = (input.dockerfiles ?? [])
    .filter((file) => isDockerfile(file.path))
    .sort(byPath)
    .slice(0, MAX_DOCKERFILES);
  const dockerfiles = dockerfileFiles.map(readDockerfile);

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
  for (const path of paths) {
    if (isTestPath(path) || path.split("/").includes("node_modules")) continue;
    const rule = LOCKFILE_RULES.find((r) => r.manifests.includes(baseName(path)));
    if (rule && !coveredByParent(lockDirectories.get(rule.ecosystem)!, dirOf(path))) missing.push(path);
  }

  // A lockfile that is never read still exists, so report it as one instead of leaving it out.
  const summaries = new Map<string, LockfileSummary>(input.lockfiles.map((summary) => [summary.path, summary]));
  for (const path of paths) {
    if (isLockfile(path) && !isReadableLockfile(path) && !summaries.has(path)) {
      summaries.set(path, { path, read: "not_supported", packages: 0, publicPackages: 0 });
    }
  }

  return {
    version: SUPPLY_CHAIN_VERSION,
    workflowsRead: files.filter((file) => isWorkflowPath(file.path)).length,
    workflowsUnread: [...workflowsUnread].slice(0, MAX_WORKFLOWS),
    dockerfilesUnread: [...dockerfilesUnread].slice(0, MAX_LISTED),
    dockerfilesUnreadTotal: dockerfilesUnread.size,
    actions,
    findings,
    securityTools,
    updateConfig: UPDATE_CONFIGS.find((path) => configs.has(path)) ?? null,
    securityPolicy: securityPolicy(paths),
    manifestsByEcosystem: Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b))),
    missingLockfiles: missing.sort().slice(0, MAX_LISTED),
    lockfiles: [...summaries.values()].sort(byPath),
    keyFiles: keyFiles(paths),
    dockerfiles,
    ecosystems: ECOSYSTEM_ORDER.filter((ecosystem) => needed.has(ecosystem)),
  };
}
