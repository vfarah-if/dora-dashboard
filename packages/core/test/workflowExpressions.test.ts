import { describe, expect, it } from "vitest";
import {
  EventNames,
  MAX_DEPTH,
  MAX_EXPRESSION,
  MAX_TOKENS,
  Opaque,
  UNKNOWN,
  conditionTruth,
  conditionTruths,
  evaluate,
  parseExpression,
  truthOf,
  usesStatusFunction,
  type Outcome,
  type Scope,
  type Value,
} from "../src/workflowExpressions.js";

const FORK_HEADED = ["pull_request", "pull_request_review", "pull_request_review_comment"];
const OWNER_ONLY = ["push", "schedule", "workflow_dispatch", "repository_dispatch", "merge_group"];

/** A scope with a few facts. Anything not listed, `inputs.x` included, is not known. */
const FACTS: Record<string, Value> = {
  "github.event_name": "workflow_run",
  "github.commits.0.message": "hello",
  "github.event.workflow_run.event": "push",
  "github.repository": new Opaque("base-repo"),
  "github.head": new Opaque("fork-repo"),
  "github.owner": new Opaque("base-owner"),
  // One of the three pull request events; any event but those three and the five an outsider cannot cause; push alone.
  "github.fork_event": new EventNames(FORK_HEADED),
  "github.base_event": new EventNames([...FORK_HEADED, ...OWNER_ONLY], true),
  "github.only_event": new EventNames(["push"]),
};

const scopeOf = (success: Outcome = UNKNOWN): Scope => ({
  lookup: (path) => {
    const value = FACTS[path.join(".")];
    return value === undefined ? UNKNOWN : { known: true, value };
  },
  success: () => success,
});

const read = (text: string, scope: Scope = scopeOf()): Outcome => {
  const expr = parseExpression(text);
  if (!expr) throw new Error(`unreadable: ${text}`);
  return evaluate(expr, scope);
};
const truth = (text: string) => truthOf(read(text));
/** The value when known, and the word `unknown` when not. */
const value = (text: string): Value | "unknown" => {
  const outcome = read(text);
  return outcome.known ? outcome.value : "unknown";
};

describe("Kleene logic over true, false and an unknown value", () => {
  const operands = ["true", "false", "inputs.x"];
  // Rows are the answers a person worked out: the left operand down, the right operand across.
  const AND: (boolean | null)[][] = [
    [true, false, null],
    [false, false, false],
    [null, false, null],
  ];
  const OR: (boolean | null)[][] = [
    [true, true, true],
    [true, false, null],
    // unknown || true is true, while unknown || false and unknown || unknown are not known
    [true, null, null],
  ];

  it.each(operands.flatMap((a, i) => operands.map((b, j) => [a, b, AND[i]![j]!] as const)))(
    "%s && %s is %s",
    (a, b, expected) => {
      expect(truth(`${a} && ${b}`)).toBe(expected);
    },
  );

  it.each(operands.flatMap((a, i) => operands.map((b, j) => [a, b, OR[i]![j]!] as const)))("%s || %s is %s", (a, b, expected) => {
    expect(truth(`${a} || ${b}`)).toBe(expected);
  });

  it.each([
    ["true", false],
    ["false", true],
    ["inputs.x", null],
  ])("!%s is %s", (operand, expected) => {
    expect(truth(`!${operand}`)).toBe(expected);
  });

  it("returns an operand, as GitHub does", () => {
    expect(value("'' || 'x'")).toBe("x");
    expect(value("0 && inputs.x")).toBe(0);
    expect(value("'a' && 'b'")).toBe("b");
    expect(value("null || false")).toBe(false);
  });

  it("knows the truthiness of an unknown value that falls back on a literal", () => {
    const outcome = read("inputs.x || 'y'");
    expect(outcome).toEqual({ known: false, truthy: true });
    expect(truth("!(inputs.x || 'y')")).toBe(false);
    expect(read("inputs.x && ''")).toEqual({ known: false, truthy: false });
  });

  it("folds a chain of several operands", () => {
    expect(truth("inputs.x && true && false")).toBe(false);
    expect(truth("inputs.x && true && true")).toBeNull();
    expect(truth("false || inputs.x || true")).toBe(true);
    expect(truth("false || false || false")).toBe(false);
  });

  it("does not look at the right operand once the left decides", () => {
    expect(truth("false && nonsense.at.all")).toBe(false);
    expect(truth("true || nonsense.at.all")).toBe(true);
  });
});

describe("truthiness", () => {
  it.each([
    [0, false],
    [-0, false],
    [Number.NaN, false],
    ["", false],
    [null, false],
    [false, false],
    [1, true],
    ["0", true],
    ["false", true],
    [[], true],
    [{}, true],
    [new Opaque("base-id"), true],
    [new EventNames(["push"]), true],
    [new EventNames(["push"], true), true],
  ] as [Value, boolean][])("%j is %s", (v, expected) => {
    expect(truthOf({ known: true, value: v })).toBe(expected);
  });

  it("reads the truthiness an unknown value carries", () => {
    expect(truthOf({ known: false, truthy: true })).toBe(true);
    expect(truthOf(UNKNOWN)).toBeNull();
  });
});

describe("comparisons", () => {
  it.each([
    ["'Push' == 'push'", true],
    ["'a' != 'b'", true],
    ["'a' != 'A'", false],
    ["null == 0", true],
    ["true == 1", true],
    ["false == 0", true],
    ["'1' == 1", true],
    ["'' == 0", true],
    ["'' == null", true],
    ["'1.5' == 1.5", true],
    ["'abc' == 0", false],
    ["'abc' != 0", true],
    ["1e2 == 100", true],
    ["-1 < 0", true],
    ["'x' < 1", false],
    ["'x' >= 1", false],
    ["1 < 2", true],
    ["1 <= 1", true],
    ["2 > 1", true],
    ["1 >= 2", false],
    ["true > 0", true],
    ["null < 1", true],
    ["'ä' == 'ä'", true],
  ])("%s is %s", (text, expected) => {
    expect(truth(text)).toBe(expected);
  });

  it.each([
    ["' 1' == 1"],
    ["'1 ' != 1"],
    ["'a' < 'b'"],
    ["'a' == 'ä'"],
    ["fromJSON('[1]') == fromJSON('[1]')"],
    ["fromJSON('{}') != fromJSON('{}')"],
    ["fromJSON('[1]') < 2"],
    ["inputs.x == 'a'"],
    ["'a' == inputs.x"],
    ["inputs.x < 1"],
    ["github.repository < github.repository"],
    // The runner reads more forms as numbers than JSON does, so these cannot be taken as NaN.
    ["'0x10' == 16"],
    ["'+1' == 1"],
    ["'1.' == 1"],
    ["'.5' == 0.5"],
    ["'1_0' == 10"],
    ["'Infinity' == 1"],
    ["'-Infinity' < 0"],
    ["'NaN' == 0"],
    ["'nan' != 1"],
    ["'1abc' == 1"],
    // The runner may trim a string before it reads it as a number, so a space or a tab around it is not known either.
    ["' ' == 0"],
    ["' Infinity' > 1"],
    ["'\t' == false"],
  ])("%s is not known", (text) => {
    expect(truth(text)).toBeNull();
  });

  it.each([
    ["'abc' == 0", false],
    ["'-' == 0", false],
    ["'info' < 1", false],
    ["'x' != 1", true],
  ])("%s stays %s for a string with no numeric look", (text, expected) => {
    expect(truth(text)).toBe(expected);
  });

  it("compares an identity by name and nothing else", () => {
    expect(truth("github.head == github.repository")).toBe(false);
    expect(truth("github.repository == github.repository")).toBe(true);
    expect(truth("github.repository != github.head")).toBe(true);
    expect(truth("github.repository == 'acme/widgets'")).toBeNull();
    expect(truth("'acme/widgets' == github.repository")).toBeNull();
    expect(truth('github.repository == fromJSON(\'{"name":"base-repo"}\')')).toBeNull();
    expect(truth("github.owner == github.repository")).toBe(false);
  });

  it("does not let parsed text pass for an identity", () => {
    expect(truth('fromJSON(\'{"name":"base-repo"}\') == fromJSON(\'{"name":"base-repo"}\')')).toBeNull();
  });

  it.each([
    // One of three names: false for a name outside them, never true, and unknown for any of the three.
    ["github.fork_event == 'push'", false],
    ["github.fork_event == 'issue_comment'", false],
    ["'pull_request_target' == github.fork_event", false],
    ["github.fork_event != 'issue_comment'", true],
    ["github.fork_event == 'pull_request'", null],
    ["github.fork_event == 'PULL_REQUEST_REVIEW'", null],
    ["github.fork_event != 'pull_request'", null],
    // Any name but eight: false for each of the eight, in any case, and unknown for every other name.
    ["github.base_event == 'push'", false],
    ["github.base_event == 'Merge_Group'", false],
    ["github.base_event == 'pull_request_review_comment'", false],
    ["github.base_event != 'schedule'", true],
    ["github.base_event == 'issue_comment'", null],
    ["github.base_event == 'pull_request_target'", null],
    ["github.base_event != 'workflow_run'", null],
    // A set of one name is true for that name.
    ["github.only_event == 'Push'", true],
    ["github.only_event != 'push'", false],
    ["github.only_event == 'pull_request'", false],
  ])("compares an event name known as one of a set: %s is %s", (text, expected) => {
    expect(truth(text)).toBe(expected);
  });

  it.each([
    // A dotless ı folds to I in some readings, so a name that is not ASCII is never judged.
    ["github.fork_event == 'pull_request_revıew'"],
    ["github.fork_event == 0"],
    ["0 == github.fork_event"],
    ["github.fork_event == null"],
    ["github.fork_event == true"],
    ["github.fork_event == github.fork_event"],
    ["github.only_event == github.only_event"],
    ["github.fork_event == github.repository"],
    ["github.fork_event < 1"],
    ["contains(fromJSON('[\"push\"]'), github.fork_event)"],
    ["contains(github.fork_event, 'pull')"],
    ["startsWith(github.fork_event, 'pull')"],
    ["endsWith(github.base_event, 'comment')"],
    ["format('{0}', github.only_event) == 'push'"],
    ["toJSON(github.only_event) == '\"push\"'"],
    ["fromJSON(github.only_event)"],
    ["fromJSON('{\"names\":[\"push\"]}') == 'push'"],
  ])("does not know %s, which compares an event name with something other than a string", (text) => {
    expect(truth(text)).toBeNull();
  });

  it("holds an event name known as one of a set to be truthy", () => {
    expect(truth("github.fork_event")).toBe(true);
    expect(truth("!github.base_event")).toBe(false);
    expect(truth("(github.fork_event || 'x') == 'push'")).toBe(false);
  });

  it("cannot see that ruling out each of the three pull request events in turn rules them all out", () => {
    const each = FORK_HEADED.map((name) => `github.fork_event != '${name}'`).join(" && ");
    expect(truth(each)).toBeNull();
  });

  it("binds a comparison tighter than && and ! tighter than a comparison", () => {
    expect(truth("1 == 1 && 2 == 3")).toBe(false);
    expect(truth("!true == false")).toBe(true);
    expect(truth("1 < 2 == true")).toBe(true);
    expect(truth("true || false && false")).toBe(true);
  });
});

describe("functions", () => {
  it.each([
    ["contains('Hello World', 'WORLD')", true],
    ["contains('Hello', 'xyz')", false],
    ["contains('a1', 1)", true],
    ["contains('abc', 1)", false],
    ["contains(fromJSON('[\"push\",\"schedule\"]'), 'PUSH')", true],
    ["contains(fromJSON('[\"push\"]'), 'pull_request')", false],
    ["contains(fromJSON('[1,2]'), '2')", true],
    ["startsWith('Hello', 'he')", true],
    ["startsWith('Hello', 'lo')", false],
    ["startsWith(1, '1')", true],
    ["startsWith(null, '')", true],
    ["startsWith(true, 'T')", true],
    ["endsWith('Hello', 'LO')", true],
    ["endsWith('Hello', 'he')", false],
    ["always()", true],
  ])("%s is %s", (text, expected) => {
    expect(truth(text)).toBe(expected);
  });

  it.each([
    ["contains('ä', 'a')"],
    ["contains(fromJSON('[{}]'), 'x')"],
    ["contains(fromJSON('{}'), 'x')"],
    ["contains('a')"],
    ["contains(inputs.x, 'a')"],
    ["startsWith(1.5, '1')"],
    ["startsWith('a')"],
    ["endsWith('a')"],
    ["format('{1}', 'a')"],
    ["format('{0', 'a')"],
    ["format('}', 'a')"],
    ["format('{x}', 'a')"],
    ["format(1)"],
    ["format('{0}', fromJSON('[1]'))"],
    ["toJSON(fromJSON('[1]'))"],
    ["toJSON('a', 'b')"],
    ["fromJSON('nope')"],
    ["fromJSON(1)"],
    ["fromJSON('1', '2')"],
    ["hashFiles('x')"],
    ["always(1)"],
    ["success(1)"],
    ["failure()"],
    ["cancelled()"],
    ["failure(1)"],
  ])("%s is not known", (text) => {
    expect(read(text).known).toBe(false);
  });

  it("formats with indexes and escaped braces", () => {
    expect(value("format('{0}-{{', 'a')")).toBe("a-{");
    expect(value("format('}}{0}{1}{0}', 'a', 1)")).toBe("}a1a");
    expect(value("format('{0}{1}', true, null)")).toBe("true");
  });

  it("renders and parses JSON for scalars", () => {
    expect(value("toJSON('a')")).toBe('"a"');
    expect(value("toJSON(null)")).toBe("null");
    expect(value("toJSON(2)")).toBe("2");
    expect(value("fromJSON('7')")).toBe(7);
  });

  it("takes success() from the scope and the other status functions as not known", () => {
    const expr = parseExpression("success()")!;
    expect(evaluate(expr, scopeOf({ known: true, value: false }))).toEqual({ known: true, value: false });
    expect(evaluate(expr, scopeOf())).toEqual(UNKNOWN);
  });
});

describe("contexts and access", () => {
  it("reads the same fact however it is spelled", () => {
    expect(value("github.event_name")).toBe("workflow_run");
    expect(value("GITHUB.EVENT_NAME")).toBe("workflow_run");
    expect(value("github['event_name']")).toBe("workflow_run");
    expect(value("github[ 'EVENT_NAME' ]")).toBe("workflow_run");
    expect(value("github.commits[0].message")).toBe("hello");
  });

  it("does not know a name that is not a fact", () => {
    expect(value("github.event.pull_request.labels.*.name")).toBe("unknown");
    expect(value("github")).toBe("unknown");
    expect(value("github[inputs.x]")).toBe("unknown");
    expect(value("github[github.event_name]")).toBe("unknown");
  });

  it("does not read an index that holds a dot as a path, because GitHub reads it as one key with a dot in it", () => {
    expect(value("github.event.workflow_run.event")).toBe("push");
    expect(value("github['event.workflow_run.event']")).toBe("unknown");
    expect(value("github['commits.0.message']")).toBe("unknown");
    expect(value("github.commits[0.5]")).toBe("unknown");
  });

  it("reads into a value it was given", () => {
    expect(value("fromJSON('[1,2]')[1]")).toBe(2);
    expect(value("fromJSON('[1,2]')[5]")).toBeNull();
    expect(value("fromJSON('[1,2]')[-1]")).toBe("unknown");
    expect(value("fromJSON('[1,2]')['a']")).toBe("unknown");
    expect(value("fromJSON('{\"Key\":5}').key")).toBe(5);
    expect(value("fromJSON('{\"Key\":5}')['KEY']")).toBe(5);
    expect(value("fromJSON('{\"a\":5}').b")).toBeNull();
    expect(value("fromJSON('[1,2]')[fromJSON('1')]")).toBe(2);
    expect(value("fromJSON('[1,2]')[inputs.x]")).toBe("unknown");
    expect(value("fromJSON('5').a")).toBe("unknown");
    expect(value("'abc'.length")).toBe("unknown");
  });

  it("treats a spelling of a literal other than lower case as a context", () => {
    expect(value("TRUE")).toBe("unknown");
    expect(value("Null")).toBe("unknown");
  });

  it("reads a hyphen in a name, which a job id such as check-ci needs", () => {
    expect(value("needs.check-ci.outputs.db-affected")).toBe("unknown");
    expect(parseExpression("needs.check-ci.result == 'success'")).not.toBeNull();
  });
});

describe("conditionTruth", () => {
  const isFalse = scopeOf({ known: true, value: false });
  const isTrue = scopeOf({ known: true, value: true });
  const truthIn = (text: string, scope: Scope) => conditionTruth(parseExpression(text)!, scope);

  it("adds success() when no status function appears", () => {
    expect(truthIn("true", isFalse)).toBe(false);
    expect(truthIn("true", isTrue)).toBe(true);
    expect(truthIn("true", scopeOf())).toBeNull();
    expect(truthIn("false", scopeOf())).toBe(false);
    expect(truthIn("inputs.x", isTrue)).toBeNull();
  });

  it("does not add it when a status function appears", () => {
    expect(truthIn("always()", isFalse)).toBe(true);
    expect(truthIn("!cancelled()", isFalse)).toBeNull();
    expect(truthIn("always() && github.event_name == 'push'", isFalse)).toBe(false);
    expect(truthIn("failure() || true", isFalse)).toBe(true);
    expect(truthIn("success()", isFalse)).toBe(false);
  });

  it("is not fooled by a status function named in a string", () => {
    expect(truthIn("'always()' == inputs.x", isFalse)).toBe(false);
  });

  it.each([
    // [condition, success(), truth as written, truth with the implicit success()]
    ["true", false, true, false],
    ["true", true, true, true],
    ["true", null, true, null],
    ["false", null, false, false],
    ["inputs.x", true, null, null],
    ["always()", false, true, true],
    ["success() && true", false, false, false],
  ] as const)("reads %s once, with success() %s, as %s and then %s", (text, success, own, full) => {
    const scope = scopeOf(success === null ? UNKNOWN : { known: true, value: success });
    expect(conditionTruths(parseExpression(text)!, scope)).toEqual({ own, full });
  });
});

describe("usesStatusFunction", () => {
  it.each([
    ["ALWAYS()", true],
    ["!cancelled()", true],
    ["a && failure()", true],
    ["x || (y && success())", true],
    ["a == always()", true],
    ["a[always()]", true],
    ["a.b[c].d", false],
    ["a.*", false],
    ["contains(a, always())", true],
    ["contains(a, 'b')", false],
    ["'always()' == x", false],
  ])("%s is %s", (text, expected) => {
    expect(usesStatusFunction(parseExpression(text)!)).toBe(expected);
  });

  it("sees a call inside an index and a member chain", () => {
    expect(usesStatusFunction(parseExpression("a[!success()].b")!)).toBe(true);
  });
});

describe("what is read and what is not", () => {
  it("strips one wrapper that is the whole of the text", () => {
    expect(parseExpression("${{ a == 'b' }}")).toEqual(parseExpression("a == 'b'"));
    expect(parseExpression("${{a}}")).toEqual(parseExpression("a"));
    expect(parseExpression("${{ '' == a }}")).toEqual(parseExpression("'' == a"));
  });

  it("reads the text of a value with no wrapper whatever space is around it", () => {
    expect(parseExpression("  a == 'b'\n")).toEqual(parseExpression("a == 'b'"));
  });

  it.each([
    ["a space before it", " ${{ x }}"],
    ["a space after it", "${{ x }} "],
    ["spaces on both sides", "  ${{a}}  "],
    ["the line break a block keeps", "${{ x }}\n"],
  ])("cannot read a wrapper with %s, which GitHub makes a format() string that is always true", (_, text) => {
    expect(parseExpression(text)).toBeNull();
  });

  it.each([["${{ '' }}"], ["${{ 'false' }}"], ["${{ 'a == ''b''' }}"]])(
    "cannot read %j, a wrapper around one string, whose text GitHub reads as the condition",
    (text) => {
      expect(parseExpression(text)).toBeNull();
    },
  );

  it.each([
    ["${{ a }} && ${{ b }}"],
    ["prefix ${{ a }}"],
    ["${{ a }} suffix"],
    ["${{ ${{ a }} }}"],
    ["${{}}"],
    ["${{ a"],
    [""],
    ["   "],
    ["'abc"],
    ['"push"'],
    ["a =="],
    ["a b"],
    ["a &&"],
    ["(a"],
    ["a[0"],
    ["f(a,"],
    ["a."],
    ["a.1"],
    ["a = b"],
    ["0x10 == 16"],
    ["a @ b"],
    ["{ a }"],
    ["a ? b : c"],
    [")"],
  ])("cannot read %j", (text) => {
    expect(parseExpression(text)).toBeNull();
  });

  it("reads a doubled quote as one", () => {
    expect(value("'it''s'")).toBe("it's");
    expect(value("''''")).toBe("'");
  });

  it("reads the pieces of a call and a number", () => {
    expect(parseExpression("f()")).toEqual({ kind: "call", name: "f", args: [] });
    expect(parseExpression("f(1, 'a')")).toEqual({
      kind: "call",
      name: "f",
      args: [
        { kind: "literal", value: 1 },
        { kind: "literal", value: "a" },
      ],
    });
    expect(parseExpression("-1.5e1")).toEqual({ kind: "literal", value: -15 });
  });
});

describe("bounds", () => {
  it("reads 2,000 characters and refuses 2,001", () => {
    expect(parseExpression(`'${"a".repeat(MAX_EXPRESSION - 2)}'`)).not.toBeNull();
    expect(parseExpression(`'${"a".repeat(MAX_EXPRESSION - 1)}'`)).toBeNull();
  });

  it("counts the length after the wrapper is stripped", () => {
    // A string of 1,995 characters and ` == x` are 2,000.
    expect(parseExpression(`\${{ '${"a".repeat(MAX_EXPRESSION - 7)}' == x }}`)).not.toBeNull();
    expect(parseExpression(`\${{ '${"a".repeat(MAX_EXPRESSION - 6)}' == x }}`)).toBeNull();
  });

  it("reads 500 tokens and refuses 501", () => {
    // 250 names and 249 operators are 499 tokens, and a leading ! makes 500.
    const chain = Array.from({ length: 250 }, () => "a").join(" || ");
    expect(parseExpression(chain)).not.toBeNull();
    expect(parseExpression(`!${chain}`)).not.toBeNull();
    expect(parseExpression(`!!${chain}`)).toBeNull();
    expect(MAX_TOKENS).toBe(500);
  });

  it("reads 32 levels and refuses 33", () => {
    const parens = (n: number) => `${"(".repeat(n)}a${")".repeat(n)}`;
    expect(parseExpression(parens(MAX_DEPTH))).not.toBeNull();
    expect(parseExpression(parens(MAX_DEPTH + 1))).toBeNull();
    expect(parseExpression(`${"!".repeat(MAX_DEPTH)}a`)).not.toBeNull();
    expect(parseExpression(`${"!".repeat(MAX_DEPTH + 1)}a`)).toBeNull();
    expect(parseExpression(`${"f(".repeat(MAX_DEPTH)}a${")".repeat(MAX_DEPTH)}`)).not.toBeNull();
    expect(parseExpression(`${"f(".repeat(MAX_DEPTH + 1)}a${")".repeat(MAX_DEPTH + 1)}`)).toBeNull();
    expect(parseExpression(`${"a[".repeat(MAX_DEPTH)}b${"]".repeat(MAX_DEPTH)}`)).not.toBeNull();
    expect(parseExpression(`${"a[".repeat(MAX_DEPTH + 1)}b${"]".repeat(MAX_DEPTH + 1)}`)).toBeNull();
  });

  it("copes with hostile text without throwing", () => {
    expect(parseExpression("(".repeat(2_000))).toBeNull();
    expect(parseExpression("'".repeat(1_999))).toBeNull();
    expect(parseExpression("!".repeat(1_000))).toBeNull();
    expect(parseExpression("${{ ".repeat(300))).toBeNull();
    expect(parseExpression("a.".repeat(400))).toBeNull();
    expect(parseExpression("a".repeat(5_000))).toBeNull();
  });

  it("evaluates a long member chain and a long comparison chain", () => {
    const members = Array.from({ length: 240 }, (_, i) => `k${i}`).join(".");
    expect(truth(`github.${members}`)).toBeNull();
    const compares = Array.from({ length: 160 }, () => "1").join(" == ");
    expect(parseExpression(compares)).not.toBeNull();
    // 1 == 1 is true, and true == 1 is true again, so the chain stays true all the way along.
    expect(truth(compares)).toBe(true);
  });
});
