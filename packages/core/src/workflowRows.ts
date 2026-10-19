/**
 * The row model that every workflow check reads: a workflow split into meaningful lines with their indentation, and the
 * helpers that read a value from them. Pure, with no YAML parser, and every loop is bounded because the text is untrusted
 * (ADR 0032).
 */

export const MAX_LINE = 2_000;
export const MAX_LINES = 20_000;
export const MAX_JOINED = 8_000;
export const MAX_FLOW_ROWS = 200;

/** One meaningful line of a workflow, with its place in the indentation. */
export interface Row {
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

export const BLOCK_SCALAR_KEY = /^["']?[\w.-]+["']?\s*:\s*[|>][-+0-9]*$/;
export const BLOCK_SCALAR_VALUE = /^[|>][-+0-9]*$/;

export const unquote = (value: string): string => {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote) ? value.slice(1, -1) : value;
};

/**
 * Splits a workflow into rows. Blank and comment lines are dropped, except inside a block scalar, where a `#` line is
 * script text. The lines of a block scalar are kept and marked, so `uses:` written in a script is not read as a step.
 */
export function rowsOf(content: string): Row[] {
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
    // Most rows hold no `#`, and skipping the pattern for them saves a scan of every position on a long line.
    const text = body.includes("#") ? body.replace(/(^|\s)#.*$/, "").trimEnd() : body;
    const keyIndent = indent + dashes;
    if (BLOCK_SCALAR_KEY.test(text)) scalarKeyIndent = keyIndent;
    rows.push({ no: i + 1, indent, keyIndent, dash: dashes > 0, body, text, scalar: false });
  });
  return rows;
}

/**
 * The names at the top level of a flow list or map such as `[push, pull_request]` or `{ push: { branches: [issues] } }`,
 * where only `push` is an event. Null when the brackets never close, so the names cannot be known.
 */
export function flowNames(text: string): string[] | null {
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

const ON_KEY = /^(?:on|"on"|'on'|true)\s*:\s*(.*)$/;

/**
 * The events a workflow runs on, from `on: x`, a flow list or map (on one line or several), a block list or a block
 * map. Null when they cannot be known, which is a flow value whose brackets never close. A caller treats null as
 * possibly privileged, because a parser that cannot read the trigger must not hide a finding behind it. That costs
 * nothing in practice: GitHub rejects a workflow with an unclosed bracket, so a false finding can only land on a
 * file that never runs, and a legal spelling this reader failed to follow is still checked rather than skipped.
 */
export function triggersOf(rows: readonly Row[]): Set<string> | null {
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

// ---- structure ------------------------------------------------------------------------------------------------------

/** An `if:` as written: where it sits, the expression after YAML has been read, and the text as written for display. */
export interface ConditionSource {
  /** The line of the `if:` key. */
  line: number;
  /** The expression, or null when the YAML value could not be read safely, such as a plain value starting with `!`. */
  text: string | null;
  /** The value joined as written, cut at `MAX_CONDITION`, shown only once blanked and otherwise only hashed. */
  raw: string;
}

export interface JobBlock {
  /** The job id, unquoted. */
  id: string;
  /** The row of the job's key, and the row after its last row. */
  row: number;
  end: number;
  condition: ConditionSource | null;
  /** The ids in `needs:`, an empty list when the key is absent, or null when it cannot be read. */
  needs: string[] | null;
}

export interface StepBlock {
  row: number;
  end: number;
  /** The index of the job holding the step, or -1 in a composite action. */
  job: number;
  condition: ConditionSource | null;
}

export interface Structure {
  jobs: JobBlock[];
  steps: StepBlock[];
  /** For each row, the index of the job or step it sits in, or -1. */
  jobOf: Int32Array;
  stepOf: Int32Array;
}

/** The most characters of an `if:` that are read. Longer is unreadable (ADR 0039). */
export const MAX_CONDITION = 2_000;
const MAX_CONDITION_ROWS = 200;

const JOBS_KEY = /^jobs\s*:$/;
const RUNS_KEY = /^runs\s*:$/;
const IF_KEY = /^if\s*:\s*(.*)$/;

/** A YAML value as the expression it holds, or null when reading it safely is not possible. */
function yamlValue(value: string): string | null {
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.length < 2 || !value.endsWith(quote)) return null;
    const inner = value.slice(1, -1);
    if (quote === '"') return inner.includes("\\") || inner.includes('"') ? null : inner;
    return inner.replaceAll("''", "").includes("'") ? null : inner.replaceAll("''", "'");
  }
  // A plain value starting with `!` is a YAML tag, which GitHub reads differently from an expression.
  return value && !value.startsWith("!") ? value : null;
}

/**
 * The `if:` at row `k`, with continuation lines joined. After a block scalar indicator the lines of the block are
 * joined, with line breaks in a `|` block and spaces in a `>` one, and the block keeps its final line break unless the
 * indicator holds `-`, as YAML does: that line break is text outside any `${{ }}`, which `parseExpression` must see.
 * Otherwise the value is joined with single spaces to the rows deeper than the key, which is how a plain or quoted scalar
 * continues. A comment is content in a block scalar and not in a plain one, which `rowsOf` already decided when it chose
 * `body` or `text` for each row. At most 200 rows and 2,000 characters are read, and a value that runs on past either is
 * unreadable, since the rest of it could undo what was read.
 */
export function conditionAt(rows: readonly Row[], k: number): ConditionSource {
  const row = rows[k]!;
  const inline = (IF_KEY.exec(row.text)?.[1] ?? "").trim();
  const block = BLOCK_SCALAR_VALUE.test(inline) ? inline : null;
  const parts = block ? [] : [inline];
  let length = block ? 0 : inline.length;
  let unreadable = false;
  /** Whether row `j` carries the value on: a line of the block, or a row deeper than the key for any other value. */
  const continues = (j: number): boolean => {
    const next = rows[j];
    return next !== undefined && (block ? next.scalar : next.indent > row.keyIndent && !next.scalar);
  };
  let j = k + 1;
  for (; j <= k + MAX_CONDITION_ROWS && continues(j); j++) {
    const next = rows[j]!;
    // A dash row inside a plain value is a list, not a continuation of the expression.
    if (next.dash) unreadable = true;
    const piece = block ? next.body : next.text;
    parts.push(piece);
    length += piece.length + 1;
    if (length > MAX_CONDITION) break;
  }
  if (j > k + MAX_CONDITION_ROWS && continues(j)) unreadable = true;
  const joined = block
    ? parts.join(block.startsWith("|") ? "\n" : " ") + (parts.length > 0 && !block.includes("-") ? "\n" : "")
    : parts.join(" ").trim();
  const raw = joined.slice(0, MAX_CONDITION);
  if (unreadable || joined.length > MAX_CONDITION) return { line: row.no, text: null, raw };
  return { line: row.no, text: block ? joined || null : yamlValue(joined), raw };
}

/**
 * The names in a `needs:` value at row `k`, whose text after the key is `inline`: one id, a flow list that may run over
 * several rows, or a block list. Null when it cannot be known: an expression, a list that never closes, or something
 * other than ids.
 */
export function listValue(rows: readonly Row[], k: number, inline: string): string[] | null {
  if (inline.includes("${{")) return null;
  if (inline) {
    if (!/^\[/.test(inline)) return [unquote(inline)];
    let text = inline;
    for (let j = k + 1; j < rows.length && j <= k + MAX_FLOW_ROWS && flowNames(text) === null; j++) {
      text = `${text} ${rows[j]!.text}`.slice(0, MAX_JOINED);
    }
    const names = flowNames(text);
    return names !== null && names.every((name) => !name.includes("${{")) ? names : null;
  }
  const key = rows[k]!;
  const names: string[] = [];
  for (let j = k + 1; j < rows.length && j <= k + MAX_FLOW_ROWS; j++) {
    const next = rows[j]!;
    // A block list may sit at the key's own indent, as `runsOnValue` allows.
    if (next.indent <= key.keyIndent && !(next.dash && next.indent === key.keyIndent)) break;
    if (!next.dash || next.scalar || next.text.includes("${{")) return null;
    names.push(unquote(next.text.trim()));
  }
  return names.length > 0 ? names : null;
}

/** Reads the steps of one block: the `steps:` key at row `key`, whose block ends before row `to`. */
function stepsOf(rows: readonly Row[], key: number, to: number, job: number, steps: StepBlock[], stepOf: Int32Array): void {
  const indent = rows[key]!.indent;
  let end = key + 1;
  while (end < to && (rows[end]!.indent > indent || (rows[end]!.dash && rows[end]!.indent === indent))) end++;
  // From the key, and not from the first row, so a file with many jobs does not read its rows again for each of them.
  let first = key + 1;
  while (first < end && !(rows[first]!.dash && !rows[first]!.scalar)) first++;
  if (first >= end) return;
  const itemIndent = rows[first]!.indent;
  const starts: number[] = [];
  for (let i = first; i < end; i++) if (rows[i]!.dash && !rows[i]!.scalar && rows[i]!.indent === itemIndent) starts.push(i);
  starts.forEach((from, n) => {
    const stop = starts[n + 1] ?? end;
    const keyIndent = rows[from]!.keyIndent;
    let condition: ConditionSource | null = null;
    for (let i = from; i < stop && condition === null; i++) {
      const row = rows[i]!;
      if (row.scalar || row.keyIndent !== keyIndent || (i > from && row.dash)) continue;
      if (IF_KEY.test(row.text)) condition = conditionAt(rows, i);
    }
    stepOf.fill(steps.length, from, stop);
    steps.push({ row: from, end: stop, job, condition });
  });
}

/**
 * The jobs and steps of a workflow, and which of them each row sits in, in one linear pass. Jobs are the keys under
 * `jobs:`. Steps are the dash rows under a job's `steps:` key, or under `runs:` then `steps:` in a composite action.
 * Like the rest of this file it recognises the forms people write and not every legal spelling, and a form it does not
 * recognise gives no condition, which callers treat as no guard.
 */
export function structureOf(rows: readonly Row[]): Structure {
  const jobs: JobBlock[] = [];
  const steps: StepBlock[] = [];
  const jobOf = new Int32Array(rows.length).fill(-1);
  const stepOf = new Int32Array(rows.length).fill(-1);
  const blockEnd = (from: number) => {
    let end = from + 1;
    while (end < rows.length && rows[end]!.indent > 0) end++;
    return end;
  };
  const topLevel = (pattern: RegExp) =>
    rows.findIndex((row) => row.indent === 0 && !row.scalar && !row.dash && pattern.test(row.text));

  const jobsAt = topLevel(JOBS_KEY);
  if (jobsAt >= 0) {
    const end = blockEnd(jobsAt);
    const base = jobsAt + 1 < end ? rows[jobsAt + 1]!.indent : 0;
    const starts: number[] = [];
    for (let k = jobsAt + 1; k < end; k++) if (rows[k]!.indent === base && !rows[k]!.dash && !rows[k]!.scalar) starts.push(k);
    starts.forEach((from, n) => {
      const to = starts[n + 1] ?? end;
      const inner = from + 1 < to ? rows[from + 1]!.indent : -1;
      let condition: ConditionSource | null = null;
      // An absent `needs:` is an empty list, which is a job with nothing to wait for; null is one that cannot be read.
      let needs: string[] | null = [];
      let stepsKey = -1;
      let seenNeeds = false;
      for (let k = from + 1; k < to; k++) {
        const row = rows[k]!;
        if (row.indent !== inner || row.dash || row.scalar) continue;
        const ifValue = IF_KEY.test(row.text);
        const needsValue = /^needs\s*:\s*(.*)$/.exec(row.text);
        if (ifValue && condition === null) condition = conditionAt(rows, k);
        else if (needsValue && !seenNeeds) {
          seenNeeds = true;
          needs = listValue(rows, k, needsValue[1]!.trim());
        } else if (/^steps\s*:$/.test(row.text) && stepsKey < 0) stepsKey = k;
      }
      const job = jobs.length;
      const key = rows[from]!.text.split(":")[0]!.trim();
      jobs.push({ id: unquote(key), row: from, end: to, condition, needs });
      jobOf.fill(job, from, to);
      if (stepsKey >= 0) stepsOf(rows, stepsKey, to, job, steps, stepOf);
    });
  }

  const runsAt = topLevel(RUNS_KEY);
  if (runsAt >= 0) {
    const to = blockEnd(runsAt);
    const inner = runsAt + 1 < to ? rows[runsAt + 1]!.indent : -1;
    const stepsKey = rows.findIndex(
      (row, i) => i > runsAt && i < to && row.indent === inner && !row.dash && !row.scalar && /^steps\s*:$/.test(row.text),
    );
    if (stepsKey >= 0) stepsOf(rows, stepsKey, to, -1, steps, stepOf);
  }
  return { jobs, steps, jobOf, stepOf };
}
