import { describe, expect, it } from "vitest";
import { measureSource } from "../src/infrastructure/babel/measure-source.js";

const lines = (...source: string[]) => source.join("\n");

const only = (path: string, source: string) => {
  const { functions } = measureSource(path, source);
  expect(functions).toHaveLength(1);
  return functions[0]!;
};

const named = (path: string, source: string, name: string) => {
  const found = measureSource(path, source).functions.find((f) => f.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

describe("measureSource: decision points", () => {
  // Each body sits in `function f(a, b, c) { … }`, which scores 1 before any branch.
  it.each([
    ["if", "if (a) b();", 1],
    ["each else if", "if (a) b(); else if (c) b(); else c();", 2],
    ["for", "for (let i = 0; i < a; i++) b();", 1],
    ["for in", "for (const k in a) b();", 1],
    ["for of", "for (const x of a) b();", 1],
    ["while", "while (a) b();", 1],
    ["do while", "do { b(); } while (a);", 1],
    ["each case with a test, not default", "switch (a) { case 1: b(); break; case 2: c(); break; default: b(); }", 2],
    ["catch", "try { b(); } catch { c(); } finally { b(); }", 1],
    ["a ternary", "return a ? b : c;", 1],
    ["&&", "return a && b;", 1],
    ["||", "return a || b;", 1],
    ["?? once, where lizard counts two", "return a ?? b;", 1],
    ["&&=", "a &&= b;", 1],
    ["||=", "a ||= b;", 1],
    ["??=", "a ??= b;", 1],
    ["optional chaining, never", "return a?.b?.(c);", 0],
    ["a default value in a pattern, never", "const { x = 1 } = a;", 0],
    ["a conditional type, never", "type T = A extends B ? C : D;", 0],
    ["arithmetic and plain assignment, never", "a = b + c - b / c;", 0],
    ["compound assignments other than &&=, ||= and ??=, never", "a += b; a -= c; a *= 2; a **= 2; a <<= 1; a |= 1;", 0],
  ])("counts %s", (_label, body, branches) => {
    expect(only("src/a.ts", `function f(a, b, c) {\n  ${body}\n}`).ccn).toBe(1 + branches);
  });

  it("does not count a default parameter value", () => {
    expect(only("src/a.ts", "function f(a = b ? 1 : 2) {}").ccn).toBe(2);
    expect(only("src/a.ts", "function f(a = 1) {}").ccn).toBe(1);
  });

  it("counts a decorator's branches to the code around the method, not to the method", () => {
    const source = lines(
      "class Panel {",
      '  @HostListener("click", flag ? ["a"] : [])',
      "  onClick() {",
      "    if (this.v) go();",
      "  }",
      "}",
    );
    // CCN 1 + if = 2. Lines 3 to 5, with the decorator on line 2 left to the class.
    expect(only("src/panel.ts", source)).toMatchObject({ name: "onClick", startLine: 3, ccn: 2, nloc: 3 });
  });

  it("ignores branches outside any function", () => {
    expect(measureSource("src/a.ts", "if (a) b();\nconst c = a ? 1 : 2;").functions).toEqual([]);
  });
});

describe("measureSource: nested functions", () => {
  const source = lines(
    "export function Panel({ items, open }: Props) {",
    "  const visible = items.filter((item) => item.shown && open);",
    "  useEffect(() => {",
    "    if (open) track();",
    "  }, [open]);",
    "  return open ? visible : [];",
    "}",
  );

  it("keeps each callback's branches and lines out of the function around it", () => {
    // Panel: 1 + the ternary on line 6 = 2. Its lines are 1, 2, 3, 6 and 7, since lines 4 and 5 start inside the effect.
    expect(named("src/Panel.tsx", source, "Panel")).toMatchObject({ startLine: 1, ccn: 2, nloc: 5, params: 2 });
  });

  it("counts a callback's start line to it as well as to the line's owner, as lizard does", () => {
    // The effect starts on line 3, which Panel owns, so it counts line 3 plus lines 4 and 5: 3 lines, 1 + if = 2.
    expect(named("src/Panel.tsx", source, "useEffect callback")).toMatchObject({ startLine: 3, ccn: 2, nloc: 3, params: 0 });
    // The filter callback is a method's callback, so it is not named after the value `visible` it helps to compute. It
    // shares line 2: 1 line, 1 + && = 2.
    expect(named("src/Panel.tsx", source, "filter callback")).toMatchObject({ startLine: 2, ccn: 2, nloc: 1, params: 1 });
  });
});

describe("measureSource: a callback that starts on its own line", () => {
  it("gives the callback the lines from its first token, and the function around it the rest", () => {
    const source = lines("function outer() {", "  run(", "    () => {", "      go();", "    },", "  );", "}");
    const { functions } = measureSource("src/a.ts", source);

    // outer owns lines 1, 2, 6 and 7. The callback starts on line 3, which it owns outright, and holds lines 3 to 5.
    expect(functions.map((f) => [f.name, f.nloc])).toEqual([
      ["outer", 4],
      ["run callback", 3],
    ]);
  });
});

describe("measureSource: lines of code", () => {
  it("leaves out comments and blank lines, and counts every line a template literal spans", () => {
    const source = lines(
      "function render(name: string) {",
      "  // a comment line",
      "",
      "  /* a block",
      "     comment */",
      "  const text = `Hello",
      "",
      "${name}`;",
      "  return text; // trailing comment",
      "}",
    );
    // Lines 1, 6, 7, 8 (the template), 9 and 10.
    expect(only("src/render.ts", source).nloc).toBe(6);
  });

  it("counts only the lines of JSX text that hold text", () => {
    const source = lines("export function Card() {", "  return (", "    <div>", "", "      Hello", "    </div>", "  );", "}");
    // Every line but the blank line 4.
    expect(only("src/Card.tsx", source).nloc).toBe(7);
  });

  it("counts the same lines when the file uses Windows line endings", () => {
    const source = ["export function Card() {", "  return (", "    <div>", "", "      Hello", "    </div>", "  );", "}"].join(
      "\r\n",
    );
    // As above: every line but the blank line 4.
    expect(only("src/Card.tsx", source).nloc).toBe(7);
  });
});

describe("measureSource: parameters", () => {
  it.each([
    ["plain parameters", "function f(a, b, c) {}", 3],
    ["each name destructured from an object, as lizard counts them", "function f({ a, b, c }: P) {}", 3],
    ["each entry destructured from an array", "function f([a, b]: number[]) {}", 2],
    ["a destructured parameter with a default", "function f({ a, b } = {} as P) {}", 2],
    ["an empty pattern as one", "function f({}: P) {}", 1],
    ["only the top level of a nested pattern", "function f({ a: { b, c }, d }: P) {}", 2],
    ["defaults and a rest parameter", "function f(a = 1, ...rest: string[]) {}", 2],
    ["no TypeScript this parameter", "function f(this: Window, a: string) {}", 1],
    ["an arrow function's parameters, where lizard reports none", "const f = ({ label, value }: P) => label;", 2],
    ["an array pattern's hole as nothing", "function f([, b]) {}", 1],
    ["an empty array pattern as one", "function f([]) {}", 1],
    ["a rest element beside names in an object pattern", "function f({ a, ...others }) {}", 2],
    ["a rest parameter holding an array pattern as one", "function f(...[a, b]) {}", 1],
    ["constructor parameter properties", "class K { constructor(private readonly a: string, public b: number) {} }", 2],
  ])("counts %s", (_label, source, params) => {
    expect(only("src/a.ts", source).params).toBe(params);
  });
});

describe("measureSource: names", () => {
  it.each([
    ["a declaration by its name", "src/a.ts", "function plain() {}", ["plain"]],
    ["a named function expression by its own name", "src/a.ts", "const fn = function named() {};", ["named"]],
    [
      "a component wrapped in calls by the constant",
      "src/a.tsx",
      "const Card = memo(forwardRef((props, ref) => null));",
      ["Card"],
    ],
    ["a memoised callback by the constant", "src/a.ts", "const onSave = useCallback(() => save(), []);", ["onSave"]],
    ["a component memoised through a namespace by the constant", "src/a.tsx", "const Card = React.memo(() => null);", ["Card"]],
    [
      "a reduce callback after the method, not after the total it computes",
      "src/a.ts",
      "const total = items.reduce((s, i) => s + i, 0);",
      ["reduce callback"],
    ],
    [
      "each callback in a chain after its own method",
      "src/a.ts",
      "const r = a.map((x) => x).filter((y) => y);",
      ["map callback", "filter callback"],
    ],
    [
      "a constructor's callback after the class, not after the object it builds",
      "src/a.ts",
      "const p = new Promise((resolve) => resolve(1));",
      ["Promise callback"],
    ],
    [
      "a callback to a plain function by the constant, since a plain function is taken to return its argument",
      "src/a.ts",
      "const id = setTimeout(() => tick(), 1000);",
      ["id"],
    ],
    [
      "a function wrapped by a plain call inside a method call after the innermost callee",
      "src/a.ts",
      "items.forEach(debounce(() => 1));",
      ["debounce callback"],
    ],
    [
      "a callback to a lower-case namespace member after the method",
      "src/a.ts",
      "const task = api.run(() => 1);",
      ["run callback"],
    ],
    [
      "a callback to a computed member of a namespace as anonymous",
      "src/a.ts",
      "const task = React[name](() => 1);",
      ["(anonymous)"],
    ],
    ["through parentheses and a type assertion", "src/a.ts", "const handler = (async () => 1) as Handler;", ["handler"]],
    [
      "by the right-most name assigned to",
      "src/a.js",
      "exports.run = function () {};\nthis.handle = () => 1;",
      ["run", "handle"],
    ],
    ["by a private field assigned to", "src/a.ts", "class K { #h; constructor() { this.#h = () => 1; } }", ["constructor", "#h"]],
    ["a default export as default", "src/a.ts", "export default () => null;", ["default"]],
    ["an anonymous default declaration as default", "src/a.ts", "export default function () {}", ["default"]],
    ["a default parameter by the parameter", "src/a.ts", "function outer(callback = () => 1) {}", ["outer", "callback"]],
    [
      "object members by their keys",
      "src/a.ts",
      'const api = { load() {}, save: () => 1, ["x" + y]: () => 2, "quoted-key": function () {} };',
      ["load", "save", "(computed)", "quoted-key"],
    ],
    [
      "class members by their bare names, keeping # on a private one",
      "src/a.ts",
      "class Store { constructor() {} get size() { return 1; } #reset() {} static create = () => new Store(); }",
      ["constructor", "size", "#reset", "create"],
    ],
    [
      "a callback after its callee",
      "src/a.ts",
      "useEffect(() => {});\nitems.map((item) => item.id);",
      ["useEffect callback", "map callback"],
    ],
    ["a callback to a constructor after the class", "src/a.ts", "new Thing(() => 1);", ["Thing callback"]],
    ["a JSX handler after its attribute", "src/a.tsx", "<button onClick={() => go()} />;", ["onClick"]],
    ["a function called where it is written as anonymous", "src/a.ts", "(() => 1)();", ["(anonymous)"]],
    [
      "a computed target or callee as anonymous",
      "src/a.ts",
      "handlers[key] = () => 1;\nfactory()(() => 2);",
      ["(anonymous)", "(anonymous)"],
    ],
    [
      "a function called where it is written, inside a declaration, as anonymous",
      "src/a.ts",
      "const value = (() => compute())();",
      ["(anonymous)"],
    ],
    ["a callback through optional chaining after the method", "src/a.ts", "items?.map((x) => x);", ["map callback"]],
    [
      "a function through satisfies, a non-null assertion and an angle-bracket assertion by the constant",
      "src/a.ts",
      "const a = (() => 1) satisfies F;\nconst b = (() => 2)!;\nconst c = <F>(() => 3);",
      ["a", "b", "c"],
    ],
    ["a function through a Flow type cast by the constant", "src/a.js", "// @flow\nconst e = ((() => 1): F);", ["e"]],
    ["a private class field by its name with the #", "src/a.ts", "class K { #onClick = () => 1; }", ["#onClick"]],
    [
      "a numeric key by its number and a computed key of either kind as computed",
      "src/a.ts",
      "const o = { 1: () => 1, [key]: () => 2 };\nclass K { [key]() {} }",
      ["1", "(computed)", "(computed)"],
    ],
    ["a JSX handler in a namespaced attribute after both parts", "src/a.tsx", "<svg xlink:href={() => 1} />;", ["xlink:href"]],
    [
      "a function returned from a named function as anonymous, since the walk stops at a parent that names nothing",
      "src/a.ts",
      "const make = () => {\n  return () => 1;\n};",
      ["make", "(anonymous)"],
    ],
    [
      "a function child in JSX as anonymous, not after the component or the attribute around it",
      "src/a.tsx",
      "function Page() {\n  return <List>{(item) => <li />}</List>;\n}",
      ["Page", "(anonymous)"],
    ],
    ["functions in an array as anonymous", "src/a.ts", "const [a, b] = [() => 1, () => 2];", ["(anonymous)", "(anonymous)"]],
  ])("names %s", (_label, path, source, names) => {
    expect(measureSource(path, source).functions.map((f) => f.name)).toEqual(names);
  });

  it("starts a method at its name and an arrow at its first token", () => {
    const source = lines(
      "class Store {",
      "  @Memo()",
      "  total() {",
      "    return 1;",
      "  }",
      "}",
      "const sum =",
      "  (a, b) => a + b;",
    );
    expect(measureSource("src/a.ts", source).functions.map((f) => [f.name, f.startLine])).toEqual([
      ["total", 3],
      ["sum", 8],
    ]);
  });
});

describe("measureSource: what counts as a function", () => {
  it("leaves out overload signatures, ambient declarations, abstract methods and types", () => {
    const source = lines(
      "declare function ambient(a: string): void;",
      "function over(a: string): void;",
      "function over(a: number): void;",
      "function over(a: unknown) { return a; }",
      "abstract class Shape { abstract area(): number; perimeter() { return 0; } }",
      "interface Api { load(): void; run: () => void }",
      "type Fn = (a: string) => void;",
    );
    expect(measureSource("src/a.ts", source).functions.map((f) => f.name)).toEqual(["over", "perimeter"]);
  });
});

describe("measureSource: files lizard misreads", () => {
  it("keeps a component with a JSX spread and a generic object type apart from the next one", () => {
    const source = lines(
      "export const Tile: React.FC<{ file: File }> = ({ file }) => {",
      '  const label = file.name || "untitled";',
      "  return <div {...props} title={label}>{file.size > 0 ? label : null}</div>;",
      "};",
      "",
      "export function Grid({ files }: { files: File[] }) {",
      "  if (files.length === 0) return null;",
      "  return <section>{files.map((file) => <Tile key={file.id} file={file} />)}</section>;",
      "}",
    );
    const { functions, complete } = measureSource("src/Grid.tsx", source);
    expect(complete).toBe(true);
    expect(functions).toEqual([
      // 1 + || + the ternary = 3, over lines 1 to 4.
      { file: "src/Grid.tsx", language: "TypeScript", name: "Tile", startLine: 1, ccn: 3, nloc: 4, params: 1 },
      // 1 + if = 2, over lines 6 to 9.
      { file: "src/Grid.tsx", language: "TypeScript", name: "Grid", startLine: 6, ccn: 2, nloc: 4, params: 1 },
      { file: "src/Grid.tsx", language: "TypeScript", name: "map callback", startLine: 8, ccn: 1, nloc: 1, params: 1 },
    ]);
  });

  it("ends a function at its closing brace when it divides", () => {
    // Lizard ends this at line 3, reading the division as the start of a regular expression, and misses the ternary.
    const source = lines(
      "export function hours(from: string | null, to: string | null): number | null {",
      "  if (!from || !to) return null;",
      "  const delta = (Date.parse(to) - Date.parse(from)) / HOUR;",
      "  return Number.isFinite(delta) ? delta : null;",
      "}",
    );
    // 1 + if + || + the ternary = 4, over all 5 lines.
    expect(only("src/stats.ts", source)).toMatchObject({ ccn: 4, nloc: 5, params: 2 });
  });
});

describe("measureSource: parsing", () => {
  it("reads <T>value in a .ts file as a type assertion", () => {
    expect(measureSource("src/a.ts", "const n = <number>value;")).toMatchObject({ complete: true, problem: null });
    expect(measureSource("src/a.tsx", "const n = <number>value;").complete).toBe(false);
  });

  it.each([["src/a.mts"], ["src/a.cts"], ["src/A.TS"]])("reads <T>value as a type assertion in %s", (path) => {
    const result = measureSource(path, "function f(value) { const n = <number>value; return n; }");

    expect(result).toMatchObject({ complete: true, problem: null, functions: [{ name: "f" }] });
  });

  it("reads a Flow maybe type in a .js file", () => {
    const result = measureSource("src/a.js", "// @flow\nfunction f(x: ?string) { return x; }");

    expect(result).toMatchObject({ complete: true, problem: null, functions: [{ name: "f", params: 1 }] });
  });

  it.each([
    ["src/a.mts", "TypeScript"],
    ["src/a.cts", "TypeScript"],
    ["src/a.jsx", "JavaScript"],
    ["src/a.mjs", "JavaScript"],
    ["src/a.cjs", "JavaScript"],
  ])("measures %s as %s", (path, language) => {
    expect(only(path, "export function f() { return 1; }").language).toBe(language);
  });

  it("reads JSX in a .js file and Flow types in a .js file, with or without the @flow pragma", () => {
    expect(only("src/App.js", "export function App() { return <main />; }")).toMatchObject({
      name: "App",
      language: "JavaScript",
    });
    const flow = measureSource("src/typed.js", "// @flow\nfunction typed(a: number): string { return String(a); }");
    expect(flow).toMatchObject({ complete: true, functions: [{ name: "typed", startLine: 2 }] });
    // The pragma only changes how `f<T>(x)` reads, so annotations are read without it.
    const unmarked = measureSource("src/typed.mjs", "function typed(a: number): string { return String(a); }");
    expect(unmarked).toMatchObject({ complete: true, problem: null, functions: [{ name: "typed", startLine: 1 }] });
  });

  it("reads standard decorators as well as legacy ones such as parameter decorators", () => {
    const standard = measureSource("src/a.ts", "export @dec class A { @x accessor y = 1; m() { return 1; } }");
    expect(standard).toMatchObject({ complete: true, functions: [{ name: "m" }] });
    const legacy = measureSource("src/a.ts", "class C { constructor(@Inject(X) private x: X) {} }");
    expect(legacy).toMatchObject({ complete: true, functions: [{ name: "constructor", params: 1 }] });
  });

  it("still measures a decorated file that no reading can read without an error", () => {
    // Legacy decorators need the decorator before `export`; neither syntax reads the duplicate declaration.
    const result = measureSource("src/a.ts", "@dec export class A { m() { let a = 1; let a = 2; } }");
    expect(result).toMatchObject({ complete: false, functions: [{ name: "m" }] });
  });

  it("keeps the first reading, with its problem, when a later reading finds as many errors", () => {
    // The module reading finds one error: `with` in strict mode. The script reading finds one as well, `import.meta`,
    // and the string holding an @ makes the standard decorator reading run too, so every reading is tried. The tie
    // goes to the first.
    const source = 'export const tag = "@";\nfunction f(a) { with (a) {} }\nconst url = import.meta.url;';

    expect(measureSource("src/a.ts", source)).toMatchObject({
      complete: false,
      problem: "'with' in strict mode. (2:16)",
      functions: [{ name: "f" }],
    });
  });

  it("still measures a file it had to recover, and says it is not complete", () => {
    const result = measureSource("src/a.ts", "function first() { let a = 1; let a = 2; return a; }");
    expect(result).toMatchObject({
      complete: false,
      // The first error the parser recovered from, with the line and column of the second `a`.
      problem: "Identifier 'a' has already been declared. (1:34)",
      functions: [{ name: "first" }],
    });
  });

  it("returns nothing, without throwing, for a file it cannot read at all", () => {
    expect(measureSource("src/a.ts", "function (")).toEqual({
      functions: [],
      complete: false,
      problem: "Unexpected token (1:9)",
    });
    // Deep enough to exhaust the parser's own stack.
    expect(measureSource("src/a.ts", `function deep(a) { return ${"(".repeat(5000)}a${")".repeat(5000)}; }`)).toEqual({
      functions: [],
      complete: false,
      problem: "The code is nested too deeply for the parser to read.",
    });
  });

  it("lists functions in the order they start", () => {
    const source = "function late() {}\nfunction early() { return () => 1; }";
    expect(measureSource("src/a.ts", source).functions.map((f) => [f.name, f.startLine])).toEqual([
      ["late", 1],
      ["early", 2],
      ["(anonymous)", 2],
    ]);
  });
});

describe("measureSource: scripts that are not strict", () => {
  it.each([
    ["with", "with (a) {}"],
    ["an octal literal", "var x = 010;"],
    ["duplicate parameter names", "function g(a, a) {}"],
    ["delete of a bare name", "delete x;"],
    ["yield as a name", "var yield = 1;"],
  ])("reads %s in a file with no import or export as a complete script", (_label, statement) => {
    const result = measureSource("src/legacy.js", `function f(a) {\n  ${statement}\n}`);

    expect(result).toMatchObject({ complete: true, problem: null });
    expect(result.functions[0]).toMatchObject({ name: "f", startLine: 1 });
  });

  it("reads the same constructs in a TypeScript file", () => {
    expect(measureSource("src/legacy.ts", "function f(a) { with (a) {} }")).toMatchObject({ complete: true });
  });
});

describe("measureSource: decorators", () => {
  it("reads an auto accessor next to a method", () => {
    const source = lines("class Store {", "  accessor count = 0;", "  increment() {", "    this.count += 1;", "  }", "}");

    // Lines 3 to 5, and no decision points.
    expect(measureSource("src/store.ts", source)).toMatchObject({
      complete: true,
      functions: [{ name: "increment", startLine: 3, ccn: 1, nloc: 3 }],
    });
  });

  it("starts a method after all of its stacked decorators", () => {
    const source = lines("class Api {", "  @Get()", "  @UseGuards(AuthGuard)", "  list() {", "    return [];", "  }", "}");

    // The method owns lines 4 to 6: its name, the return and the closing brace.
    expect(only("src/api.ts", source)).toMatchObject({ name: "list", startLine: 4, nloc: 3 });
  });

  it("reads parameter decorators and a decorated accessor in one file", () => {
    const source = "class C { @dec accessor v = 1; constructor(@Inject(X) private x: X) {} }";

    expect(measureSource("src/c.ts", source)).toMatchObject({ complete: true, functions: [{ name: "constructor", params: 1 }] });
  });

  it("counts a parameter decorator's branches to the code around the method, not to the method", () => {
    expect(only("src/a.ts", "class C { m(@Arg(flag ? 1 : 2) x) {} }")).toMatchObject({ name: "m", ccn: 1 });
  });

  it("counts a decorator on a member of a class inside a function to that function", () => {
    const source = lines(
      "function build(flag) {",
      "  class C {",
      "    @Dec(flag ? 1 : 2) field = 1;",
      "    @Dec(flag ? 3 : 4) method() {}",
      "    other(@Arg(flag ? 5 : 6) x) {}",
      "  }",
      "}",
    );
    const byName = (name: string) => named("src/a.ts", source, name).ccn;

    // build: 1 + one ternary for each of the three decorators. The methods hold none of them.
    expect([byName("build"), byName("method"), byName("other")]).toEqual([4, 1, 1]);
  });

  it("walks the decorators of a constructor parameter property, which the visitor keys leave out", () => {
    const source = "class Cats { constructor(@Inject(forwardRef(() => Dogs)) private dogs: Dogs) {} }";

    expect(measureSource("src/cats.ts", source).functions.map((f) => f.name)).toEqual(["constructor", "forwardRef callback"]);
  });
});
