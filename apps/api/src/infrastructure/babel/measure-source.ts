import { parse, type ParserPlugin } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";
import type { FunctionMetrics } from "@dora-dashboard/core";
import { languageOf } from "../analysis/languages.js";

/** What one file yielded. `complete` is false when the parser had to recover from an error, or gave up. */
export interface SourceMeasurement {
  functions: FunctionMetrics[];
  complete: boolean;
}

// `jsx` stays off for .ts, .mts and .cts, where `<T>value` is a type assertion rather than an element.
const PLUGINS: Record<string, ParserPlugin[]> = {
  ts: ["typescript"],
  mts: ["typescript"],
  cts: ["typescript"],
  tsx: ["typescript", "jsx"],
  // Flow syntax is read only in files that carry an @flow pragma, so plain JavaScript parses as the standard says.
  js: ["jsx", "flow"],
};

// Babel reads one decorator syntax at a time. Legacy decorators come first because TypeScript's parameter decorators
// exist only there; standard decorators (`export @dec class`, `accessor`) are the fallback for a file legacy cannot read.
const LEGACY_DECORATORS: ParserPlugin[] = ["decorators-legacy"];
const STANDARD_DECORATORS: ParserPlugin[] = ["decorators", "decoratorAutoAccessors"];

const pluginsFor = (path: string): ParserPlugin[] => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return PLUGINS[ext] ?? PLUGINS.js!;
};

type FunctionNode = Extract<
  Node,
  {
    type:
      | "FunctionDeclaration"
      | "FunctionExpression"
      | "ArrowFunctionExpression"
      | "ObjectMethod"
      | "ClassMethod"
      | "ClassPrivateMethod";
  }
>;

// Overload signatures, `declare function` and abstract methods are separate node types with no body, so they never match.
const FUNCTIONS = new Set<string>([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const isFunction = (node: Node): node is FunctionNode => FUNCTIONS.has(node.type);

// The decision points lizard's TypeScript reader counts (ADR 0025). `??` and the logical assignments count once each,
// where lizard counts them once or twice depending on spacing. Optional chaining, default values and `default:` never count.
const BRANCHES = new Set<string>([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
]);
const LOGICAL_OPERATORS = new Set<string>(["&&", "||", "??", "&&=", "||=", "??="]);

function isDecision(node: Node): boolean {
  if (BRANCHES.has(node.type)) return true;
  if (node.type === "SwitchCase") return node.test !== null && node.test !== undefined;
  if (node.type === "LogicalExpression" || node.type === "AssignmentExpression") return LOGICAL_OPERATORS.has(node.operator);
  return false;
}

/** A node on the walk, with the way back up for naming and the function its decision points count towards. */
interface Visit {
  node: Node;
  parent: Visit | null;
  owner: Measured | null;
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
const WRAPPERS = new Set<string>([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TypeCastExpression",
]);

const CALLS = new Set<string>(["CallExpression", "OptionalCallExpression", "NewExpression"]);

/** The name a parent gives the value `child`, or null when it gives none. */
function nameGivenBy(parent: Node, child: Node): string | null {
  switch (parent.type) {
    case "VariableDeclarator":
      return parent.init === child && parent.id.type === "Identifier" ? parent.id.name : null;
    case "ObjectProperty":
    case "ClassProperty":
    case "ClassPrivateProperty":
    case "ClassAccessorProperty":
      return parent.value === child ? keyName(parent.key, "computed" in parent && parent.computed === true) : null;
    case "AssignmentExpression":
      return parent.right === child ? targetName(parent.left) : null;
    case "AssignmentPattern":
      return parent.right === child ? targetName(parent.left) : null;
    case "ExportDefaultDeclaration":
      return "default";
    default:
      return null;
  }
}

/**
 * Names an unnamed function after what holds it, looking up through wrappers and any call it is passed into, so that
 * `const Card = memo(() => …)` is `Card`. Otherwise a function passed to a call is `<callee> callback`, one in a JSX
 * attribute takes the attribute's name, and anything else is `(anonymous)`, as lizard prints it.
 */
function inferredName(visit: Visit): string {
  let child = visit.node;
  let callee: string | null = null;
  for (let up = visit.parent; up; child = up.node, up = up.parent) {
    const parent = up.node;
    if (WRAPPERS.has(parent.type)) continue;
    if (CALLS.has(parent.type) && "callee" in parent) {
      if (parent.callee === child) break;
      callee ??= targetName(parent.callee);
      continue;
    }
    if (parent.type === "JSXExpressionContainer" && up.parent?.node.type === "JSXAttribute") {
      const attribute = up.parent.node.name;
      return attribute.type === "JSXIdentifier" ? attribute.name : `${attribute.namespace.name}:${attribute.name.name}`;
    }
    const name = nameGivenBy(parent, child);
    if (name !== null) return name;
    break;
  }
  return callee === null ? "(anonymous)" : `${callee} callback`;
}

function nameOf(visit: Visit & { node: FunctionNode }): string {
  const fn = visit.node;
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

/** Walks the tree without recursion, so a deeply nested expression cannot overflow the stack. */
function measureTree(path: string, program: Node): Measured[] {
  const found: Measured[] = [];
  const language = languageOf(path);
  const work: Visit[] = [{ node: program, parent: null, owner: null }];
  while (work.length > 0) {
    const visit = work.pop()!;
    const { node } = visit;
    let owner = visit.owner;
    if (isFunction(node)) {
      owner = {
        metrics: {
          file: path,
          language,
          name: nameOf(visit as Visit & { node: FunctionNode }),
          startLine: startLineOf(node),
          ccn: 1,
          nloc: 0,
          params: paramCount(node),
        },
        start: ownedFrom(node),
        end: node.end!,
        lines: 0,
      };
      found.push(owner);
    } else if (owner && isDecision(node)) {
      owner.metrics.ccn += 1;
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      // A decorator runs where the class is defined, so its branches belong to the code around the method.
      const childOwner = key === "decorators" ? visit.owner : owner;
      const value = (node as unknown as Record<string, unknown>)[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) work.push({ node: child, parent: visit, owner: childOwner });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

interface Token {
  type: string | { label: string };
  start: number;
  end: number;
  loc: { start: { line: number }; end: { line: number } };
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The lines a token puts code on. JSX text spans the whitespace between elements, so only its non-blank lines count. */
function codeLines(token: Token, source: string): number[] {
  const first = token.loc.start.line;
  if (typeof token.type === "object" && token.type.label === "jsxText") {
    return source
      .slice(token.start, token.end)
      .split(LINE_BREAK)
      .flatMap((text, i) => (text.trim() === "" ? [] : [first + i]));
  }
  return Array.from({ length: token.loc.end.line - first + 1 }, (_, i) => first + i);
}

/**
 * Lizard's line rule: a line counts once, to the innermost function holding its first code token, and every function
 * also counts its own start line, so `useEffect(() => {` counts for both the component and the callback.
 */
function countLines(functions: Measured[], tokens: readonly Token[], source: string): void {
  const owners = new Map<number, Measured | null>();
  const open: Measured[] = [];
  let next = 0;
  for (const token of tokens) {
    if (typeof token.type === "string" || token.type.label === "eof") continue;
    while (next < functions.length && functions[next]!.start <= token.start) {
      const fn = functions[next++]!;
      while (open.length > 0 && open[open.length - 1]!.end <= fn.start) open.pop();
      open.push(fn);
    }
    while (open.length > 0 && open[open.length - 1]!.end <= token.start) open.pop();
    const owner = open[open.length - 1] ?? null;
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

/** The file's syntax tree with tokens, or null when the parser gives up even with error recovery on. */
function parseWith(source: string, plugins: ParserPlugin[]): Parsed | null {
  try {
    return parse(source, {
      sourceType: "unambiguous",
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
  } catch {
    return null;
  }
}

const errorCount = (file: Parsed | null): number => (file ? (file.errors ?? []).length : Infinity);

/**
 * Measures every function in one JavaScript or TypeScript file from its syntax tree, with lizard's definitions of CCN,
 * NLOC and parameters (ADR 0025). Never throws: a file the parser cannot read at all yields no functions.
 */
export function measureSource(path: string, source: string): SourceMeasurement {
  let file = parseWith(source, [...pluginsFor(path), ...LEGACY_DECORATORS]);
  if (errorCount(file) > 0 && source.includes("@")) {
    const standard = parseWith(source, [...pluginsFor(path), ...STANDARD_DECORATORS]);
    if (errorCount(standard) < errorCount(file)) file = standard;
  }
  if (!file) return { functions: [], complete: false };
  const functions = measureTree(path, file.program);
  countLines(functions, (file.tokens ?? []) as Token[], source);
  return {
    functions: functions.map((f) => f.metrics).sort((a, b) => a.startLine - b.startLine),
    complete: errorCount(file) === 0,
  };
}
