import { describe, expect, it } from "vitest";
import {
  detectTooling,
  isCodeFile,
  isTestPath,
  isToolingCandidate,
  toolingCandidates,
  type CandidateFile,
} from "../src/codeTooling.js";

const file = (path: string, content: string): CandidateFile => ({ path, content });
const workflow = (run: string) => file(".github/workflows/ci.yml", `jobs:\n  q:\n    steps:\n      - run: ${run}\n`);

describe("isTestPath", () => {
  it.each([
    "src/user.test.ts",
    "src/user.spec.tsx",
    "pkg/test_users.py",
    "pkg/users_test.py",
    "internal/users_test.go",
    "src/main/UserTest.java",
    "src/main/UserTests.java",
    "spec/models/user_spec.rb",
    "app/user_spec.rb",
    "src/main/scala/UserSpec.scala",
    "src/main/kotlin/UserSpec.kt",
    "pkg/conftest.py",
    "src/__mocks__/api.ts",
    "Billing/InvoiceTests.cs",
    "test/helpers.ts",
    "packages/a/tests/util.py",
    "src/__tests__/x.js",
    "spec/models/user.rb",
    "Src/Tests/Fixture.cs",
    "a/b/test/c/d.go",
  ])("treats %s as a test", (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    "src/user.ts",
    "src/testing.ts",
    "src/contest/entry.ts",
    "src/latest.py",
    "src/UserTester.java",
    "src/attest_thing.go",
    "src/specification/x.ts",
    "test.ts",
    "src/Specification.kt",
    "src/user_spec_helper.rb",
    "src/conftest.pyc",
  ])("treats %s as source", (path) => {
    expect(isTestPath(path)).toBe(false);
  });
});

describe("isCodeFile", () => {
  it.each([
    ["src/a.ts", true],
    ["a.PY", true],
    ["docs/readme.md", false],
    ["data.json", false],
    ["Makefile", false],
    [".ts", false],
  ])("%s gives %s", (path, expected) => {
    expect(isCodeFile(path)).toBe(expected);
  });
});

describe("tooling candidates", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yaml",
    "package.json",
    "apps/web/package.json",
    "Makefile",
    "eslint.config.mjs",
    ".eslintrc.json",
    ".prettierrc",
    "prettier.config.js",
    "pyproject.toml",
    "go.mod",
    "packages/core/vitest.config.ts",
  ])("reads %s", (path) => {
    expect(isToolingCandidate(path)).toBe(true);
  });

  it.each([
    "src/index.ts",
    ".github/workflows/notes.md",
    ".github/workflows/nested/ci.yml",
    "test/fixtures/package.json",
    "docs/Makefile.md",
  ])("skips %s", (path) => {
    expect(isToolingCandidate(path)).toBe(false);
  });

  it("orders shallowest first and honours the limit", () => {
    const paths = ["a/b/c/package.json", "src/x.ts", "package.json", "a/package.json", "Makefile"];

    expect(toolingCandidates(paths)).toEqual(["Makefile", "package.json", "a/package.json", "a/b/c/package.json"]);
    expect(toolingCandidates(paths, 2)).toEqual(["Makefile", "package.json"]);
  });
});

describe("detectTooling", () => {
  it("finds prettier and vitest floors, following make targets, variables and package scripts from CI", () => {
    const facts = detectTooling([
      file(
        "package.json",
        JSON.stringify({ devDependencies: { prettier: "^3.6.2" }, scripts: { "test:coverage": "turbo run test:coverage" } }),
      ),
      file(".prettierrc.json", "{}"),
      file(
        "Makefile",
        [
          "PRETTIER := node_modules/.bin/prettier",
          "TURBO    := node_modules/.bin/turbo",
          ".PHONY: quality fmt-check",
          "fmt-check: ## Fail if anything is unformatted",
          "\t$(PRETTIER) --check . --log-level warn",
          "test-coverage: ## coverage",
          "\t$(TURBO) run test:coverage",
          "quality: fmt-check test-coverage ## every gate",
        ].join("\n"),
      ),
      file("packages/core/package.json", JSON.stringify({ scripts: { "test:coverage": "vitest run --coverage" } })),
      file(
        "packages/core/vitest.config.ts",
        "export default { test: { coverage: { thresholds: { lines: 90, functions: 90 } } } };",
      ),
      file("apps/api/vitest.config.ts", "export default { test: { coverage: { thresholds: { lines: 85, branches: 80 } } } };"),
      workflow("make quality"),
    ]);

    expect(facts).toEqual({
      linters: [],
      formatters: ["prettier"],
      weakFormatters: [],
      ciLinters: [],
      ciFormatChecks: ["prettier"],
      ciRunsTests: true,
      coverageFloor: 85, // the weaker of 90 and 85
    });
  });

  it("does not count a prettier dependency as configuration", () => {
    const facts = detectTooling([file("package.json", JSON.stringify({ devDependencies: { prettier: "^3" } }))]);
    expect(facts.formatters).toEqual([]);
  });

  it("counts a prettier key in package.json", () => {
    expect(detectTooling([file("package.json", JSON.stringify({ prettier: { semi: false } }))]).formatters).toEqual(["prettier"]);
  });

  it("counts a lint script only when a workflow reaches it", () => {
    const pkg = file("package.json", JSON.stringify({ eslintConfig: {}, scripts: { lint: "eslint ." } }));

    expect(detectTooling([pkg]).linters).toEqual(["eslint"]);
    expect(detectTooling([pkg]).ciLinters).toEqual([]);
    expect(detectTooling([pkg, workflow("npm run lint")]).ciLinters).toEqual(["eslint"]);
    expect(detectTooling([pkg, workflow("echo nothing")]).ciLinters).toEqual([]);
  });

  it("does not count prettier --write as a check, and ignores commented lines", () => {
    const facts = detectTooling([
      file(
        ".github/workflows/ci.yml",
        "steps:\n  - run: npx prettier --write .\n  # - run: npx prettier --check .\n  # - run: eslint .\n",
      ),
    ]);

    expect(facts.ciFormatChecks).toEqual([]);
    expect(facts.ciLinters).toEqual([]);
  });

  it("reads Python tooling and takes the weakest coverage floor", () => {
    const facts = detectTooling([
      file(
        "pyproject.toml",
        "[tool.ruff]\nline-length = 100\n[tool.ruff.format]\nquote-style = 'double'\n[tool.black]\n[tool.coverage.report]\nfail_under = 85\n",
      ),
      workflow("ruff check . && black --check . && ruff format --check . && pytest --cov --cov-fail-under=70"),
    ]);

    expect(facts).toEqual({
      linters: ["ruff"],
      formatters: ["black", "ruff format"],
      weakFormatters: [],
      ciLinters: ["ruff"],
      ciFormatChecks: ["black", "ruff format"],
      ciRunsTests: true,
      coverageFloor: 70,
    });
  });

  it("reads flake8, pylint and .coveragerc", () => {
    const facts = detectTooling([
      file("tox.ini", "[flake8]\nmax-line-length = 100\n"),
      file(".pylintrc", ""),
      file(".coveragerc", "[report]\nfail_under = 60\n"),
    ]);

    expect(facts.linters).toEqual(["flake8", "pylint"]);
    expect(facts.coverageFloor).toBe(60);
  });

  it("treats a Go module as formatted, and reads golangci-lint from CI", () => {
    const facts = detectTooling([
      file("go.mod", "module acme/widgets"),
      file(".golangci.yml", "run: {}"),
      workflow("golangci-lint run && gofmt -l . && go test ./..."),
    ]);

    expect(facts).toMatchObject({
      linters: ["golangci-lint"],
      formatters: ["gofmt"],
      ciLinters: ["golangci-lint"],
      ciFormatChecks: ["gofmt"],
      ciRunsTests: true,
    });
  });

  it("treats a Rust crate as formatted and clippy as configured once CI runs it", () => {
    const facts = detectTooling([
      file("Cargo.toml", "[package]"),
      workflow("cargo fmt --check && cargo clippy -- -D warnings && cargo test"),
    ]);

    expect(facts).toMatchObject({
      linters: ["clippy"],
      formatters: ["rustfmt"],
      ciLinters: ["clippy"],
      ciFormatChecks: ["rustfmt"],
      ciRunsTests: true,
    });
  });

  it("counts biome as linter and formatter, and biome ci as both checks", () => {
    const facts = detectTooling([file("biome.json", "{}"), workflow("npx biome ci .")]);

    expect(facts).toMatchObject({ linters: ["biome"], formatters: ["biome"], ciLinters: ["biome"], ciFormatChecks: ["biome"] });
  });

  it("notes an editorconfig as a weak formatter that does not count", () => {
    const facts = detectTooling([file(".editorconfig", "root = true")]);

    expect(facts.formatters).toEqual([]);
    expect(facts.weakFormatters).toEqual(["editorconfig"]);
  });

  it.each([
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "pytest -q",
    "go test ./...",
    "cargo test",
    "mvn -B test",
    "./gradlew build test",
    "dotnet test",
    "npx jest",
    "npx vitest run",
  ])("sees %s as a test run", (command) => {
    expect(detectTooling([workflow(command)]).ciRunsTests).toBe(true);
  });

  it("sees no test run when CI only builds", () => {
    expect(detectTooling([workflow("npm run build")]).ciRunsTests).toBe(false);
  });

  it("reads jest thresholds from package.json, and falls back to statements", () => {
    const jest = file("package.json", JSON.stringify({ jest: { coverageThreshold: { global: { branches: 50, lines: 80 } } } }));
    const statements = file("vitest.config.ts", "export default { test: { coverage: { thresholds: { statements: 70 } } } }");

    expect(detectTooling([jest]).coverageFloor).toBe(80);
    expect(detectTooling([statements]).coverageFloor).toBe(70);
    expect(detectTooling([file("vitest.config.ts", "export default {}")]).coverageFloor).toBeNull();
  });

  it("does not loop when make targets depend on each other", () => {
    const facts = detectTooling([file("Makefile", "a: b\n\techo a\nb: a\n\tprettier --check .\n"), workflow("make a")]);

    expect(facts.ciFormatChecks).toEqual(["prettier"]);
  });

  it("reports nothing for a repository with no tooling files", () => {
    expect(detectTooling([])).toEqual({
      linters: [],
      formatters: [],
      weakFormatters: [],
      ciLinters: [],
      ciFormatChecks: [],
      ciRunsTests: false,
      coverageFloor: null,
    });
  });

  it("survives a package.json that is not JSON", () => {
    expect(detectTooling([file("package.json", "{ not json")]).linters).toEqual([]);
  });
});

const workflowOf = (yaml: string) => file(".github/workflows/ci.yml", yaml);
const scripts = (body: Record<string, string>) => file("package.json", JSON.stringify({ scripts: body }));

describe("candidate crowding", () => {
  it("always keeps the workflows, whatever the limit and however many other files there are", () => {
    const crowd = Array.from({ length: 300 }, (_, i) => `pkg${String(i).padStart(3, "0")}/package.json`);
    const picked = toolingCandidates([...crowd, ".github/workflows/ci.yml", ".github/workflows/release.yaml", "Makefile"], 5);

    expect(picked).toContain(".github/workflows/ci.yml");
    expect(picked).toContain(".github/workflows/release.yaml");
    expect(picked).toHaveLength(7); // five others and two workflows
    expect(picked).toContain("Makefile");
  });
});

describe("hostile input", () => {
  it("scans a 250 KB line quickly, and cuts each line at 2,000 characters", () => {
    const hostile = ["prettier ", "black ", "cargo fmt ", "mvn ", "gradle ", "ruff format "].map(
      (word) => `      - run: ${word.repeat(40_000)}`,
    );
    const started = performance.now();
    const facts = detectTooling([workflowOf(`steps:\n${hostile.join("\n")}\n`)]);

    expect(performance.now() - started).toBeLessThan(200);
    expect(facts.ciFormatChecks).toEqual([]);
    expect(facts.ciRunsTests).toBe(false);
  });

  it("does not see a flag pushed beyond the line cut", () => {
    const far = workflowOf(`steps:\n  - run: prettier ${" ".repeat(3000)}--check .\n`);
    const near = workflowOf("steps:\n  - run: prettier --check .\n");

    expect(detectTooling([far]).ciFormatChecks).toEqual([]);
    expect(detectTooling([near]).ciFormatChecks).toEqual(["prettier"]);
  });

  it("stops reading CI text after 1 MB", () => {
    const padding = Array.from({ length: 3000 }, () => `  - run: ${"x".repeat(500)}`).join("\n"); // 1.5 MB
    const late = workflowOf(`steps:\n${padding}\n  - run: vitest run\n`);
    const early = workflowOf(`steps:\n${padding.split("\n").slice(0, 100).join("\n")}\n  - run: vitest run\n`);

    expect(detectTooling([late]).ciRunsTests).toBe(false);
    expect(detectTooling([early]).ciRunsTests).toBe(true);
  });

  describe("makefile expansion", () => {
    const big = "a".repeat(1000);

    it("cuts a variable at 1 KB, so text after the cut never reaches a recipe", () => {
      const makefile = file("Makefile", `X = ${"a".repeat(1100)} eslint .\nlint:\n\t$(X)\n`);

      expect(detectTooling([makefile, workflowOf("steps:\n  - run: make lint\n")]).ciLinters).toEqual([]);
    });

    it("skips a line that expands beyond 4 KB, and keeps the rest of the recipe", () => {
      const makefile = file("Makefile", `A = ${big}\nlint:\n\t$(A)$(A)$(A)$(A)$(A) && eslint .\n\tprettier --check .\n`);
      const facts = detectTooling([makefile, workflowOf("steps:\n  - run: make lint\n")]);

      expect(facts.ciLinters).toEqual([]); // the whole oversized line was skipped
      expect(facts.ciFormatChecks).toEqual(["prettier"]);
    });

    it("stops expanding once the total budget of 256 KB is spent", () => {
      const heavy = Array.from({ length: 100 }, () => "\techo $(A)$(A)$(A)").join("\n"); // 3,000 characters each
      const makefile = file("Makefile", `A = ${big}\nlint:\n${heavy}\n\t$(B) --check .\nB = prettier\n`);
      const early = file("Makefile", `A = ${big}\nlint:\n\t$(B) --check .\nB = prettier\n`);
      const run = workflowOf("steps:\n  - run: make lint\n");

      expect(detectTooling([makefile, run]).ciFormatChecks).toEqual([]);
      expect(detectTooling([early, run]).ciFormatChecks).toEqual(["prettier"]);
    });
  });
});

describe("following package managers and turbo", () => {
  const pkg = scripts({ lint: "eslint .", test: "vitest run" });

  it.each([
    "pnpm -r lint",
    "pnpm --filter web lint",
    "pnpm --filter=web run lint",
    "npx turbo lint",
    "turbo run lint",
    "turbo lint --filter=web",
    "yarn lint",
  ])("reaches a linter through %s", (command) => {
    expect(detectTooling([pkg, workflowOf(`steps:\n  - run: ${command}\n`)]).ciLinters).toEqual(["eslint"]);
  });

  it("reaches tests through turbo without run", () => {
    expect(detectTooling([pkg, workflowOf("steps:\n  - run: npx turbo test\n")]).ciRunsTests).toBe(true);
  });
});

describe("steps that cannot fail the build", () => {
  it("ignores a step marked continue-on-error, wherever the flag sits in the step, and keeps its neighbours", () => {
    const yaml = [
      "steps:",
      "  - name: Lint",
      "    run: npx eslint .",
      "    continue-on-error: true",
      "  - continue-on-error: true",
      "    run: npx prettier --check .",
      "  - name: Test",
      "    run: npx vitest run",
      "  - run: cargo clippy",
      "    continue-on-error: false",
    ].join("\n");
    const facts = detectTooling([workflowOf(yaml)]);

    expect(facts.ciLinters).toEqual(["clippy"]);
    expect(facts.ciFormatChecks).toEqual([]);
    expect(facts.ciRunsTests).toBe(true);
  });

  it("ends a step at the next item and at a dedent", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: npx eslint .",
      "        continue-on-error: true",
      "  b:",
      "    steps:",
      "      - run: npx pylint x",
    ].join("\n");

    expect(detectTooling([workflowOf(yaml)]).ciLinters).toEqual(["pylint"]);
  });
});

describe("mentions that do not run a tool", () => {
  it.each([
    "- name: Run eslint and prettier --check",
    '- run: echo "eslint . && prettier --check ."',
    "- run: npm install -g eslint prettier",
    "- run: npm i -D biome",
    "- run: pip install flake8 pylint black",
    "- run: pip3 install ruff",
    "- run: cargo install cargo-clippy",
    "- run: sudo apt-get install -y golangci-lint",
    "- run: uv tool install ruff",
    "- run: uv pip install black flake8",
    "- run: uv add --dev ruff",
    "- run: winget install --id Biome.Biome",
    "- run: choco install golangci-lint",
    "- run: scoop install eslint",
  ])("ignores %s", (step) => {
    const facts = detectTooling([workflowOf(`steps:\n  ${step}\n`)]);

    expect(facts.ciLinters).toEqual([]);
    expect(facts.ciFormatChecks).toEqual([]);
  });

  it("still sees a tool run after an install in the same line", () => {
    const facts = detectTooling([workflowOf("steps:\n  - run: npm install && npx eslint . && npx prettier --check .\n")]);

    expect(facts.ciLinters).toEqual(["eslint"]);
    expect(facts.ciFormatChecks).toEqual(["prettier"]);
  });
});

describe("coverage floor reading", () => {
  const vitest = (body: string) => file("vitest.config.ts", body);

  it("ignores thresholds inside line and block comments", () => {
    expect(
      detectTooling([vitest("export default {\n  // thresholds: { lines: 90 },\n  /* thresholds: { lines: 95 } */\n}")])
        .coverageFloor,
    ).toBeNull();
  });

  it("does not mistake a glob inside a string for a comment", () => {
    const config = 'coverage: {\n  exclude: ["src/**/*.test.{ts,tsx}", "src/test/**"],\n  thresholds: { lines: 80 },\n}';

    expect(detectTooling([vitest(config)]).coverageFloor).toBe(80);
    expect(detectTooling([vitest("url: 'http://example.test', thresholds: { lines: 70 }")]).coverageFloor).toBe(70);
  });

  it("copes with escaped quotes, template strings and a string that never closes", () => {
    expect(detectTooling([vitest('a: "say \\"//\\" now", thresholds: { lines: 61 }')]).coverageFloor).toBe(61);
    expect(detectTooling([vitest("a: `x // y ${1}`, thresholds: { lines: 62 }")]).coverageFloor).toBe(62);
    expect(detectTooling([vitest("a: 'oops\nthresholds: { lines: 63 }")]).coverageFloor).toBe(63);
    expect(detectTooling([vitest("thresholds: { lines: 64 }, a: 'never closed")]).coverageFloor).toBe(64);
  });

  it("removes a trailing line comment but keeps the code before it", () => {
    expect(detectTooling([vitest("thresholds: { lines: 75 } // was 90\n")]).coverageFloor).toBe(75);
    expect(detectTooling([vitest("thresholds: { lines: 75, // statements: 10\n}")]).coverageFloor).toBe(75);
  });

  it("copes with a block comment that never closes", () => {
    expect(detectTooling([vitest("thresholds: { lines: 80 }\n/* unfinished thresholds: { lines: 10 }")]).coverageFloor).toBe(80);
  });

  it("ignores a thresholds block that never closes", () => {
    expect(detectTooling([vitest("thresholds: { lines: 80")]).coverageFloor).toBeNull();
  });

  it("treats a floor of zero as none", () => {
    expect(
      detectTooling([vitest("export default { test: { coverage: { thresholds: { lines: 0 } } } }")]).coverageFloor,
    ).toBeNull();
    expect(detectTooling([vitest("thresholds: { lines: 0, statements: 0 }")]).coverageFloor).toBeNull();
  });

  it("reads only inside the thresholds block", () => {
    const body = "export default { coverage: { thresholds: { branches: 50 }, other: { lines: 99 } } }";

    expect(detectTooling([vitest(body)]).coverageFloor).toBeNull();
  });

  it("finds the lines figure of a nested jest block, and the weakest of several files", () => {
    const jest = file("package.json", JSON.stringify({ jest: { coverageThreshold: { global: { branches: 40, lines: 75 } } } }));

    expect(detectTooling([jest]).coverageFloor).toBe(75);
    expect(detectTooling([jest, vitest("coverage: { thresholds: { lines: 65 } }")]).coverageFloor).toBe(65);
  });

  it("counts --cov-fail-under only when a workflow reaches it", () => {
    const addopts = file("pyproject.toml", '[tool.pytest.ini_options]\naddopts = "--cov --cov-fail-under=70"\n');
    const script = scripts({ test: "pytest --cov --cov-fail-under=55" });

    expect(detectTooling([addopts]).coverageFloor).toBeNull();
    expect(detectTooling([script]).coverageFloor).toBeNull();
    expect(detectTooling([script, workflowOf("steps:\n  - run: npm test\n")]).coverageFloor).toBe(55);
    expect(detectTooling([workflowOf("steps:\n  - run: pytest --cov-fail-under=80\n")]).coverageFloor).toBe(80);
  });

  it("ignores a commented fail_under and a zero one", () => {
    expect(detectTooling([file(".coveragerc", "[report]\n# fail_under = 90\n")]).coverageFloor).toBeNull();
    expect(detectTooling([file(".coveragerc", "[report]\nfail_under = 0\n")]).coverageFloor).toBeNull();
  });
});
