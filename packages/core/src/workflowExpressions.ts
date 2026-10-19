/**
 * A reader for the `if:` expressions of a workflow (ADR 0039): a tokeniser, a precedence parser and an evaluator that
 * answers true, false or unknown. It knows nothing about rows or events; `workflowReach.ts` supplies the facts through a
 * `Scope`. Pure, with no `eval`, and every step is bounded because the text is untrusted.
 *
 * It imitates GitHub's documented semantics: `&&` and `||` return one of their operands, `==` is loose and coerces
 * mismatched primitives to numbers, strings compare ignoring case, and a condition with no status function gets an
 * implicit `success() &&`. Anything it cannot prove is unknown, and callers keep a finding on unknown. A known answer
 * that is wrong can still hide a finding, so each rule below that gives a known answer is pinned by a test whose answer
 * was worked out by hand.
 * GitHub documents no operator precedence; this follows the runner's order, which never matters for the guards in scope.
 */

export type OpaqueName = "base-repo" | "fork-repo" | "base-owner" | "fork-owner" | "base-id" | "fork-id";

/**
 * A value known only by identity: equal to the same name, unequal to another opaque name, unknown against anything else.
 * A class, so that an object parsed from text by `fromJSON` can never pass for one.
 */
export class Opaque {
  constructor(readonly name: OpaqueName) {}
}

/**
 * An event name known only as one of `names`, or, when `open` is set, as any name but those. It is truthy. Compared
 * with a string, ignoring case, it is false when the string is a name it cannot be, true only when `names` holds that one
 * name and `open` is not set, and unknown otherwise. Against anything else, and inside any function, it is unknown. A
 * class, as `Opaque` is, so that parsed text can never pass for one.
 */
export class EventNames {
  readonly names: ReadonlySet<string>;
  constructor(
    names: readonly string[],
    readonly open = false,
  ) {
    this.names = new Set(names.map((name) => name.toLowerCase()));
  }
}

export type Value = null | boolean | number | string | Opaque | EventNames | readonly Value[] | { readonly [key: string]: Value };
/** A value, or what is known of one that is not known: whether it is truthy, or nothing. */
export type Outcome = { known: true; value: Value } | { known: false; truthy: boolean | null };
export const UNKNOWN: Outcome = { known: false, truthy: null };

export type Expr =
  | { kind: "literal"; value: null | boolean | number | string }
  | { kind: "context"; name: string }
  | { kind: "member"; target: Expr; key: string }
  | { kind: "index"; target: Expr; key: Expr }
  | { kind: "filter"; target: Expr }
  | { kind: "not"; operand: Expr }
  | { kind: "compare"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
  | { kind: "and" | "or"; items: Expr[] }
  | { kind: "call"; name: string; args: Expr[] };

export interface Scope {
  /** A static context path in lower case, such as `["github", "event", "workflow_run", "event"]`. */
  lookup(path: readonly string[]): Outcome;
  /** What `success()` returns where the condition sits. */
  success(): Outcome;
}

export const MAX_EXPRESSION = 2_000;
export const MAX_TOKENS = 500;
export const MAX_DEPTH = 32;

// ---- tokens ---------------------------------------------------------------------------------------------------------

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ident"; value: string }
  | { type: "punct"; value: string };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;
const PUNCT = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "!", "(", ")", "[", "]", ".", ",", "*"];

/** Null when the text cannot be read as tokens: an unclosed string, a double quote, a stray character, too many tokens. */
function tokenise(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i++;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) return null;
    if (char === "'") {
      let value = "";
      let closed = false;
      for (i++; i < text.length; i++) {
        if (text[i] !== "'") value += text[i];
        else if (text[i + 1] === "'") {
          value += "'";
          i++;
        } else {
          closed = true;
          i++;
          break;
        }
      }
      if (!closed) return null;
      tokens.push({ type: "string", value });
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(text);
    if (ident) {
      tokens.push({ type: "ident", value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const punct = PUNCT.find((p) => text.startsWith(p, i));
    if (!punct) return null;
    tokens.push({ type: "punct", value: punct });
    i += punct.length;
  }
  return tokens;
}

// ---- parser ---------------------------------------------------------------------------------------------------------

class Unreadable extends Error {}

/**
 * `or := and ('||' and)*`, `and := eq ('&&' eq)*`, `eq := rel (('=='|'!=') rel)*`, `rel := unary (('<'|'<='|'>'|'>=')
 * unary)*`, `unary := '!' unary | postfix`, `postfix := primary ('.' IDENT | '.' '*' | '[' or ']')*`. Chains of `&&`
 * and `||` are flat nodes, so a long chain adds no depth.
 */
class Parser {
  private at = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Expr {
    const expr = this.or(0);
    if (this.at < this.tokens.length) throw new Unreadable();
    return expr;
  }

  private peekPunct(...options: string[]): string | null {
    const token = this.tokens[this.at];
    return token?.type === "punct" && options.includes(token.value) ? token.value : null;
  }

  private expect(punct: string): void {
    if (!this.peekPunct(punct)) throw new Unreadable();
    this.at++;
  }

  private deeper(depth: number): number {
    if (depth + 1 > MAX_DEPTH) throw new Unreadable();
    return depth + 1;
  }

  private or(depth: number): Expr {
    const items = [this.and(depth)];
    while (this.peekPunct("||")) {
      this.at++;
      items.push(this.and(depth));
    }
    return items.length === 1 ? items[0]! : { kind: "or", items };
  }

  private and(depth: number): Expr {
    const items = [this.equality(depth)];
    while (this.peekPunct("&&")) {
      this.at++;
      items.push(this.equality(depth));
    }
    return items.length === 1 ? items[0]! : { kind: "and", items };
  }

  private equality(depth: number): Expr {
    let left = this.relational(depth);
    for (let op = this.peekPunct("==", "!="); op; op = this.peekPunct("==", "!=")) {
      this.at++;
      left = { kind: "compare", op: op as "==" | "!=", left, right: this.relational(depth) };
    }
    return left;
  }

  private relational(depth: number): Expr {
    let left = this.unary(depth);
    for (let op = this.peekPunct("<", "<=", ">", ">="); op; op = this.peekPunct("<", "<=", ">", ">=")) {
      this.at++;
      left = { kind: "compare", op: op as "<" | "<=" | ">" | ">=", left, right: this.unary(depth) };
    }
    return left;
  }

  private unary(depth: number): Expr {
    if (this.peekPunct("!")) {
      this.at++;
      return { kind: "not", operand: this.unary(this.deeper(depth)) };
    }
    return this.postfix(depth);
  }

  private postfix(depth: number): Expr {
    let expr = this.primary(depth);
    for (;;) {
      if (this.peekPunct(".")) {
        this.at++;
        if (this.peekPunct("*")) {
          this.at++;
          expr = { kind: "filter", target: expr };
          continue;
        }
        const token = this.tokens[this.at];
        if (token?.type !== "ident") throw new Unreadable();
        this.at++;
        expr = { kind: "member", target: expr, key: token.value.toLowerCase() };
      } else if (this.peekPunct("[")) {
        this.at++;
        const key = this.or(this.deeper(depth));
        this.expect("]");
        expr = { kind: "index", target: expr, key };
      } else return expr;
    }
  }

  private primary(depth: number): Expr {
    const token = this.tokens[this.at];
    if (!token) throw new Unreadable();
    if (token.type === "number" || token.type === "string") {
      this.at++;
      return { kind: "literal", value: token.value };
    }
    if (token.type === "ident") {
      this.at++;
      if (this.peekPunct("(")) {
        this.at++;
        const args: Expr[] = [];
        const inner = this.deeper(depth);
        if (!this.peekPunct(")")) {
          args.push(this.or(inner));
          while (this.peekPunct(",")) {
            this.at++;
            args.push(this.or(inner));
          }
        }
        this.expect(")");
        return { kind: "call", name: token.value.toLowerCase(), args };
      }
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      return { kind: "context", name: token.value.toLowerCase() };
    }
    if (token.value === "(") {
      this.at++;
      const inner = this.or(this.deeper(depth));
      this.expect(")");
      return inner;
    }
    throw new Unreadable();
  }
}

/**
 * GitHub reads a value holding `${{` as a template, cut into literal text and expressions without being trimmed first,
 * so the text is one expression only when it starts with `${{`, ends with `}}` and holds neither inside, and then that
 * one wrapper is stripped. Any text around it, even a space or the line break a `|` block keeps, makes a `format()`
 * string, which is always true, so that and any other text with `${{` in it is unreadable. A wrapper around a single
 * string is unreadable too, because GitHub then reads the string's text as the condition, and an empty one as `success()`.
 * Null when the text cannot be read, which includes every bound in `MAX_EXPRESSION`, `MAX_TOKENS` and `MAX_DEPTH`.
 */
export function parseExpression(text: string): Expr | null {
  const inner = text.slice(3, -2);
  const wrapped =
    text.length >= 5 && text.startsWith("${{") && text.endsWith("}}") && !inner.includes("${{") && !inner.includes("}}");
  const body = (wrapped ? inner : text).trim();
  if (body.includes("${{") || body.length > MAX_EXPRESSION) return null;
  const tokens = tokenise(body);
  if (!tokens || tokens.length === 0) return null;
  if (wrapped && tokens.length === 1 && tokens[0]!.type === "string") return null;
  try {
    return new Parser(tokens).parse();
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

const STATUS_FUNCTIONS = new Set(["always", "success", "failure", "cancelled"]);

/** Whether the expression calls a status function, read from the tree so `'always()'` inside a string does not count. */
export function usesStatusFunction(expr: Expr): boolean {
  switch (expr.kind) {
    case "call":
      return STATUS_FUNCTIONS.has(expr.name) || expr.args.some(usesStatusFunction);
    case "and":
    case "or":
      return expr.items.some(usesStatusFunction);
    case "not":
      return usesStatusFunction(expr.operand);
    case "compare":
      return usesStatusFunction(expr.left) || usesStatusFunction(expr.right);
    case "member":
    case "filter":
      return usesStatusFunction(expr.target);
    case "index":
      return usesStatusFunction(expr.target) || usesStatusFunction(expr.key);
    default:
      return false;
  }
}

// ---- values ---------------------------------------------------------------------------------------------------------

const known = (value: Value): Outcome => ({ known: true, value });
const yes: Outcome = known(true);
const no: Outcome = known(false);
const truthyOnly = (truthy: boolean | null): Outcome => ({ known: false, truthy });

const isList = (value: Value): value is readonly Value[] => Array.isArray(value);
const isMap = (value: Value): value is { readonly [key: string]: Value } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Opaque) &&
  !(value instanceof EventNames);

/** GitHub's falsy values are `false`, `0`, `-0`, `''`, `null` and NaN; everything else, a list or an object included, is truthy. */
function truthyValue(value: Value): boolean {
  if (value === null || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return true;
}

/** True or false when the outcome's truthiness is known, null when it is not. */
export function truthOf(outcome: Outcome): boolean | null {
  return outcome.known ? truthyValue(outcome.value) : outcome.truthy;
}

const ASCII = /^[^\u0080-￿]*$/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A string that the runner might read as a number even though JSON would not: a digit, a sign or a point, or a word. */
const NUMERIC_LOOK = /[\d+.]|^-?(?:infinity|nan)$/i;

/**
 * A primitive as a number, GitHub's way. Null when the runner's reading of it is not clear. A string that is not a JSON
 * number but looks numeric is null and not NaN, because the runner reads more forms than JSON does, such as `0x10`, `+1`
 * and `Infinity`, and a comparison taken as false for NaN could hide a finding. Only a string with no numeric look is NaN.
 */
function numberOf(value: null | boolean | number | string): number | null {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (value !== value.trim()) return null;
  if (value === "") return 0;
  if (JSON_NUMBER.test(value)) return Number(value);
  return NUMERIC_LOOK.test(value) ? null : Number.NaN;
}

type Primitive = null | boolean | number | string;
const isPrimitive = (value: Value): value is Primitive => !(typeof value === "object" && value !== null);

/** Whether an event name known only as one of a set is the given string, ignoring case. Null when that cannot be known. */
function isEventName(event: EventNames, text: string): boolean | null {
  if (!ASCII.test(text)) return null;
  const name = text.toLowerCase();
  if (event.open) return event.names.has(name) ? false : null;
  if (!event.names.has(name)) return false;
  return event.names.size === 1 ? true : null;
}

/** Loose equality: true, false, or null when it cannot be judged. */
function looseEquals(a: Value, b: Value): boolean | null {
  if (a instanceof Opaque || b instanceof Opaque) return a instanceof Opaque && b instanceof Opaque ? a.name === b.name : null;
  if (a instanceof EventNames) return typeof b === "string" ? isEventName(a, b) : null;
  if (b instanceof EventNames) return typeof a === "string" ? isEventName(b, a) : null;
  if (!isPrimitive(a) || !isPrimitive(b)) return null;
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    return ASCII.test(a) && ASCII.test(b) ? a.toLowerCase() === b.toLowerCase() : null;
  }
  const x = numberOf(a);
  const y = numberOf(b);
  return x === null || y === null ? null : x === y;
}

/** An ordering test: two numbers or mixed primitives only, with NaN giving false. Null for the rest. */
function ordered(op: "<" | "<=" | ">" | ">=", a: Value, b: Value): boolean | null {
  if (!isPrimitive(a) || !isPrimitive(b) || (typeof a === "string" && typeof b === "string")) return null;
  const x = numberOf(a);
  const y = numberOf(b);
  if (x === null || y === null) return null;
  if (op === "<") return x < y;
  if (op === "<=") return x <= y;
  return op === ">" ? x > y : x >= y;
}

/** The string GitHub makes of a primitive for `startsWith`, `endsWith`, `contains` and `format`. Null for the rest. */
function textOf(value: Value): string | null {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return null;
}

// ---- evaluation -----------------------------------------------------------------------------------------------------

/**
 * The names from a context root down to here, when every step is a fixed name or number; null otherwise. A step that
 * holds a `.`, such as `github['event.workflow_run.event']`, is null too: it names one key with a dot in it, which the
 * dotted paths of the facts cannot tell from a path of several keys.
 */
function staticPath(expr: Expr): string[] | null {
  const path: string[] = [];
  let at = expr;
  for (;;) {
    if (at.kind === "context") {
      path.push(at.name);
      return path.reverse();
    }
    let step: string;
    if (at.kind === "member") step = at.key;
    else if (at.kind === "index" && at.key.kind === "literal" && typeof at.key.value === "string")
      step = at.key.value.toLowerCase();
    else if (at.kind === "index" && at.key.kind === "literal" && typeof at.key.value === "number") step = String(at.key.value);
    else return null;
    if (step.includes(".")) return null;
    path.push(step);
    at = at.target;
  }
}

function access(target: Value, key: Value): Outcome {
  if (isList(target)) {
    return typeof key === "number" && Number.isInteger(key) && key >= 0 ? known(target[key] ?? null) : UNKNOWN;
  }
  if (isMap(target) && typeof key === "string") {
    const wanted = key.toLowerCase();
    for (const name of Object.keys(target)) if (name.toLowerCase() === wanted) return known(target[name]!);
    return known(null);
  }
  return UNKNOWN;
}

function call(name: string, args: readonly Expr[], scope: Scope): Outcome {
  if (name === "always") return args.length === 0 ? yes : UNKNOWN;
  if (name === "success") return args.length === 0 ? scope.success() : UNKNOWN;
  const values: Value[] = [];
  for (const arg of args) {
    const outcome = evaluate(arg, scope);
    // An event name known only as one of a set is unknown inside a function, `contains` over a list included.
    if (!outcome.known || outcome.value instanceof EventNames) return UNKNOWN;
    values.push(outcome.value);
  }
  const [first, second] = values;
  switch (name) {
    case "contains": {
      if (values.length !== 2) return UNKNOWN;
      if (isList(first!)) {
        let unsure = false;
        for (const element of first) {
          const same = looseEquals(element, second!);
          if (same) return yes;
          if (same === null) unsure = true;
        }
        return unsure ? UNKNOWN : no;
      }
      return textTest(first!, second!, (a, b) => a.includes(b));
    }
    case "startswith":
      return values.length === 2 ? textTest(first!, second!, (a, b) => a.startsWith(b)) : UNKNOWN;
    case "endswith":
      return values.length === 2 ? textTest(first!, second!, (a, b) => a.endsWith(b)) : UNKNOWN;
    case "format":
      return formatText(values);
    case "tojson":
      return values.length === 1 && isPrimitive(first!) ? known(JSON.stringify(first)) : UNKNOWN;
    case "fromjson": {
      if (values.length !== 1 || typeof first !== "string") return UNKNOWN;
      try {
        return known(JSON.parse(first) as Value);
      } catch {
        return UNKNOWN;
      }
    }
    default:
      return UNKNOWN;
  }
}

/** A test on two strings that ignores case. Non-ASCII text is left unknown, since the runner's folding is not documented. */
function textTest(a: Value, b: Value, test: (a: string, b: string) => boolean): Outcome {
  const left = textOf(a);
  const right = textOf(b);
  if (left === null || right === null || !ASCII.test(left) || !ASCII.test(right)) return UNKNOWN;
  return known(test(left.toLowerCase(), right.toLowerCase()));
}

/** `format('{0}-{{', 'a')`. A missing index, a stray brace or a format specifier gives unknown. */
function formatText(values: readonly Value[]): Outcome {
  const [template, ...rest] = values;
  if (typeof template !== "string") return UNKNOWN;
  const pieces = rest.map(textOf);
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const char = template[i]!;
    if (char === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i++;
        continue;
      }
      const close = template.indexOf("}", i);
      const index = close < 0 ? "" : template.slice(i + 1, close);
      const piece = /^\d{1,3}$/.test(index) ? pieces[Number(index)] : undefined;
      if (piece === undefined || piece === null) return UNKNOWN;
      out += piece;
      i = close;
    } else if (char === "}") {
      if (template[i + 1] !== "}") return UNKNOWN;
      out += "}";
      i++;
    } else out += char;
  }
  return known(out);
}

/** `&&` and `||` over operands, in Kleene logic, returning an operand as GitHub does. `stop` is the truthiness that ends the chain. */
function chain(items: readonly Expr[], stop: boolean, scope: Scope): Outcome {
  let result = evaluate(items[0]!, scope);
  for (let i = 1; i < items.length; i++) {
    const truth = truthOf(result);
    if (truth === stop) return result;
    const next = evaluate(items[i]!, scope);
    if (truth === null) result = truthyOnly(truthOf(next) === stop ? stop : null);
    else result = next;
  }
  return result;
}

export function evaluate(expr: Expr, scope: Scope): Outcome {
  switch (expr.kind) {
    case "literal":
      return known(expr.value);
    case "context":
      return scope.lookup([expr.name]);
    case "member":
    case "index": {
      const path = staticPath(expr);
      if (path) return scope.lookup(path);
      const target = evaluate(expr.target, scope);
      if (!target.known) return UNKNOWN;
      const key = expr.kind === "member" ? known(expr.key) : evaluate(expr.key, scope);
      return key.known ? access(target.value, key.value) : UNKNOWN;
    }
    case "filter":
      return UNKNOWN;
    case "not": {
      const truth = truthOf(evaluate(expr.operand, scope));
      return truth === null ? UNKNOWN : known(!truth);
    }
    case "compare": {
      const left = evaluate(expr.left, scope);
      const right = evaluate(expr.right, scope);
      if (!left.known || !right.known) return UNKNOWN;
      if (expr.op === "==" || expr.op === "!=") {
        const same = looseEquals(left.value, right.value);
        return same === null ? UNKNOWN : known(expr.op === "==" ? same : !same);
      }
      const result = ordered(expr.op, left.value, right.value);
      return result === null ? UNKNOWN : known(result);
    }
    case "and":
      return chain(expr.items, false, scope);
    case "or":
      return chain(expr.items, true, scope);
    case "call":
      return call(expr.name, expr.args, scope);
  }
}

/**
 * A condition read once: its truth as written (`own`), and its truth with GitHub's implicit `success() &&` when it names
 * no status function (`full`), which is what decides whether a job or step runs.
 */
export function conditionTruths(expr: Expr, scope: Scope): { own: boolean | null; full: boolean | null } {
  const own = truthOf(evaluate(expr, scope));
  if (usesStatusFunction(expr)) return { own, full: own };
  const success = truthOf(scope.success());
  // `success() && expr`: a known success hands over to the expression, an unknown one can only stay unknown or be false.
  return { own, full: success === false ? false : success === true ? own : own === false ? false : null };
}

/** The condition's truth, with GitHub's implicit `success() &&` when it names no status function. */
export const conditionTruth = (expr: Expr, scope: Scope): boolean | null => conditionTruths(expr, scope).full;
