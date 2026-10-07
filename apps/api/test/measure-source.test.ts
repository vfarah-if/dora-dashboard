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
    // The filter callback is named after the value it computes, and shares line 2: 1 line, 1 + && = 2.
    expect(named("src/Panel.tsx", source, "visible")).toMatchObject({ startLine: 2, ccn: 2, nloc: 1, params: 1 });
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
    ["through parentheses and a type assertion", "src/a.ts", "const handler = (async () => 1) as Handler;", ["handler"]],
    ["through a constructor call", "src/a.ts", "const wrapped = new Promise((resolve) => resolve(1));", ["wrapped"]],
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
    expect(measureSource("src/a.ts", "const n = <number>value;").complete).toBe(true);
    expect(measureSource("src/a.tsx", "const n = <number>value;").complete).toBe(false);
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

  it("reads JSX in a .js file and Flow types in a file marked @flow", () => {
    expect(only("src/App.js", "export function App() { return <main />; }")).toMatchObject({
      name: "App",
      language: "JavaScript",
    });
    const flow = measureSource("src/typed.js", "// @flow\nfunction typed(a: number): string { return String(a); }");
    expect(flow).toMatchObject({ complete: true, functions: [{ name: "typed", startLine: 2 }] });
  });

  it("reads standard decorators as well as legacy ones such as parameter decorators", () => {
    const standard = measureSource("src/a.ts", "export @dec class A { @x accessor y = 1; m() { return 1; } }");
    expect(standard).toMatchObject({ complete: true, functions: [{ name: "m" }] });
    const legacy = measureSource("src/a.ts", "class C { constructor(@Inject(X) private x: X) {} }");
    expect(legacy).toMatchObject({ complete: true, functions: [{ name: "constructor", params: 1 }] });
  });

  it("keeps the first reading when the standard decorator syntax reads no better", () => {
    // Legacy decorators need the decorator before `export`; neither syntax reads the duplicate declaration.
    const result = measureSource("src/a.ts", "@dec export class A { m() { let a = 1; let a = 2; } }");
    expect(result).toMatchObject({ complete: false, functions: [{ name: "m" }] });
  });

  it("still measures a file it had to recover, and says it is not complete", () => {
    const result = measureSource("src/a.ts", "function first() { let a = 1; let a = 2; return a; }");
    expect(result).toMatchObject({ complete: false, functions: [{ name: "first" }] });
  });

  it("returns nothing, without throwing, for a file it cannot read at all", () => {
    expect(measureSource("src/a.ts", "function (")).toEqual({ functions: [], complete: false });
    // Deep enough to exhaust the parser's own stack.
    expect(measureSource("src/a.ts", `function deep(a) { return ${"(".repeat(5000)}a${")".repeat(5000)}; }`)).toEqual({
      functions: [],
      complete: false,
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
