import { parse, tokTypes, type ParserPlugin } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";
import type { FunctionMetrics } from "@dora-dashboard/core";
import { extensionOf, isScriptExtension, languageOf, type ScriptExtension } from "../analysis/languages.js";

/**
 * What one file yielded. `complete` is false when the parser had to recover from an error or gave up, or when the file
 * held something this module does not know how to walk; `problem` then says what, and is null otherwise.
 */
export interface SourceMeasurement {
  readonly functions: FunctionMetrics[];
  readonly complete: boolean;
  readonly problem: string | null;
}

type NodeType = Node["type"];

// `jsx` stays off for .ts, .mts and .cts, where `<T>value` is a type assertion rather than an element.
// Flow annotations are read in any .js, .jsx, .mjs or .cjs file. The `@flow` pragma only decides the syntax that
// standard JavaScript reads differently, such as the call `f<T>(x)`.
const JAVASCRIPT: ParserPlugin[] = ["jsx", "flow"];
const PLUGINS: Record<ScriptExtension, ParserPlugin[]> = {
  ts: ["typescript"],
  mts: ["typescript"],
  cts: ["typescript"],
  tsx: ["typescript", "jsx"],
  js: JAVASCRIPT,
  jsx: JAVASCRIPT,
  mjs: JAVASCRIPT,
  cjs: JAVASCRIPT,
};

// Babel reads one decorator syntax at a time. Legacy decorators come first because TypeScript's parameter decorators
// exist only there; standard decorators (`export @dec class`) are the fallback for a file legacy cannot read.
const LEGACY_DECORATORS: ParserPlugin[] = ["decorators-legacy", "decoratorAutoAccessors"];
const STANDARD_DECORATORS: ParserPlugin[] = ["decorators", "decoratorAutoAccessors"];

const pluginsFor = (path: string): ParserPlugin[] => {
  const extension = extensionOf(path);
  return PLUGINS[isScriptExtension(extension) ? extension : "js"];
};

const FUNCTION_TYPES = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
] as const satisfies readonly NodeType[];

type FunctionNode = Extract<Node, { type: (typeof FUNCTION_TYPES)[number] }>;

// Overload signatures, `declare function` and abstract methods are separate node types with no body, so they never match.
const FUNCTIONS: ReadonlySet<string> = new Set(FUNCTION_TYPES);

const isFunction = (node: Node): node is FunctionNode => FUNCTIONS.has(node.type);

// The decision points lizard's TypeScript reader counts (ADR 0025). Only `??` and `??=` depend on spacing in lizard, which
// counts `a ?? b` and `a ??= b` twice and `a??b` and `a??=b` once; here each counts once. `||=` and `&&=` count once
// however they are spaced. Optional chaining, default values and `default:` never count.
const BRANCH_TYPES = [
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
] as const satisfies readonly NodeType[];
const BRANCHES: ReadonlySet<string> = new Set(BRANCH_TYPES);
const LOGICAL_OPERATORS = new Set<string>(["&&", "||", "??", "&&=", "||=", "??="]);

function isDecision(node: Node): boolean {
  if (BRANCHES.has(node.type)) return true;
  if (node.type === "SwitchCase") return node.test !== null && node.test !== undefined;
  if (node.type === "LogicalExpression" || node.type === "AssignmentExpression") return LOGICAL_OPERATORS.has(node.operator);
  return false;
}

/** A node on the walk, with the way back up for naming and the functions its decision points count towards. */
interface Visit {
  node: Node;
  parent: Visit | null;
  /** The function this node's decision points count to. */
  owner: Measured | null;
  /**
   * The function around the nearest function above this node, where a decorator on this node runs: a function's
   * parameters see the function's own owner, and anything else inside it sees the function.
   */
  outer: Measured | null;
}

interface Measured {
  metrics: FunctionMetrics;
  /** Offsets of the source the function owns: from after any decorators to its end. */
  start: number;
  end: number;
  lines: number;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

function keyName(key: Node, computed: boolean): string {
  if (key.type === "PrivateName") return `#${key.id.name}`;
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral" || key.type === "BigIntLiteral") return String(key.value);
  if (key.type === "Identifier" && !computed) return key.name;
  return "(computed)";
}

/** The right-most name in an assignment target: `run` for `exports.run`, `handler` for `this.handler`. */
function targetName(target: Node): string | null {
  if (target.type === "Identifier") return target.name;
  if ((target.type === "MemberExpression" || target.type === "OptionalMemberExpression") && !target.computed) {
    return target.property.type === "Identifier" ? target.property.name : keyName(target.property, false);
  }
  return null;
}

/** Expressions that only wrap a value, so a function inside one is still the value being named. */
const WRAPPER_TYPES = [
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TypeCastExpression",
] as const satisfies readonly NodeType[];
const WRAPPERS: ReadonlySet<string> = new Set(WRAPPER_TYPES);

const CALL_TYPES = ["CallExpression", "OptionalCallExpression", "NewExpression"] as const satisfies readonly NodeType[];
const CALLS: ReadonlySet<string> = new Set(CALL_TYPES);

/**
 * True when a function passed to this call may still be the value being named: a call to a plain function such as
 * `memo`, `forwardRef` or `useCallback`, or to a member of a capitalised namespace such as `React.memo`. A method of a
 * value, such as `items.reduce`, returns something other than its callback, and so does a constructor, such as
 * `new Promise`. A plain function is taken on trust, so `const id = setTimeout(() => …)` still names the callback `id`.
 */
function wrapsItsArgument(call: Node & { callee: Node }): boolean {
  if (call.type === "NewExpression") return false;
  const { callee } = call;
  if (callee.type === "Identifier") return true;
  return (
    (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    /^[A-Z]/.test(callee.object.name)
  );
}

/** How one kind of parent names the value `child` it holds, or null when it names something else. */
type Namer<T extends NodeType> = (parent: Extract<Node, { type: T }>, child: Node) => string | null;

const propertyName = (parent: { key: Node; value?: unknown; computed?: boolean }, child: Node): string | null =>
  parent.value === child ? keyName(parent.key, "computed" in parent && parent.computed === true) : null;

const assignedName = (parent: { left: Node; right: Node }, child: Node): string | null =>
  parent.right === child ? targetName(parent.left) : null;

/** The parents that give the value they hold a name. Any other parent gives none. */
const NAMERS: { [T in NodeType]?: Namer<T> } = {
  VariableDeclarator: (parent, child) => (parent.init === child && parent.id.type === "Identifier" ? parent.id.name : null),
  ObjectProperty: propertyName,
  ClassProperty: propertyName,
  ClassPrivateProperty: propertyName,
  ClassAccessorProperty: propertyName,
  AssignmentExpression: assignedName,
  AssignmentPattern: assignedName,
  ExportDefaultDeclaration: () => "default",
};

/** The name a parent gives the value `child`, or null when it gives none. */
function nameGivenBy(parent: Node, child: Node): string | null {
  if (!Object.hasOwn(NAMERS, parent.type)) return null;
  // Each entry takes its own node type, which TypeScript cannot follow through a lookup by `parent.type`.
  const namer = NAMERS[parent.type] as Namer<NodeType>;
  return namer(parent, child);
}

/** The attribute's name when `holder` is the braces of a JSX attribute, such as `onClick` in `onClick={…}`. */
function attributeName(holder: Visit): string | null {
  const attribute = holder.parent?.node;
  if (holder.node.type !== "JSXExpressionContainer" || attribute?.type !== "JSXAttribute") return null;
  const { name } = attribute;
  return name.type === "JSXIdentifier" ? name.name : `${name.namespace.name}:${name.name.name}`;
}

/** Where a climb from a function stopped: the node that may name it, the value it holds, and the first callee passed. */
interface Climb {
  holder: Visit | null;
  child: Node;
  callee: string | null;
}

/**
 * Climbs from a function through wrappers and through calls that return their argument. It stops at the first other
 * parent, which may name the function, or with no holder at a call that does not return it or that calls it.
 */
function climb(visit: Visit): Climb {
  let child = visit.node;
  let callee: string | null = null;
  for (let up = visit.parent; up; child = up.node, up = up.parent) {
    const parent = up.node;
    if (WRAPPERS.has(parent.type)) continue;
    if (!CALLS.has(parent.type) || !("callee" in parent)) return { holder: up, child, callee };
    if (parent.callee === child) return { holder: null, child, callee };
    callee ??= targetName(parent.callee);
    if (!wrapsItsArgument(parent)) return { holder: null, child, callee };
  }
  return { holder: null, child, callee };
}

/**
 * Names an unnamed function after what holds it, looking up through wrappers and through calls that return their
 * argument, so that `const Card = memo(() => …)` is `Card`. Otherwise a function passed to a call is `<callee> callback`,
 * one in a JSX attribute takes the attribute's name, and anything else is `(anonymous)`, as lizard prints it.
 */
function inferredName(visit: Visit): string {
  const { holder, child, callee } = climb(visit);
  const name = holder === null ? null : (attributeName(holder) ?? nameGivenBy(holder.node, child));
  if (name !== null) return name;
  return callee === null ? "(anonymous)" : `${callee} callback`;
}

function nameOf(visit: Visit, fn: FunctionNode): string {
  if ((fn.type === "FunctionDeclaration" || fn.type === "FunctionExpression") && fn.id) return fn.id.name;
  if (fn.type === "ObjectMethod" || fn.type === "ClassMethod" || fn.type === "ClassPrivateMethod") {
    return keyName(fn.key, "computed" in fn && fn.computed === true);
  }
  return inferredName(visit);
}

/** The line of the function's name where it has one, otherwise of its first token. */
function startLineOf(fn: FunctionNode): number {
  const named = fn.type === "FunctionDeclaration" || fn.type === "FunctionExpression" ? fn.id : "key" in fn ? fn.key : null;
  return (named ?? fn).loc!.start.line;
}

/**
 * Each name destructured at the top level of a parameter counts as one, as lizard counts them, so a component taking
 * `{ label, value, onChange }` has three. A TypeScript `this` parameter is a type annotation, not a parameter.
 */
function paramCount(fn: FunctionNode): number {
  let count = 0;
  for (const raw of fn.params) {
    const param = raw.type === "TSParameterProperty" ? raw.parameter : raw;
    if (param.type === "Identifier" && param.name === "this") continue;
    const target = param.type === "AssignmentPattern" ? param.left : param;
    if (target.type === "ObjectPattern") count += Math.max(target.properties.length, 1);
    else if (target.type === "ArrayPattern") count += Math.max(target.elements.filter(Boolean).length, 1);
    else count += 1;
  }
  return count;
}

function ownedFrom(fn: FunctionNode): number {
  const decorators = "decorators" in fn ? fn.decorators : null;
  const last = decorators?.[decorators.length - 1];
  return last ? last.end! : fn.start!;
}

const hasDecorators = (node: Node): boolean =>
  "decorators" in node && Array.isArray(node.decorators) && node.decorators.length > 0;

function measuredFunction(path: string, language: FunctionMetrics["language"], visit: Visit, fn: FunctionNode): Measured {
  return {
    metrics: {
      file: path,
      language,
      name: nameOf(visit, fn),
      startLine: startLineOf(fn),
      endLine: fn.loc!.end.line,
      ccn: 1,
      nloc: 0,
      params: paramCount(fn),
    },
    start: ownedFrom(fn),
    end: fn.end!,
    lines: 0,
  };
}

/** The keys to walk below a node, noting in `problems` a node type this module does not know. */
function childKeys(node: Node, problems: string[]): readonly string[] {
  const known = VISITOR_KEYS[node.type];
  if (!known) problems.push(`The parser produced a node of type ${node.type} that this module does not know how to read.`);
  const keys = known ?? [];
  // TSParameterProperty holds decorators that its visitor keys leave out.
  return hasDecorators(node) && !keys.includes("decorators") ? [...keys, "decorators"] : keys;
}

/** The `owner` and `outer` of a child found under `key`, where `fn` is the node's own measurement when it is a function. */
function childScope(visit: Visit, fn: Measured | null, key: string): Pick<Visit, "owner" | "outer"> {
  // A decorator runs where the class is defined, so its branches belong to the code around the method or parameter.
  const owner = key === "decorators" ? visit.outer : (fn ?? visit.owner);
  if (!fn) return { owner, outer: visit.outer };
  // Parameters, and what they hold, sit in the function's signature, so a decorator there runs in the code around it.
  return { owner, outer: key === "params" ? visit.owner : fn };
}

/**
 * Walks the tree, noting in `problems` anything it does not know how to walk. The walk itself uses no recursion, so a
 * deeply nested expression cannot overflow the stack here, although the parser has its own limit.
 */
function measureTree(path: string, program: Node, problems: string[]): Measured[] {
  const found: Measured[] = [];
  const language = languageOf(path);
  const work: Visit[] = [{ node: program, parent: null, owner: null, outer: null }];
  while (work.length > 0) {
    const visit = work.pop()!;
    const { node } = visit;
    const fn = isFunction(node) ? measuredFunction(path, language, visit, node) : null;
    if (fn) found.push(fn);
    else if (visit.owner && isDecision(node)) visit.owner.metrics.ccn += 1;
    for (const key of childKeys(node, problems)) {
      const scope = childScope(visit, fn, key);
      const value = (node as unknown as Record<string, unknown>)[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) work.push({ node: child, parent: visit, ...scope });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

interface Token {
  type: unknown;
  start: number;
  end: number;
  loc: { start: { line: number }; end: { line: number } };
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The lines a token puts code on. JSX text spans the whitespace between elements, so only its non-blank lines count. */
function codeLines(token: Token, source: string): number[] {
  const first = token.loc.start.line;
  if (token.type === tokTypes.jsxText) {
    return source
      .slice(token.start, token.end)
      .split(LINE_BREAK)
      .flatMap((text, i) => (text.trim() === "" ? [] : [first + i]));
  }
  return Array.from({ length: token.loc.end.line - first + 1 }, (_, i) => first + i);
}

/**
 * Comments and the end of the file put no code on a line. Comments arrive among the tokens as plain strings, and every
 * other token is an object from `tokTypes`, so any other string is a token this module does not know, noted in `problems`.
 */
function holdsCode(token: Token, problems: string[]): boolean {
  if (token.type === "CommentLine" || token.type === "CommentBlock" || token.type === tokTypes.eof) return false;
  if (typeof token.type !== "string") return true;
  problems.push(`The parser produced a token of type ${token.type} that this module does not know how to count.`);
  return false;
}

/**
 * Follows `functions`, sorted by where they start, through the source: each call takes a position no earlier than the
 * last and gives the innermost function open there, or null outside every function.
 */
function innermostAt(functions: readonly Measured[]): (position: number) => Measured | null {
  const open: Measured[] = [];
  let next = 0;
  const closeBefore = (position: number) => {
    while (open.length > 0 && open[open.length - 1]!.end <= position) open.pop();
  };
  return (position) => {
    while (next < functions.length && functions[next]!.start <= position) {
      const fn = functions[next++]!;
      closeBefore(fn.start);
      open.push(fn);
    }
    closeBefore(position);
    return open[open.length - 1] ?? null;
  };
}

/**
 * Lizard's line rule: a line counts once, to the innermost function holding its first code token, and every function
 * also counts its own start line, so `useEffect(() => {` counts for both the component and the callback.
 */
function countLines(functions: Measured[], tokens: readonly Token[], source: string, problems: string[]): void {
  const owners = new Map<number, Measured | null>();
  const ownerAt = innermostAt(functions);
  for (const token of tokens) {
    if (!holdsCode(token, problems)) continue;
    const owner = ownerAt(token.start);
    for (const line of codeLines(token, source)) {
      if (owners.has(line)) continue;
      owners.set(line, owner);
      if (owner) owner.lines += 1;
    }
  }
  for (const fn of functions) {
    fn.metrics.nloc = fn.lines + (owners.get(fn.metrics.startLine) === fn ? 0 : 1);
  }
}

type Parsed = ReturnType<typeof parse>;

/** One attempt at reading a file: its tree with tokens (null when the parser gave up), how many errors it recovered from, and why. */
interface Reading {
  file: Parsed | null;
  errors: number;
  problem: string | null;
}

/**
 * Parses with error recovery on, so a file with a few faults still yields a tree. A fault in the file, or nesting too
 * deep for the parser, is a result; anything else is a fault in this module or the parser's set-up and is rethrown.
 */
function parseWith(source: string, plugins: ParserPlugin[], sourceType: "unambiguous" | "script"): Reading {
  try {
    const file = parse(source, {
      sourceType,
      plugins,
      errorRecovery: true,
      tokens: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowUndeclaredExports: true,
      allowNewTargetOutsideFunction: true,
      allowSuperOutsideMethod: true,
    });
    const errors = file.errors ?? [];
    return { file, errors: errors.length, problem: errors[0]?.message ?? null };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (error instanceof SyntaxError && typeof code === "string" && code.startsWith("BABEL_PARSER_")) {
      return { file: null, errors: Infinity, problem: error.message };
    }
    if (error instanceof RangeError) {
      return { file: null, errors: Infinity, problem: "The code is nested too deeply for the parser to read." };
    }
    throw error;
  }
}

/**
 * Tries the readings in order and stops at the first with no errors, otherwise keeps the one with the fewest (the
 * earlier wins a tie). Unambiguous source type reads a file as a module and records strict-mode errors for sloppy
 * scripts (`with`, octal literals, duplicate parameters), so a script reading comes last.
 */
function readFile(path: string, source: string): Reading {
  const plugins = pluginsFor(path);
  const later: (() => Reading | null)[] = [
    // Standard decorators only differ from legacy ones in a file that has a decorator to read.
    () => (source.includes("@") ? parseWith(source, [...plugins, ...STANDARD_DECORATORS], "unambiguous") : null),
    () => parseWith(source, [...plugins, ...LEGACY_DECORATORS], "script"),
  ];
  let best = parseWith(source, [...plugins, ...LEGACY_DECORATORS], "unambiguous");
  for (const attempt of later) {
    if (best.errors === 0) break;
    const reading = attempt();
    if (reading && reading.errors < best.errors) best = reading;
  }
  return best;
}

/**
 * Measures every function in one JavaScript or TypeScript file from its syntax tree, with lizard's definitions of CCN,
 * NLOC and parameters (ADR 0025). It throws only for a fault in this module or the parser's set-up, such as clashing
 * plugins, and never because of what the file holds: a file the parser cannot read at all yields no functions and a
 * `problem` saying why.
 */
export function measureSource(path: string, source: string): SourceMeasurement {
  const { file, problem } = readFile(path, source);
  if (!file) return { functions: [], complete: false, problem };
  const problems: string[] = [];
  const functions = measureTree(path, file.program, problems);
  countLines(functions, (file.tokens ?? []) as Token[], source, problems);
  const found = problem ?? problems[0] ?? null;
  return {
    functions: functions.map((f) => f.metrics).sort((a, b) => a.startLine - b.startLine),
    complete: found === null,
    problem: found,
  };
}
