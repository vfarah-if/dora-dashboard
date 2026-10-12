import { describe, expect, it } from "vitest";
import { isActionPath, isWorkflowPath } from "../src/codeTooling.js";
import { supplyChainCandidates, supplyChainFacts } from "../src/supplyChain.js";
import type { WorkflowFinding, WorkflowRisk } from "../src/securityTypes.js";
import { PROPORTIONAL, growth } from "./growth.js";
import { WORKFLOW_PATH, chainFacts, file, withPermissions, workflowFacts } from "./security.js";

const SHA = "a".repeat(40);
const risks = (yaml: string, risk: WorkflowRisk, path = WORKFLOW_PATH): WorkflowFinding[] =>
  workflowFacts(yaml, path).findings.filter((finding) => finding.risk === risk);

describe("isWorkflowPath and isActionPath", () => {
  it.each([
    [".github/workflows/ci.yml", true],
    [".github/workflows/release.yaml", true],
    [".github/workflows/nested/ci.yml", false],
    ["workflows/ci.yml", false],
    [".github/workflows/ci.txt", false],
  ])("%s is a workflow: %s", (path, expected) => {
    expect(isWorkflowPath(path)).toBe(expected);
  });

  it.each([
    [".github/actions/setup/action.yml", true],
    [".github/actions/a/b/action.yaml", true],
    [".github/actions/setup/readme.md", false],
    [".github/workflows/action.yml", false],
    ["actions/setup/action.yml", false],
  ])("%s is a composite action: %s", (path, expected) => {
    expect(isActionPath(path)).toBe(expected);
  });
});

describe("supplyChainCandidates", () => {
  const paths = [
    ".github/workflows/z.yml",
    ".github/workflows/a.yml",
    ".github/actions/setup/action.yml",
    "package-lock.json",
    "web/yarn.lock",
    "pnpm-lock.yaml",
    "tests/fixtures/package-lock.json",
    "Dockerfile",
    "services/api/Dockerfile.prod",
    "build/app.Dockerfile",
    "Containerfile",
    "test/Dockerfile",
    "Makefile",
    "web/package.json",
    "node_modules/x/package.json",
    "src/index.ts",
  ];

  it("lists workflows first and then composite actions", () => {
    expect(supplyChainCandidates(paths).workflows).toEqual([
      ".github/workflows/a.yml",
      ".github/workflows/z.yml",
      ".github/actions/setup/action.yml",
    ]);
  });

  it("lists readable lockfiles shallowest first, without pnpm or test fixtures", () => {
    expect(supplyChainCandidates(paths).lockfiles).toEqual(["package-lock.json", "web/yarn.lock"]);
  });

  it("lists Dockerfiles in every naming form, not under test paths", () => {
    expect(supplyChainCandidates(paths).dockerfiles).toEqual([
      "Containerfile",
      "Dockerfile",
      "build/app.Dockerfile",
      "services/api/Dockerfile.prod",
    ]);
  });

  it("lists the Makefiles and package.json files a workflow command may lead to", () => {
    expect(supplyChainCandidates(paths).tooling).toEqual(["Makefile", "web/package.json"]);
  });

  it("caps workflows at 500 and Dockerfiles at 50", () => {
    const many = [
      ...Array.from({ length: 600 }, (_, i) => `.github/workflows/w${i}.yml`),
      ...Array.from({ length: 80 }, (_, i) => `d${i}/Dockerfile`),
    ];
    const found = supplyChainCandidates(many);
    expect(found.workflows).toHaveLength(500);
    expect(found.dockerfiles).toHaveLength(50);
  });
});

describe("workflow uses", () => {
  const uses = (value: string) => workflowFacts(`jobs:\n  b:\n    steps:\n      - uses: ${value}\n`).actions;

  it("records a full SHA pin followed by a version comment as pinned", () => {
    expect(uses(`actions/checkout@${SHA} # v4`)).toEqual([
      { file: WORKFLOW_PATH, line: 4, action: "actions/checkout", ref: SHA, pinned: true, kind: "github" },
    ]);
  });

  it.each([
    ["actions/checkout@v4", "actions/checkout", "v4", "github"],
    ["actions/cache/restore@main", "actions/cache/restore", "main", "github"],
    ["github/codeql-action/init@v3", "github/codeql-action/init", "v3", "github"],
    ["Actions/Checkout@v4", "Actions/Checkout", "v4", "github"],
    ["peaceiris/actions-gh-pages@v3", "peaceiris/actions-gh-pages", "v3", "other"],
    ["acme/deploy/.github/workflows/release.yml@v1", "acme/deploy/.github/workflows/release.yml", "v1", "other"],
  ])("reads %s as an unpinned %s action", (value, action, ref, kind) => {
    expect(uses(value)).toMatchObject([{ action, ref, pinned: false, kind }]);
  });

  it.each([
    ["a 39 character sha", `actions/checkout@${"a".repeat(39)}`],
    ["a 41 character sha", `actions/checkout@${"a".repeat(41)}`],
    ["a sha with a non hex letter", `actions/checkout@${"g".repeat(40)}`],
  ])("does not treat %s as a pin", (_, value) => {
    expect(uses(value)[0]!.pinned).toBe(false);
  });

  it("reads a quoted value and an action with no ref", () => {
    expect(uses(`"acme/tool"`)).toMatchObject([{ action: "acme/tool", ref: null, pinned: false, kind: "other" }]);
  });

  it("reads a local action as local and pinned", () => {
    expect(uses("./.github/actions/setup")).toMatchObject([
      { action: "./.github/actions/setup", ref: null, pinned: true, kind: "local" },
    ]);
  });

  it("reads a docker image with a digest as pinned", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(uses(`docker://alpine@${digest}`)).toMatchObject([
      { action: "docker://alpine", ref: digest, pinned: true, kind: "docker" },
    ]);
  });

  it.each([
    ["docker://alpine:3.19", "docker://alpine", "3.19"],
    ["docker://ghcr.io:443/acme/tool:1.0", "docker://ghcr.io:443/acme/tool", "1.0"],
    ["docker://alpine", "docker://alpine", null],
  ])("reads %s as an unpinned docker image", (value, action, ref) => {
    expect(uses(value)).toMatchObject([{ action, ref, pinned: false, kind: "docker" }]);
  });

  it("does not read a registry port as a tag", () => {
    expect(uses("docker://localhost:5000/tool")).toMatchObject([{ action: "docker://localhost:5000/tool", ref: null }]);
  });

  it("reads a job level reusable workflow", () => {
    const yaml = `jobs:\n  call:\n    uses: acme/shared/.github/workflows/build.yml@${SHA}\n`;
    expect(workflowFacts(yaml).actions).toMatchObject([{ line: 3, kind: "other", pinned: true }]);
  });

  it("does not read a uses line written inside a run script", () => {
    const yaml = "jobs:\n  b:\n    steps:\n      - run: |\n          echo\n          uses: actions/checkout@v4\n";
    expect(workflowFacts(yaml).actions).toEqual([]);
  });

  it("reads uses written after other keys of the step", () => {
    const yaml = "jobs:\n  b:\n    steps:\n      - name: Check out\n        uses: actions/checkout@v4\n";
    expect(workflowFacts(yaml).actions).toMatchObject([{ line: 5, action: "actions/checkout" }]);
  });

  it("reads uses in a composite action file", () => {
    const path = ".github/actions/setup/action.yml";
    const yaml = "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n";
    expect(workflowFacts(yaml, path).actions).toMatchObject([{ file: path, action: "actions/setup-node" }]);
  });
});

describe("workflow permissions", () => {
  const job = (extra = "") => `  build:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo\n`;

  it("flags write-all wherever it appears, with its line", () => {
    const yaml = `on: push\njobs:\n  build:\n    permissions: write-all\n    runs-on: ubuntu-latest\n`;
    expect(risks(yaml, "writeAll")).toEqual([
      { file: WORKFLOW_PATH, line: 4, risk: "writeAll", evidence: "permissions: write-all" },
    ]);
  });

  it("flags a top level write-all", () => {
    expect(risks(`on: push\npermissions: write-all\njobs:\n${job()}`, "writeAll")).toHaveLength(1);
  });

  it.each(["read-all", "{}", "\n  contents: read", "\n  contents: write"])("treats top level permissions %j as set", (value) => {
    expect(risks(`on: push\npermissions: ${value}\njobs:\n${job()}`, "noPermissions")).toEqual([]);
    expect(risks(`on: push\npermissions: ${value}\njobs:\n${job()}`, "writeAll")).toEqual([]);
  });

  it("flags a workflow with no permissions anywhere", () => {
    expect(risks(`on: push\njobs:\n${job()}`, "noPermissions")).toEqual([
      { file: WORKFLOW_PATH, line: null, risk: "noPermissions", evidence: "permissions" },
    ]);
  });

  it("accepts a workflow in which every job sets its own permissions", () => {
    const yaml = `on: push\njobs:\n${job("    permissions:\n      contents: read\n")}  test:\n    runs-on: ubuntu-latest\n    permissions: read-all\n    steps:\n      - run: echo\n`;
    expect(risks(yaml, "noPermissions")).toEqual([]);
  });

  it("flags a workflow in which one job lacks permissions and there is no top level key", () => {
    const yaml = `on: push\njobs:\n${job("    permissions:\n      contents: read\n")}  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    expect(risks(yaml, "noPermissions")).toHaveLength(1);
  });

  it("does not take a permissions key deeper in a job for the job's own", () => {
    const yaml = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/tool@v1\n        with:\n          permissions: all\n`;
    expect(risks(yaml, "noPermissions")).toHaveLength(1);
  });

  it("does not flag a workflow with no jobs", () => {
    expect(risks("on: push\n", "noPermissions")).toEqual([]);
  });

  it("does not check a composite action for permissions", () => {
    const yaml = "runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n";
    expect(workflowFacts(yaml, ".github/actions/x/action.yml").findings).toEqual([]);
  });
});

describe("privileged triggers", () => {
  const injection = (on: string) =>
    risks(withPermissions(on, "      - run: echo ${{ github.event.issue.title }}"), "scriptInjection");

  it.each([
    ["a scalar", "on: pull_request_target"],
    ["a scalar with a comment", "on: issue_comment # comments"],
    ["a quoted scalar", 'on: "workflow_run"'],
    ["a flow list", "on: [push, issues]"],
    ["a flow map", "on: { discussion: { types: [created] } }"],
    ["a block list", "on:\n  - push\n  - discussion_comment"],
    ["a block map", "on:\n  push:\n    branches: [main]\n  pull_request_target:\n    types: [opened]"],
    ["a quoted key", '"on":\n  issues:\n    types: [opened]'],
    ["a single quoted key", "'on':\n  workflow_run:\n    workflows: [CI]"],
    ["the key true", "true:\n  issue_comment:\n    types: [created]"],
    ["a block list at the left margin", "on:\n- discussion"],
  ])("finds a privileged trigger in %s", (_, on) => {
    expect(injection(on)).toHaveLength(1);
  });

  it.each([
    ["a scalar", "on: push"],
    ["a flow list", "on: [push, pull_request]"],
    ["a block map", "on:\n  pull_request:\n    branches: [issues]\n  push:"],
    ["a block list", "on:\n  - push\n  - workflow_dispatch"],
  ])("finds none in %s", (_, on) => {
    expect(injection(on)).toEqual([]);
  });

  it("ignores a privileged name that only appears deeper in a block map", () => {
    expect(injection("on:\n  push:\n    paths:\n      - issues")).toEqual([]);
  });
});

describe("script injection", () => {
  const privileged = "on: issue_comment";
  const run = (step: string, on = privileged) => risks(withPermissions(on, step), "scriptInjection");

  it("flags an untrusted expression in a single line run, with its line and the expression as evidence", () => {
    const yaml = withPermissions(privileged, '      - run: echo "${{ github.event.comment.body }}"');
    expect(risks(yaml, "scriptInjection")).toEqual([
      { file: WORKFLOW_PATH, line: 7, risk: "scriptInjection", evidence: "github.event.comment.body" },
    ]);
  });

  it("flags an expression in the indented block after run: |", () => {
    const found = run("      - run: |\n          echo start\n          echo ${{ github.head_ref }}\n          echo done");
    expect(found).toMatchObject([{ line: 9, evidence: "github.head_ref" }]);
  });

  it("flags an expression in a folded block after run: >", () => {
    expect(run("      - run: >\n          echo ${{ github.event.pull_request.title }}")).toHaveLength(1);
  });

  it("flags every untrusted expression in a run, each as its own finding", () => {
    expect(
      run("      - run: echo ${{ github.event.issue.title }} ${{ github.event.issue.body }}").map((f) => f.evidence),
    ).toEqual(["github.event.issue.title", "github.event.issue.body"]);
  });

  it.each([
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.pull_request.head.ref",
    "github.event.pull_request.head.label",
    "github.event.pull_request.head.repo.default_branch",
    "github.event.comment.body",
    "github.event.review.body",
    "github.event.review_comment.body",
    "github.event.discussion.title",
    "github.event.discussion.body",
    "github.event.pages[0].page_name",
    "github.event.pages.*.page_name",
    "github.event.commits[0].message",
    "github.event.commits.*.author.email",
    "github.event.commits[1].author.name",
    "github.event.head_commit.message",
    "github.event.head_commit.author.email",
    "github.event.head_commit.author.name",
    "github.event.workflow_run.head_branch",
    "github.event.workflow_run.head_commit.message",
    "github.event.workflow_run.head_commit.author.email",
    "github.event.workflow_run.head_commit.author.name",
    "github.event.workflow_run.display_title",
    "github.head_ref",
    "GITHUB.EVENT.ISSUE.TITLE",
    "format('{0}', github.event.issue.title)",
  ])("names %s as untrusted", (expression) => {
    expect(run(`      - run: echo \${{ ${expression} }}`)).toHaveLength(1);
  });

  it.each([
    "github.sha",
    "github.event.issue.number",
    "github.event.pull_request.number",
    "github.event.pull_request.head.sha",
    "github.event.issue.title_text",
    "secrets.TOKEN",
    "matrix.os",
    "github.event_name",
  ])("does not name %s as untrusted", (expression) => {
    expect(run(`      - run: echo \${{ ${expression} }}`)).toEqual([]);
  });

  it("does not count text in env, with or if", () => {
    const step = [
      "      - name: Safe",
      "        if: contains(github.event.comment.body, 'deploy')",
      "        env:",
      "          BODY: ${{ github.event.comment.body }}",
      "        with:",
      "          title: ${{ github.event.issue.title }}",
      '        run: echo "$BODY"',
    ].join("\n");
    expect(run(step)).toEqual([]);
  });

  it("does not count a script block of github-script, which is not a run", () => {
    expect(
      run(
        "      - uses: actions/github-script@v7\n        with:\n          script: |\n            core.info('${{ github.event.issue.title }}')",
      ),
    ).toEqual([]);
  });

  it("does not flag an unprivileged trigger", () => {
    expect(run("      - run: echo ${{ github.event.issue.title }}", "on: [push, pull_request]")).toEqual([]);
  });

  it("does not flag a composite action, which has no trigger of its own", () => {
    const yaml = "runs:\n  using: composite\n  steps:\n    - run: echo ${{ github.head_ref }}\n      shell: bash\n";
    expect(risks(yaml, "scriptInjection", ".github/actions/x/action.yml")).toEqual([]);
  });

  it("keeps evidence to 200 characters", () => {
    // Twelve references joined by " || " are 12 * 24 + 11 * 4 = 332 characters, within the 500 an expression may hold.
    const long = Array.from({ length: 12 }, () => "github.event.issue.title").join(" || ");
    const found = run(`      - run: echo \${{ ${long} }}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toBe(long.slice(0, 200));
  });

  // A literal in an expression may be a hardcoded token; it must never be stored or returned (rule 9).
  it("stores the expression with its string literals blanked, so a literal token is never kept", () => {
    const token = `ghp_${"A1b2".repeat(9)}`;
    const yaml = withPermissions(
      privileged,
      `      - run: echo \${{ github.event.issue.title || '${token}' }} "\${{ format("{0}", github.head_ref) }}"`,
    );
    const facts = workflowFacts(yaml);
    expect(facts.findings.filter((f) => f.risk === "scriptInjection").map((f) => f.evidence)).toEqual([
      "github.event.issue.title || ''",
      "format('', github.head_ref)",
    ]);
    expect(JSON.stringify(facts)).not.toContain(token);
  });
});

describe("pull request head checkout", () => {
  const under = (on: string, step: string) => risks(withPermissions(on, step), "prHeadCheckout");
  const ref = (value: string) => `      - uses: actions/checkout@v4\n        with:\n          ref: ${value}`;

  it.each([
    "${{ github.event.pull_request.head.sha }}",
    "${{ github.event.pull_request.head.ref }}",
    "${{ github.head_ref }}",
    "${{ github.event.workflow_run.head_sha }}",
    "${{ github.event.workflow_run.head_branch }}",
    "refs/pull/${{ github.event.number }}/merge",
  ])("flags a ref of %s under pull_request_target", (value) => {
    expect(under("on: pull_request_target", ref(value))).toHaveLength(1);
  });

  it("flags a ref under workflow_run", () => {
    expect(under("on:\n  workflow_run:\n    workflows: [CI]", ref("${{ github.event.workflow_run.head_sha }}"))).toHaveLength(1);
  });

  it("names the reference and the line, never the whole line", () => {
    expect(under("on: pull_request_target", ref("${{ github.event.pull_request.head.sha }}"))).toEqual([
      { file: WORKFLOW_PATH, line: 9, risk: "prHeadCheckout", evidence: "github.event.pull_request.head.sha" },
    ]);
  });

  it("does not flag a ref that is not a pull request reference", () => {
    expect(under("on: pull_request_target", ref("main"))).toEqual([]);
  });

  it.each(["on: pull_request", "on: push", "on: issue_comment"])("does not flag the ref under %s", (on) => {
    expect(under(on, ref("${{ github.event.pull_request.head.sha }}"))).toEqual([]);
  });

  it.each([
    "git checkout ${{ github.event.pull_request.head.sha }}",
    "git fetch origin ${{ github.head_ref }}",
    "git fetch origin refs/pull/${{ github.event.number }}/head",
    "git checkout $GIT && git checkout ${{ github.event.workflow_run.head_branch }}",
    "gh pr checkout ${{ github.event.pull_request.number }}",
  ])("flags the command %s under pull_request_target", (command) => {
    expect(under("on: pull_request_target", `      - run: ${command}`)).toHaveLength(1);
  });

  it("does not flag a git checkout of a branch name", () => {
    expect(under("on: pull_request_target", "      - run: git checkout main")).toEqual([]);
  });

  it("does not flag a head reference in a command that is not a checkout", () => {
    expect(under("on: pull_request_target", "      - run: echo ${{ github.head_ref }}")).toEqual([]);
  });

  it("does not flag the command under an unprivileged trigger", () => {
    expect(under("on: pull_request", "      - run: git checkout ${{ github.head_ref }}")).toEqual([]);
  });
});

describe("other workflow risks", () => {
  it.each([
    ["an env mapping", "      - run: echo\n        env:\n          ACTIONS_ALLOW_UNSECURE_COMMANDS: true"],
    ["a quoted value", '      - run: echo\n        env:\n          ACTIONS_ALLOW_UNSECURE_COMMANDS: "true"'],
    ["a shell export", "      - run: |\n          export ACTIONS_ALLOW_UNSECURE_COMMANDS=true\n          echo"],
  ])("flags ACTIONS_ALLOW_UNSECURE_COMMANDS in %s", (_, step) => {
    expect(risks(withPermissions("on: push", step), "unsecureCommands")).toMatchObject([
      { evidence: "ACTIONS_ALLOW_UNSECURE_COMMANDS" },
    ]);
  });

  it("does not flag it set to false", () => {
    expect(
      risks(
        withPermissions("on: push", "      - run: echo\n        env:\n          ACTIONS_ALLOW_UNSECURE_COMMANDS: false"),
        "unsecureCommands",
      ),
    ).toEqual([]);
  });

  it("flags unsecure commands in a composite action", () => {
    const yaml =
      "runs:\n  using: composite\n  steps:\n    - run: export ACTIONS_ALLOW_UNSECURE_COMMANDS=true\n      shell: bash\n";
    expect(risks(yaml, "unsecureCommands", ".github/actions/x/action.yml")).toHaveLength(1);
  });

  it.each([
    ["curl piped to bash", "curl -fsSL https://example.com/install.sh | bash", "curl | bash"],
    ["wget piped to sh", "wget -qO- https://example.com/i.sh | sh", "wget | sh"],
    ["curl piped to sudo bash", "curl -s https://example.com/i | sudo -E bash -s", "curl | bash"],
    ["curl piped to python3", "curl https://example.com/x.py | python3 -", "curl | python3"],
    ["curl piped to node", "curl https://example.com/x.js | node", "curl | node"],
    ["bash process substitution", "bash <(curl -s https://example.com/i)", "curl | bash"],
    ["sh -c with command substitution", 'sh -c "$(curl -fsSL https://example.com/i)"', "curl | sh"],
  ])("flags %s", (_, command, evidence) => {
    expect(risks(withPermissions("on: push", `      - run: ${command}`), "curlPipeShell")).toMatchObject([{ evidence }]);
  });

  it("does not flag curl that is not piped into an interpreter", () => {
    const yaml = withPermissions("on: push", "      - run: curl -fsSL https://example.com/data.json | jq .name");
    expect(risks(yaml, "curlPipeShell")).toEqual([]);
  });

  it("flags secrets: inherit on a reusable workflow call", () => {
    const yaml =
      "on: push\npermissions: {}\njobs:\n  call:\n    uses: acme/shared/.github/workflows/b.yml@v1\n    secrets: inherit\n";
    expect(risks(yaml, "secretsInherit")).toEqual([
      { file: WORKFLOW_PATH, line: 6, risk: "secretsInherit", evidence: "secrets: inherit" },
    ]);
  });

  it("does not flag a named secrets mapping", () => {
    const yaml =
      "on: push\npermissions: {}\njobs:\n  call:\n    uses: acme/shared/.github/workflows/b.yml@v1\n    secrets:\n      token: ${{ secrets.T }}\n";
    expect(risks(yaml, "secretsInherit")).toEqual([]);
  });

  describe("persisted credentials", () => {
    const checkout = (extra: string) => `      - uses: actions/checkout@v4\n${extra}`;

    it("flags a checkout without persist-credentials: false under a privileged trigger", () => {
      expect(risks(withPermissions("on: issues", checkout("")), "persistCredentials")).toEqual([
        { file: WORKFLOW_PATH, line: 7, risk: "persistCredentials", evidence: "actions/checkout@v4" },
      ]);
    });

    it("accepts persist-credentials: false in the step's with block", () => {
      expect(
        risks(
          withPermissions("on: issues", checkout("        with:\n          persist-credentials: false")),
          "persistCredentials",
        ),
      ).toEqual([]);
    });

    it("accepts persist-credentials: false written before the uses line", () => {
      const step = "      - with:\n          persist-credentials: false\n        uses: actions/checkout@v4";
      expect(risks(withPermissions("on: issues", step), "persistCredentials")).toEqual([]);
    });

    it("does not take the next step's setting for this one", () => {
      const steps = `${checkout("")}\n      - uses: acme/tool@v1\n        with:\n          persist-credentials: false`;
      expect(risks(withPermissions("on: issues", steps), "persistCredentials")).toHaveLength(1);
    });

    it("does not take the previous step's setting for this one", () => {
      const steps =
        "      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n      - uses: actions/checkout@v4\n        with:\n          path: other";
      expect(risks(withPermissions("on: issues", steps), "persistCredentials").map((f) => f.line)).toEqual([10]);
    });

    it("does not flag an unprivileged workflow", () => {
      expect(risks(withPermissions("on: push", checkout("")), "persistCredentials")).toEqual([]);
    });

    it("does not flag another action", () => {
      expect(risks(withPermissions("on: issues", "      - uses: actions/setup-node@v4"), "persistCredentials")).toEqual([]);
    });
  });

  describe("self-hosted runners", () => {
    const runsOn = (value: string, on = "on: push") =>
      risks(`${on}\npermissions: {}\njobs:\n  b:\n    runs-on: ${value}\n    steps: []\n`, "selfHosted");

    it.each(["self-hosted", "[self-hosted, linux]", "[ubuntu-latest, Self-Hosted]", "{ group: ci, labels: [self-hosted] }"])(
      "flags runs-on: %s",
      (value) => {
        expect(runsOn(value)).toMatchObject([{ line: 5, evidence: "self-hosted", onPullRequest: false }]);
      },
    );

    it("flags a block list of labels", () => {
      const yaml = "on: push\npermissions: {}\njobs:\n  b:\n    runs-on:\n      - self-hosted\n      - linux\n    steps: []\n";
      expect(risks(yaml, "selfHosted")).toMatchObject([{ line: 5 }]);
    });

    it("does not flag a hosted runner", () => {
      expect(runsOn("ubuntu-latest")).toEqual([]);
    });

    it.each(["on: pull_request", "on: [push, pull_request_target]", "on:\n  pull_request:\n    branches: [main]"])(
      "notes a pull request trigger in %s",
      (on) => {
        expect(runsOn("self-hosted", on)).toMatchObject([{ onPullRequest: true }]);
      },
    );
  });
});

describe("security tools", () => {
  const tools = (yaml: string) => workflowFacts(yaml).securityTools.map(({ tool, category }) => `${tool}:${category}`);
  const step = (value: string) => `jobs:\n  b:\n    steps:\n      - uses: ${value}\n`;

  it.each([
    ["github/codeql-action/init@v3", "codeql:sast"],
    ["github/codeql-action/analyze@v3", "codeql:sast"],
    ["actions/dependency-review-action@v4", "dependency-review:dependency_review"],
    ["ossf/scorecard-action@v2", "scorecard:scorecard"],
    ["aquasecurity/trivy-action@master", "trivy:container_scan"],
    ["anchore/scan-action@v3", "anchore:container_scan"],
    ["gitleaks/gitleaks-action@v2", "gitleaks:secret_scan"],
    ["trufflesecurity/trufflehog@main", "trufflehog:secret_scan"],
    ["returntocorp/semgrep-action@v1", "semgrep:sast"],
    ["semgrep/semgrep-action@v1", "semgrep:sast"],
    ["snyk/actions/node@master", "snyk:audit"],
    ["bridgecrewio/checkov-action@v12", "checkov:iac_scan"],
    ["aquasecurity/tfsec-action@v1.0.3", "tfsec:iac_scan"],
    ["google/osv-scanner-action@v1", "osv-scanner:audit"],
  ])("finds %s by its uses", (value, expected) => {
    expect(tools(step(value))).toEqual([expected]);
  });

  it("does not take a similarly named action for a security tool", () => {
    expect(tools(step("github/codeql-actions-helper@v1"))).toEqual([]);
    expect(tools(step("acme/trivy-action@v1"))).toEqual([]);
  });

  it.each([
    ["npm audit --audit-level=high", "npm audit:audit"],
    ["yarn audit", "yarn audit:audit"],
    ["yarn npm audit", "yarn audit:audit"],
    ["pnpm audit --prod", "pnpm audit:audit"],
    ["pip-audit -r requirements.txt", "pip-audit:audit"],
    ["python -m pip_audit", "pip-audit:audit"],
    ["safety check", "safety:audit"],
    ["cargo audit", "cargo audit:audit"],
    ["bundle audit check --update", "bundler-audit:audit"],
    ["bundle exec bundler-audit", "bundler-audit:audit"],
    ["osv-scanner --lockfile=package-lock.json", "osv-scanner:audit"],
    ["govulncheck ./...", "govulncheck:audit"],
    ["trivy fs .", "trivy:container_scan"],
    ["grype dir:.", "grype:container_scan"],
    ["hadolint Dockerfile", "hadolint:container_scan"],
    ["semgrep --config auto", "semgrep:sast"],
    ["gitleaks detect", "gitleaks:secret_scan"],
    ["trufflehog git file://.", "trufflehog:secret_scan"],
    ["checkov -d .", "checkov:iac_scan"],
    ["tfsec .", "tfsec:iac_scan"],
    ["sudo npx semgrep scan", "semgrep:sast"],
  ])("finds %s by its command", (command, expected) => {
    expect(tools(`jobs:\n  b:\n    steps:\n      - run: ${command}\n`)).toEqual([expected]);
  });

  it("finds a command inside a run block", () => {
    expect(tools("jobs:\n  b:\n    steps:\n      - run: |\n          npm ci\n          npm audit\n")).toEqual([
      "npm audit:audit",
    ]);
  });

  it("does not count a command that only installs the tool, names it in a label or echoes it", () => {
    const yaml =
      "jobs:\n  b:\n    steps:\n      - name: Run npm audit\n        run: pip install pip-audit\n      - run: echo trivy fs .\n      - run: ./run-trivy-later.sh\n";
    expect(tools(yaml)).toEqual([]);
  });

  it("finds a tool the workflow reaches through a make target and a package script", () => {
    const yaml = "jobs:\n  b:\n    steps:\n      - run: make scan\n      - run: npm run sec\n";
    const input = {
      paths: [WORKFLOW_PATH, "Makefile", "package.json"],
      workflows: [file(WORKFLOW_PATH, yaml)],
      tooling: [file("Makefile", "scan:\n\ttrivy fs .\n"), file("package.json", '{"scripts":{"sec":"npm audit"}}')],
    };
    expect(chainFacts(input).securityTools.map((t) => t.tool)).toEqual(["trivy", "npm audit"]);
  });

  it("counts a tool run in a step marked continue-on-error", () => {
    const yaml = "jobs:\n  b:\n    steps:\n      - run: trivy fs .\n        continue-on-error: true\n";
    expect(tools(yaml)).toEqual(["trivy:container_scan"]);
  });

  it("reports a tool once per file however many times it is used", () => {
    const yaml = `${step("github/codeql-action/init@v3")}      - uses: github/codeql-action/analyze@v3\n      - run: trivy fs .\n      - run: trivy image x\n`;
    expect(tools(yaml)).toEqual(["codeql:sast", "trivy:container_scan"]);
  });

  it("names the file that runs the tool", () => {
    const other = ".github/workflows/scan.yml";
    const found = chainFacts({
      paths: [WORKFLOW_PATH, other],
      workflows: [file(WORKFLOW_PATH, "jobs: {}\n"), file(other, step("ossf/scorecard-action@v2"))],
    });
    expect(found.securityTools).toEqual([{ tool: "scorecard", category: "scorecard", file: other }]);
  });
});

describe("Dockerfiles", () => {
  const docker = (content: string, path = "Dockerfile") =>
    chainFacts({ paths: [path], dockerfiles: [file(path, content)] }).dockerfiles;
  const digest = `sha256:${"c".repeat(64)}`;

  it("counts images, unpinned and latest ones, ignoring scratch and earlier stage names", () => {
    const content = [
      "FROM node:20 AS build",
      "FROM alpine AS runtime",
      "FROM scratch",
      "FROM build AS final",
      `FROM --platform=linux/amd64 debian@${digest}`,
      "FROM python:latest",
      "FROM ghcr.io:443/acme/base",
      "FROM ${BASE_IMAGE}",
      "USER app",
    ].join("\n");
    // Images: node:20, alpine, debian@digest, python:latest, ghcr base, the variable image. Unpinned: all but debian.
    // Latest: alpine (no tag), python:latest and the registry base (a port is not a tag); a variable cannot be known.
    expect(docker(content)).toEqual([
      {
        path: "Dockerfile",
        images: 6,
        unpinnedImages: 5,
        latestImages: 3,
        runsAsRoot: false,
        addsRemote: false,
        curlPipeShell: false,
      },
    ]);
  });

  it("does not count a digest pinned image as latest even without a tag", () => {
    expect(docker(`FROM ubuntu@${digest}\nUSER 1000`)[0]).toMatchObject({ images: 1, unpinnedImages: 0, latestImages: 0 });
  });

  it.each([
    ["no USER at all", "FROM node:20", true],
    ["USER root", "FROM node:20\nUSER root", true],
    ["USER 0", "FROM node:20\nUSER 0", true],
    ["USER 0:0", "FROM node:20\nUSER 0:0", true],
    ["USER ROOT:wheel", "FROM node:20\nUSER ROOT:wheel", true],
    ["a last USER of a normal user", "FROM node:20\nUSER root\nUSER node", false],
    ["a numeric user", "FROM node:20\nUSER 1000:1000", false],
    ["a variable user", "FROM node:20\nUSER ${UID}", false],
    ["a USER in an earlier stage only", "FROM node:20 AS build\nUSER node\nFROM alpine:3.19", true],
    ["a USER only in the last stage", "FROM node:20 AS build\nFROM alpine:3.19\nUSER app", false],
    ["no FROM line", "USER root", false],
  ])("runsAsRoot for %s is %s", (_, content, expected) => {
    expect(docker(content)[0]!.runsAsRoot).toBe(expected);
  });

  it.each([
    ["ADD https://example.com/app.tar.gz /app", true],
    ["ADD http://example.com/app.tar.gz /app", true],
    ["ADD --chown=app https://example.com/app.tar.gz /app", true],
    ["add https://example.com/app.tar.gz /app", true],
    ["ADD app.tar.gz /app", false],
    ["COPY https://example.com/a /a", false],
  ])("addsRemote for %s is %s", (line, expected) => {
    expect(docker(`FROM node:20\n${line}`)[0]!.addsRemote).toBe(expected);
  });

  it("notes a curl piped into a shell in a RUN line", () => {
    expect(docker("FROM node:20\nRUN curl -fsSL https://example.com/i.sh | sh")[0]!.curlPipeShell).toBe(true);
  });

  it("ignores comments and instructions it does not read", () => {
    expect(docker('# FROM node:latest\nFROM node:20\nRUN echo hi\nCMD ["node"]')[0]).toMatchObject({
      images: 1,
      latestImages: 0,
    });
  });

  it("reads each Dockerfile separately, sorted by path, and skips test paths", () => {
    const found = chainFacts({
      paths: [],
      dockerfiles: [
        file("b/Dockerfile", "FROM node:20"),
        file("a/Containerfile", "FROM alpine"),
        file("test/Dockerfile", "FROM x"),
        file("src/readme.md", "FROM y"),
      ],
    }).dockerfiles;
    expect(found.map((d) => d.path)).toEqual(["a/Containerfile", "b/Dockerfile"]);
  });

  it("reads at most 50 Dockerfiles", () => {
    const many = Array.from({ length: 70 }, (_, i) => file(`d${String(i).padStart(2, "0")}/Dockerfile`, "FROM node:20"));
    expect(chainFacts({ dockerfiles: many }).dockerfiles).toHaveLength(50);
  });

  it("has none when no contents are given", () => {
    expect(chainFacts({ paths: ["Dockerfile"] }).dockerfiles).toEqual([]);
  });
});

describe("repository files", () => {
  it.each([
    [[".github/dependabot.yml"], ".github/dependabot.yml"],
    [[".github/dependabot.yaml"], ".github/dependabot.yaml"],
    [["renovate.json"], "renovate.json"],
    [["renovate.json5"], "renovate.json5"],
    [[".renovaterc"], ".renovaterc"],
    [[".renovaterc.json"], ".renovaterc.json"],
    [[".github/renovate.json"], ".github/renovate.json"],
    [[".github/renovate.json5"], ".github/renovate.json5"],
    [[".gitlab/renovate.json"], ".gitlab/renovate.json"],
    [["renovate.json", ".github/dependabot.yml"], ".github/dependabot.yml"],
    [["packages/a/renovate.json", "docs/dependabot.yml"], null],
  ])("finds the update configuration in %j as %s", (paths, expected) => {
    expect(chainFacts({ paths }).updateConfig).toBe(expected);
  });

  it.each([
    [["SECURITY.md"], "SECURITY.md"],
    [["security.md"], "security.md"],
    [[".github/SECURITY.md"], ".github/SECURITY.md"],
    [["docs/SECURITY.txt"], "docs/SECURITY.txt"],
    [["SECURITY"], "SECURITY"],
    [["docs/SECURITY.md", ".github/SECURITY.md", "SECURITY.md"], "SECURITY.md"],
    [["docs/SECURITY.md", ".github/SECURITY.md"], ".github/SECURITY.md"],
    [["SECURITY.rst", "src/SECURITY.md", "docs/security-notes.md"], null],
  ])("finds the security policy in %j as %s", (paths, expected) => {
    expect(chainFacts({ paths }).securityPolicy).toBe(expected);
  });

  it("no longer reads code owners, which are advice about review", () => {
    expect("codeowners" in chainFacts({ paths: [".github/CODEOWNERS"] })).toBe(false);
  });
});

describe("key files", () => {
  const keys = (paths: string[]) => chainFacts({ paths }).keyFiles;

  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "app/.env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "ssh/id_ed25519",
    "putty/server.ppk",
    "certs/client.p12",
    "certs/client.pfx",
    "android/release.jks",
    "android/upload.keystore",
    ".env.dev-acme-widgets",
    ".env.local-acme-widgets",
    ".env.staging",
    ".env.prod",
    ".env.development.local",
  ])("reads %s as strong", (path) => {
    expect(keys([path])).toEqual([{ path, strength: "strong" }]);
  });

  it.each([
    ".env.test",
    ".env.development",
    ".env.dev",
    ".env.ci",
    "app/.ENV.DEV",
    "android/app/debug.keystore",
    "certs/server.pem",
    "tls/private.key",
    "CA.PEM",
  ])("reads %s as weak", (path) => {
    expect(keys([path])).toEqual([{ path, strength: "weak" }]);
  });

  it.each([
    ".env.example",
    ".env.local.sample",
    ".env.template",
    ".env.dist",
    ".env.defaults",
    ".envrc",
    "environment.ts",
    "id_rsa.pub",
    "id_rsa_notes.md",
    "keystore.md",
    "src/index.ts",
  ])("does not read %s as a key file", (path) => {
    expect(keys([path])).toEqual([]);
  });

  it.each([
    "test/.env",
    "tests/certs/server.pem",
    "src/user.test.ts.key",
    "testdata/id_rsa",
    "fixtures/.env.local",
    "Pkg/Fixtures/release.jks",
    "spec/support/client.p12",
    "__fixtures__/a.key",
  ])("leaves out %s under a test or fixture path", (path) => {
    expect(keys([path])).toEqual([]);
  });

  it("lists key files sorted by path and never needs their contents", () => {
    expect(keys(["b/.env", "a/server.pem", "a/.env"]).map((k) => k.path)).toEqual(["a/.env", "b/.env", "a/server.pem"]);
  });
});

describe("manifests, lockfiles and ecosystems", () => {
  it("reports a manifest with no lockfile of its ecosystem in its directory or any parent", () => {
    const paths = ["package.json", "Cargo.toml", "Cargo.lock", "svc/Gemfile", "svc/api/package.json"];
    expect(chainFacts({ paths }).missingLockfiles).toEqual(["package.json", "svc/Gemfile", "svc/api/package.json"]);
  });

  it("reports no manifest as missing its lockfile when the listing stopped short, since the lockfile may be unlisted", () => {
    // The same paths as above, where three manifests have no lockfile listed; a cut listing cannot show any is missing.
    const paths = ["package.json", "Cargo.toml", "Cargo.lock", "svc/Gemfile", "svc/api/package.json"];
    const cut = chainFacts({ paths, listingComplete: false });
    expect(cut.missingLockfiles).toEqual([]);
    // The rest of what the manifests say still stands.
    expect(cut.manifestsByEcosystem).toEqual(chainFacts({ paths }).manifestsByEcosystem);
    expect(cut.ecosystems).toEqual(chainFacts({ paths }).ecosystems);
  });

  it("treats a lockfile in a parent directory as covering a workspace package", () => {
    const paths = ["package.json", "package-lock.json", "packages/a/package.json", "packages/a/src/deep/package.json"];
    expect(chainFacts({ paths }).missingLockfiles).toEqual([]);
  });

  it("does not let a lockfile in a child or sibling directory cover a manifest", () => {
    const paths = ["package.json", "web/package-lock.json", "api/package.json"];
    expect(chainFacts({ paths }).missingLockfiles).toEqual(["api/package.json", "package.json"]);
  });

  it.each(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"])(
    "counts %s as an npm lockfile",
    (lock) => {
      expect(chainFacts({ paths: ["package.json", lock] }).missingLockfiles).toEqual([]);
    },
  );

  it("does not let another ecosystem's lockfile cover a manifest", () => {
    expect(chainFacts({ paths: ["package.json", "Cargo.lock", "Gemfile.lock"] }).missingLockfiles).toEqual(["package.json"]);
  });

  it("ignores manifests and lockfiles under test paths", () => {
    expect(
      chainFacts({ paths: ["test/fixtures/package.json", "package.json", "tests/package-lock.json"] }).missingLockfiles,
    ).toEqual(["package.json"]);
  });

  it("does not report a manifest of an ecosystem where lockfiles are not the norm", () => {
    expect(chainFacts({ paths: ["pyproject.toml", "go.mod", "pom.xml", "composer.json"] }).missingLockfiles).toEqual([]);
  });

  it("counts manifests per ecosystem and skips test paths and node_modules", () => {
    const paths = [
      "package.json",
      "web/package.json",
      "node_modules/x/package.json",
      "test/package.json",
      "Cargo.toml",
      "pyproject.toml",
      "requirements-dev.txt",
      "go.mod",
      "App/App.csproj",
      "foo.gemspec",
      "Gemfile",
      "src/index.ts",
    ];
    expect(chainFacts({ paths }).manifestsByEcosystem).toEqual({ bundler: 2, cargo: 1, gomod: 1, npm: 2, nuget: 1, pip: 2 });
  });

  it("has no manifests for a repository of source files", () => {
    expect(chainFacts({ paths: ["src/a.ts", "README.md"] }).manifestsByEcosystem).toEqual({});
  });

  it("names the Dependabot ecosystems from manifests, Dockerfiles, workflows and Terraform in a fixed order", () => {
    const paths = [
      "infra/main.tf",
      ".github/workflows/ci.yml",
      "Dockerfile",
      "pubspec.yaml",
      "pom.xml",
      "build.gradle.kts",
      "composer.json",
      "go.mod",
      "Gemfile",
      "Cargo.toml",
      "requirements.txt",
      "package.json",
      "App/App.fsproj",
    ];
    expect(chainFacts({ paths }).ecosystems).toEqual([
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
    ]);
  });

  it("names github-actions for a composite action alone and ignores test path Dockerfiles", () => {
    expect(chainFacts({ paths: [".github/actions/x/action.yml", "test/Dockerfile"] }).ecosystems).toEqual(["github-actions"]);
  });

  it("has no ecosystems for an empty repository", () => {
    expect(chainFacts().ecosystems).toEqual([]);
  });
});

describe("lockfile summaries", () => {
  it("passes the summaries it was given through, sorted by path", () => {
    const given = [
      { path: "z/yarn.lock", read: "parsed" as const, packages: 3, publicPackages: 2, capped: false },
      { path: "package-lock.json", read: "malformed" as const, packages: 0, publicPackages: 0, capped: false },
    ];
    expect(chainFacts({ paths: ["z/yarn.lock", "package-lock.json"], lockfiles: given }).lockfiles.map((l) => l.path)).toEqual([
      "package-lock.json",
      "z/yarn.lock",
    ]);
  });

  it("reports a pnpm lockfile it was never asked to read as not_supported, so it is not missing", () => {
    const found = chainFacts({ paths: ["package.json", "pnpm-lock.yaml"] });
    expect(found.lockfiles).toEqual([
      { path: "pnpm-lock.yaml", read: "not_supported", packages: 0, publicPackages: 0, capped: false },
    ]);
    expect(found.missingLockfiles).toEqual([]);
  });

  it("does not invent a summary for a readable lockfile nobody read", () => {
    expect(chainFacts({ paths: ["package-lock.json"] }).lockfiles).toEqual([]);
  });

  it("does not report a lockfile under a test path", () => {
    expect(chainFacts({ paths: ["test/pnpm-lock.yaml"] }).lockfiles).toEqual([]);
  });
});

describe("supplyChainFacts counts and bounds", () => {
  it("is version 2 and empty for an empty repository", () => {
    expect(chainFacts()).toEqual({
      version: 2,
      workflowsRead: 0,
      workflowsUnread: [],
      dockerfilesUnread: [],
      dockerfilesUnreadTotal: 0,
      actions: [],
      findings: [],
      securityTools: [],
      updateConfig: null,
      securityPolicy: null,
      manifestsByEcosystem: {},
      missingLockfiles: [],
      lockfiles: [],
      keyFiles: [],
      dockerfiles: [],
      ecosystems: [],
      listingComplete: true,
    });
  });

  it("carries whether the listing of the clone was complete", () => {
    expect(chainFacts({ listingComplete: true }).listingComplete).toBe(true);
    expect(chainFacts({ listingComplete: false }).listingComplete).toBe(false);
  });

  it("counts workflow files read but not composite actions, and lists the unread ones", () => {
    const found = chainFacts({
      paths: [],
      workflows: [
        file(".github/workflows/a.yml", "on: push\n"),
        file(".github/workflows/b.yml", "on: push\n"),
        file(".github/actions/x/action.yml", "runs: {}\n"),
      ],
      unread: [".github/workflows/c.yml"],
    });
    expect(found.workflowsRead).toBe(2);
    expect(found.workflowsUnread).toEqual([".github/workflows/c.yml"]);
  });

  it("ignores files that are not workflows or actions", () => {
    const found = chainFacts({ workflows: [file("src/ci.yml", "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n")] });
    expect(found.workflowsRead).toBe(0);
    expect(found.actions).toEqual([]);
  });

  it("reads at most 500 workflows and lists the rest as unread", () => {
    const workflows = Array.from({ length: 503 }, (_, i) =>
      file(`.github/workflows/w${String(i).padStart(3, "0")}.yml`, "on: push\n"),
    );
    const found = chainFacts({ workflows });
    expect(found.workflowsRead).toBe(500);
    expect(found.workflowsUnread).toEqual([
      ".github/workflows/w500.yml",
      ".github/workflows/w501.yml",
      ".github/workflows/w502.yml",
    ]);
  });

  it("lists a workflow or composite action in the listing that was not given, once, with the unreadable ones", () => {
    const found = chainFacts({
      paths: [
        ".github/workflows/a.yml",
        ".github/workflows/b.yml",
        ".github/workflows/c.yml",
        ".github/actions/x/action.yml",
        "src/ci.yml",
      ],
      workflows: [file(".github/workflows/a.yml", "on: push\n")],
      unread: [".github/workflows/c.yml"],
    });
    // c.yml is both unread and absent from what was given, and is listed once; the action is only in the listing.
    expect(found.workflowsUnread).toEqual([".github/workflows/c.yml", ".github/actions/x/action.yml", ".github/workflows/b.yml"]);
  });

  it("lists every workflow past the 500 cap from the listing", () => {
    const paths = Array.from({ length: 503 }, (_, i) => `.github/workflows/w${String(i).padStart(3, "0")}.yml`);
    const candidates = supplyChainCandidates(paths).workflows;
    expect(candidates).toHaveLength(500);
    const found = chainFacts({ paths, workflows: candidates.map((path) => file(path, "on: push\n")) });
    expect(found.workflowsUnread).toEqual(paths.slice(500));
  });

  it("lists the Dockerfiles past the 50 cap, and the ones passed as unread, once each", () => {
    const paths = Array.from({ length: 53 }, (_, i) => `d${String(i).padStart(2, "0")}/Dockerfile`);
    const candidates = supplyChainCandidates(paths).dockerfiles;
    expect(candidates).toHaveLength(50);
    const given = candidates.slice(1).map((path) => file(path, "FROM node:20"));
    const found = chainFacts({ paths, dockerfiles: given, unread: [candidates[0]!] });
    // 50 were candidates; one of them was unreadable, so three past the cap plus that one make four.
    expect(found.dockerfilesUnreadTotal).toBe(4);
    expect(found.dockerfilesUnread).toEqual(["d00/Dockerfile", "d50/Dockerfile", "d51/Dockerfile", "d52/Dockerfile"]);
    expect(found.workflowsUnread).toEqual([]);
    expect(found.dockerfiles).toHaveLength(49);
  });

  it("cuts the Dockerfiles not read at 200 paths and keeps the full count", () => {
    const paths = Array.from({ length: 260 }, (_, i) => `d${String(i).padStart(3, "0")}/Dockerfile`);
    const found = chainFacts({ paths });
    expect(found.dockerfilesUnread).toEqual(paths.slice(0, 200));
    expect(found.dockerfilesUnreadTotal).toBe(260);
  });

  it("does not report a Dockerfile that was read, or a file that only looks like one", () => {
    const found = chainFacts({
      paths: ["Dockerfile", "Dockerfile.md", "test/Dockerfile"],
      dockerfiles: [file("Dockerfile", "FROM node:20")],
    });
    expect(found.dockerfilesUnread).toEqual([]);
    expect(found.dockerfilesUnreadTotal).toBe(0);
  });

  it("reads workflows in path order so the output is stable", () => {
    const yaml = "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n";
    const found = chainFacts({ workflows: [file(".github/workflows/b.yml", yaml), file(".github/workflows/a.yml", yaml)] });
    expect(found.actions.map((a) => a.file)).toEqual([".github/workflows/a.yml", ".github/workflows/b.yml"]);
  });

  it("cuts a line at 2,000 characters so a long line cannot hide behind a limit", () => {
    const filler = "x".repeat(2_100);
    const yaml = `jobs:\n  b:\n    steps:\n      - run: echo ${filler} curl https://e.example/i | sh\n      - uses: actions/checkout@v4\n`;
    const found = workflowFacts(yaml);
    expect(found.findings.filter((f) => f.risk === "curlPipeShell")).toEqual([]);
    expect(found.actions).toHaveLength(1);
  });

  it("copes with a hostile file", () => {
    const hostile = [
      "on: [",
      "jobs:",
      "  ".repeat(1000) + "- uses:",
      "- run: |".repeat(500),
      "\u0000".repeat(100),
      "uses: ",
    ].join("\n");
    expect(() => workflowFacts(hostile)).not.toThrow();
  });
});

describe("supplyChainFacts on a whole workflow", () => {
  it("reads a realistic pull_request_target workflow end to end", () => {
    const yaml = [
      "name: Triage",
      "on:",
      "  pull_request_target:",
      "    types: [opened]",
      "jobs:",
      "  label:",
      "    runs-on: [self-hosted, linux]",
      "    steps:",
      `      - uses: actions/checkout@${SHA} # v4`,
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      '      - run: echo "${{ github.event.pull_request.title }}"',
      "      - uses: acme/labeller@v2",
    ].join("\n");
    const found = workflowFacts(yaml);
    // Lines: ref on 11, the injection on 12, the self-hosted runner on 7, the checkout without persist-credentials on 9.
    expect(found.findings.map((f) => `${f.risk}@${f.line}`).sort()).toEqual(
      ["noPermissions@null", "persistCredentials@9", "prHeadCheckout@11", "scriptInjection@12", "selfHosted@7"].sort(),
    );
    expect(found.actions.map((a) => `${a.action}:${a.pinned}`)).toEqual(["actions/checkout:true", "acme/labeller:false"]);
  });

  it("finds nothing wrong in a tidy workflow", () => {
    const yaml = [
      "on:",
      "  push:",
      "    branches: [main]",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${SHA} # v4`,
      "      - run: npm test",
    ].join("\n");
    expect(workflowFacts(yaml).findings).toEqual([]);
  });
});

describe("supplyChainFacts never reads key files", () => {
  it("takes key files from paths alone", () => {
    expect(
      supplyChainFacts({ paths: [".env"], listingComplete: true, workflows: [], lockfiles: [], unread: [] }).keyFiles,
    ).toEqual([{ path: ".env", strength: "strong" }]);
  });
});

// ---- review fixes ---------------------------------------------------------------------------------------------------

describe("hostile volume", () => {
  const head = (on: string) => `${on}\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n`;
  const steps = (on: string, count: number, step: (i: number) => string) =>
    head(on) + Array.from({ length: count }, (_, i) => step(i)).join("\n");

  it("returns capped findings for 100 nested run keys over 1,200 lines of five expressions each", () => {
    const nested = (depth: number) => {
      const keys = Array.from({ length: depth }, (_, i) => `${" ".repeat(i + 1)}run:`);
      const line = `${" ".repeat(depth + 1)}${"${{github.head_ref}} ".repeat(5).trim()}`;
      return head("on: pull_request_target") + [...keys, ...Array.from({ length: 1200 }, () => line)].join("\n");
    };
    const result = workflowFacts(nested(100));
    // 1,200 lines of five expressions is 6,000 matches when each is read once, and the module keeps 2,000 of them.
    expect(result.findings).toHaveLength(2000);
    expect(result.findings.every((f) => f.risk === "scriptInjection")).toBe(true);
    // The lines are read once whatever the depth. Reading the block again for each key would take four times as long.
    expect(growth(workflowFacts, nested(25), nested(100))).toBeLessThan(2);
  });

  it("returns capped findings from a file of many expressions, in time proportional to its length", () => {
    const yaml = (count: number) =>
      steps(
        "on: issue_comment",
        count,
        (i) =>
          `      - run: echo \${{ github.head_ref }} \${{ github.event.issue.title }} \${{ github.event.comment.body }} ${i}`,
      );
    // 5,000 lines of three expressions is 15,000 matches, and the module keeps 2,000 of them.
    expect(workflowFacts(yaml(5_000)).findings).toHaveLength(2000);
    expect(growth(workflowFacts, yaml(1_250), yaml(5_000))).toBeLessThan(PROPORTIONAL);
  });

  it("keeps at most 10,000 actions from a 20,000 line file of uses, in time proportional to its length", () => {
    // Six lines of head and 19,994 steps make the 20,000 lines the module reads, twice the actions it keeps.
    const yaml = (count: number) => steps("on: push", count, () => "      - uses: acme/tool@v1");
    expect(workflowFacts(yaml(19_994)).actions).toHaveLength(10_000);
    expect(growth(workflowFacts, yaml(2_500), yaml(10_000))).toBeLessThan(PROPORTIONAL);
  });

  it("looks for a step's own persist-credentials within a bounded window, so many checkouts take proportional time", () => {
    const yaml = (count: number) => steps("on: pull_request_target", count, () => "        uses: actions/checkout@v4");
    expect(workflowFacts(yaml(5_000)).findings).toHaveLength(2000);
    // Both sizes are well past the 200 rows the window reads each way, so only an unbounded search grows faster.
    expect(growth(workflowFacts, yaml(1_250), yaml(5_000))).toBeLessThan(PROPORTIONAL);
  });

  it("reads a run block once, however deeply its keys nest", () => {
    const yaml = withPermissions(
      "on: issue_comment",
      "      - run:\n         run:\n          run: echo ${{ github.event.issue.title }}",
    );
    // One expression on one line. Reading the block again for each nested run key would report it three times.
    expect(risks(yaml, "scriptInjection")).toEqual([
      { file: WORKFLOW_PATH, line: 9, risk: "scriptInjection", evidence: "github.event.issue.title" },
    ]);
  });

  it("reads run lines with long gaps between words in time proportional to the gap", () => {
    const yaml = (spaces: number) => steps("on: push", 250, () => `      - run: a${" ".repeat(spaces)}b`);
    expect(growth(workflowFacts, yaml(475), yaml(1900))).toBeLessThan(PROPORTIONAL);
  });
});

describe("trigger names", () => {
  const injection = (on: string) =>
    risks(withPermissions(on, "      - run: echo ${{ github.event.issue.title }}"), "scriptInjection");
  const checkout = (on: string) =>
    risks(withPermissions(on, "      - run: git checkout ${{ github.head_ref }}"), "prHeadCheckout");

  it.each([
    ["a flow map over several lines", "on: {\n  push: { branches: [main] },\n  issues: { types: [opened] }\n}"],
    ["a flow list over several lines", "on: [\n  push,\n  issues\n]"],
    ["a flow list that breaks after a comma", "on: [push,\n  issue_comment]"],
    ["a quoted name in a flow list", 'on: ["push", "discussion"]'],
    ["a name without a value in a flow map", "on: { push, issues }"],
  ])("finds a privileged trigger in %s", (_, on) => {
    expect(injection(on)).toHaveLength(1);
  });

  it.each([
    ["a nested name in a one line flow map", "on: { push: { branches: [issues] } }"],
    ["a nested name over several lines", "on: {\n  push: {\n    branches: [issues]\n  }\n}"],
    ["a nested list in a flow list", "on: [push, { workflow_dispatch: { inputs: issues } }]"],
    ["a nested name after a type list", "on: { pull_request: { types: [opened], branches: [issues, discussion] } }"],
  ])("does not take %s for a trigger", (_, on) => {
    expect(injection(on)).toEqual([]);
  });

  it("takes the top level names of a multi-line flow map for head checkouts too", () => {
    expect(checkout("on: {\n  pull_request_target: {},\n  push: {}\n}")).toHaveLength(1);
    expect(checkout("on: {\n  push: { branches: [pull_request_target] }\n}")).toEqual([]);
  });

  describe("when a bracket never closes", () => {
    // GitHub rejects such a file, so a finding can only land on a file that does not run, while a legal spelling this
    // reader failed to follow would otherwise hide a finding. Unknown triggers count as privileged.
    it("treats the triggers as possibly privileged and reports an injection", () => {
      expect(injection("on: [push, pull_request")).toHaveLength(1);
    });

    it("treats the triggers as possibly able to check out a pull request head", () => {
      expect(checkout("on: { push: {}")).toHaveLength(1);
    });

    it("notes a self-hosted runner as possibly reached by pull requests", () => {
      const yaml = "on: [push\njobs:\n  b:\n    runs-on: self-hosted\n    steps: []\n";
      expect(risks(yaml, "selfHosted")).toMatchObject([{ onPullRequest: true }]);
    });

    it("adds nothing to a file with nothing to find", () => {
      expect(workflowFacts(withPermissions("on: [push, pull_request", "      - run: echo hi")).findings).toEqual([]);
    });

    it("still reads a closed list as it is written", () => {
      expect(injection("on: [push, pull_request]")).toEqual([]);
      expect(checkout("on: [push]")).toEqual([]);
    });
  });
});

describe("script injection in comments and conditions", () => {
  const run = (step: string, on = "on: issue_comment") => risks(withPermissions(on, step), "scriptInjection");

  it("does not count a full-line comment in a block", () => {
    expect(run("      - run: |\n          # echo ${{ github.event.issue.title }}\n          echo ok")).toEqual([]);
  });

  it("does not count an indented comment either, and still counts the next real line", () => {
    const found = run(
      "      - run: |\n          # note\n              # ${{ github.head_ref }}\n          echo ${{ github.head_ref }}",
    );
    expect(found).toMatchObject([{ line: 10, evidence: "github.head_ref" }]);
  });

  it("still counts interpolation before a trailing comment", () => {
    expect(run("      - run: |\n          echo ${{ github.head_ref }} # trailing")).toHaveLength(1);
  });

  it.each([
    "contains(github.event.pull_request.title, 'x')",
    "startsWith(github.event.issue.title, 'fix')",
    "endsWith(github.event.issue.title, 'now')",
    "!contains(github.event.issue.body, 'skip')",
    "github.event.issue.title == 'release'",
    "github.event.issue.title != ''",
    "'github.event.issue.title'",
  ])("does not flag %s, which holds no text from the event", (expression) => {
    expect(run(`      - run: echo \${{ ${expression} }}`)).toEqual([]);
  });

  it.each([
    "contains(github.event.issue.title, 'x') && github.event.issue.title",
    "github.event.issue.title || 'none'",
    "format('{0}', github.event.issue.title)",
    "toJSON(github.event.issue.title)",
    "contains('a', 'a') && github.head_ref",
  ])("still flags %s, which can carry the text through", (expression) => {
    expect(run(`      - run: echo \${{ ${expression} }}`)).toHaveLength(1);
  });
});

describe("pull request head references", () => {
  const under = (on: string, step: string) => risks(withPermissions(on, step), "prHeadCheckout");
  const withKey = (key: string, value: string) => `      - uses: actions/checkout@v4\n        with:\n          ${key}: ${value}`;
  const target = "on: pull_request_target";

  it.each([
    "${{ github.event.pull_request.merge_commit_sha }}",
    "pull/123/head",
    "pull/${{ github.event.number }}/merge",
    "pull/${{ github.event.pull_request.number }}/head",
    "refs/pull/123/merge",
    "${{ github.event.workflow_run.pull_requests[0].head.sha }}",
  ])("flags a ref of %s under pull_request_target", (value) => {
    expect(under(target, withKey("ref", value))).toHaveLength(1);
  });

  it("flags a repository of the pull request's fork, with the expression as evidence", () => {
    expect(under(target, withKey("repository", "${{ github.event.pull_request.head.repo.full_name }}"))).toEqual([
      { file: WORKFLOW_PATH, line: 9, risk: "prHeadCheckout", evidence: "github.event.pull_request.head.repo.full_name" },
    ]);
  });

  it("flags the fork repository of a workflow run", () => {
    const on = "on:\n  workflow_run:\n    workflows: [CI]";
    expect(under(on, withKey("repository", "${{ github.event.workflow_run.head_repository.full_name }}"))).toHaveLength(1);
  });

  it.each(["git fetch origin pull/123/head:pr", "git fetch origin pull/${{ github.event.number }}/merge"])(
    "flags the command %s",
    (command) => {
      expect(under(target, `      - run: ${command}`)).toHaveLength(1);
    },
  );

  it.each([
    ["a repository that is the repository itself", withKey("repository", "${{ github.repository }}")],
    ["a named repository", withKey("repository", "acme/widgets")],
    ["a base commit", withKey("ref", "${{ github.event.pull_request.base.sha }}")],
    ["the default branch", withKey("ref", "${{ github.event.repository.default_branch }}")],
    ["a ref named pull", withKey("ref", "pull-request-docs")],
    ["a URL with a pull path", "      - run: git fetch https://github.com/acme/widgets/pull/12/head"],
    ["a tag that looks like a pull ref after a slash", withKey("ref", "releases/pull/12/head")],
  ])("does not flag %s", (_, step) => {
    expect(under(target, step)).toEqual([]);
  });

  it("does not flag the fork repository or the merge commit under pull_request", () => {
    expect(under("on: pull_request", withKey("repository", "${{ github.event.pull_request.head.repo.full_name }}"))).toEqual([]);
    expect(under("on: pull_request", withKey("ref", "${{ github.event.pull_request.merge_commit_sha }}"))).toEqual([]);
  });
});

describe("runs-on labels", () => {
  const wrap = (job: string) => `on: push\npermissions: {}\njobs:\n  b:\n${job}`;
  const found = (job: string) => risks(wrap(job), "selfHosted");

  it.each([
    ["a scalar", "    runs-on: self-hosted\n    steps: []\n"],
    ["a quoted scalar", '    runs-on: "self-hosted"\n    steps: []\n'],
    ["a flow list", "    runs-on: [self-hosted, linux]\n    steps: []\n"],
    ["a flow list with the label last", "    runs-on: [linux, self-hosted]\n    steps: []\n"],
    ["a flow list of quoted labels", "    runs-on: ['linux', 'self-hosted']\n    steps: []\n"],
    ["a block list", "    runs-on:\n      - self-hosted\n      - linux\n    steps: []\n"],
    ["a block list at the key's own indent", "    runs-on:\n    - linux\n    - self-hosted\n    steps: []\n"],
    ["a group with labels", "    runs-on:\n      group: ci\n      labels: [self-hosted]\n    steps: []\n"],
    ["a flow list over several lines", "    runs-on: [\n      linux,\n      self-hosted\n    ]\n    steps: []\n"],
    [
      "an expression that names it",
      "    runs-on: ${{ github.event_name == 'push' && 'self-hosted' || 'ubuntu-latest' }}\n    steps: []\n",
    ],
  ])("flags %s", (_, job) => {
    expect(found(job)).toMatchObject([{ line: 5, evidence: "self-hosted" }]);
  });

  it.each([
    ["a longer runner name", "    runs-on: my-self-hosted-linux\n    steps: []\n"],
    ["a longer name in a list", "    runs-on: [linux, self-hosted-arm]\n    steps: []\n"],
    ["a prefix of a label", "    runs-on: [not-self-hosted]\n    steps: []\n"],
    [
      "a later step name",
      "    runs-on: ubuntu-latest\n    steps:\n      - name: Warm the self-hosted cache\n        run: echo\n",
    ],
    ["a later job's runner", "    runs-on: ubuntu-latest\n  c:\n    runs-on: ubuntu-22.04\n"],
    [
      "a block list that stops at the next key",
      "    runs-on:\n      - ubuntu-latest\n    steps:\n      - run: echo self-hosted\n",
    ],
    ["a key after the list at the same indent", "    runs-on: ubuntu-latest\n    name: self-hosted build\n    steps: []\n"],
  ])("does not flag %s", (_, job) => {
    expect(found(job)).toEqual([]);
  });
});

describe("shell commands over several lines", () => {
  const pipes = (step: string) => risks(withPermissions("on: push", step), "curlPipeShell");
  const docker = (content: string) =>
    chainFacts({ paths: ["Dockerfile"], dockerfiles: [file("Dockerfile", content)] }).dockerfiles[0]!;

  it("joins a backslash continuation in a Dockerfile", () => {
    expect(docker("FROM node:20\nRUN curl -fsSL https://example.com/i.sh \\\n  | bash").curlPipeShell).toBe(true);
  });

  it("joins continuations across comments and several lines in a Dockerfile", () => {
    const content = "FROM node:20\nRUN set -e \\\n  # fetch it\n  && curl -fsSL https://example.com/i.sh \\\n  | sh";
    expect(docker(content).curlPipeShell).toBe(true);
  });

  it("does not join a Dockerfile line that does not end in a backslash", () => {
    expect(docker("FROM node:20\nRUN curl -fsSL https://example.com/i.sh\nRUN echo | bash").curlPipeShell).toBe(false);
  });

  it("reads an ADD whose URL is on the next line", () => {
    expect(docker("FROM node:20\nADD \\\n  https://example.com/a.tar.gz /a").addsRemote).toBe(true);
  });

  it("joins a backslash continuation in a run block and names the first line", () => {
    const step = "      - run: |\n          curl -fsSL https://example.com/i.sh \\\n            | bash";
    expect(pipes(step)).toEqual([{ file: WORKFLOW_PATH, line: 8, risk: "curlPipeShell", evidence: "curl | bash" }]);
  });

  it("joins a line that ends in a pipe in a run block", () => {
    expect(pipes("      - run: |\n          wget -qO- https://example.com/i.sh |\n            sh")).toHaveLength(1);
  });

  it("does not join across a block's lines that carry no continuation", () => {
    expect(pipes("      - run: |\n          curl -fsSL https://example.com/i.sh\n          echo | bash")).toEqual([]);
  });

  it("does not read a commented line in a run block as a command", () => {
    expect(pipes("      - run: |\n          # curl https://example.com/i.sh | bash\n          echo ok")).toEqual([]);
  });

  it.each([
    "curl -fsSL https://example.com/i.sh | sh",
    "curl -fsSL https://example.com/i.sh | bash",
    "curl -fsSL https://example.com/i.sh | zsh",
    "curl -fsSL https://example.com/i.sh | sudo bash",
    "curl -fsSL https://example.com/i.sh | sudo -E bash",
    "curl -fsSL https://example.com/i.sh | python",
    "curl -fsSL https://example.com/i.sh | python3",
    "curl -fsSL https://example.com/i.sh | python3 -",
    "curl -fsSL https://example.com/i.sh | python3.11",
    "curl -fsSL https://example.com/i.sh | node",
    "curl -fsSL https://example.com/i.sh | node -",
    "wget -qO- https://example.com/i.sh | sh -s -- --yes",
    'curl -s https://example.com/a | python3 -c "print(1)"; curl -s https://example.com/b | bash',
  ])("flags %s", (command) => {
    expect(pipes(`      - run: ${command}`)).toHaveLength(1);
  });

  it.each([
    'curl -s https://example.com/a | python3 -c "import sys; print(sys.stdin.read())"',
    "curl -s https://example.com/a | python -c 'print(1)'",
    "curl -s https://example.com/a | python3 -m json.tool",
    'curl -s https://example.com/a | node -p "1"',
    'curl -s https://example.com/a | node -e "1"',
    'curl -s https://example.com/a | node --eval "1"',
    "curl -s https://example.com/a | jq .",
    "curl -s https://example.com/a | shellcheck -",
    "curl -s https://example.com/a | node-gyp rebuild",
    "curl -s https://example.com/a > a.sh && bash a.sh",
  ])("does not flag %s", (command) => {
    expect(pipes(`      - run: ${command}`)).toEqual([]);
  });

  it("reports the piped interpreter", () => {
    expect(pipes("      - run: curl -fsSL https://example.com/i.sh | python3")[0]!.evidence).toBe("curl | python3");
  });
});

describe("docker action digests", () => {
  const uses = (digest: string) =>
    workflowFacts(`jobs:\n  b:\n    steps:\n      - uses: docker://alpine@${digest}\n`).actions[0]!;

  it.each([
    [`sha256:${"a".repeat(64)}`, true],
    [`sha256:${"A".repeat(64)}`, true],
    [`sha256:${"a".repeat(63)}`, false],
    [`sha256:${"a".repeat(65)}`, false],
    ["sha256:abc", false],
    [`sha256:${"g".repeat(64)}`, false],
  ])("treats %s as pinned: %s", (digest, pinned) => {
    expect(uses(digest)).toMatchObject({ pinned, kind: "docker", ref: digest });
  });
});

describe("Dockerfile paths", () => {
  const names = [
    "Dockerfile",
    "Dockerfile.dev",
    "app.dockerfile",
    "Containerfile",
    "Dockerfile.md",
    "Dockerfile.dockerignore",
    "docs/Dockerfile.txt",
    "Dockerfile.json",
    "Dockerfile.yml",
    "Dockerfile.yaml",
    "Dockerfile.sh",
    "Dockerfile.dev.md",
  ];

  it("lists Dockerfiles and leaves out the files that only sit beside one", () => {
    expect(supplyChainCandidates(names).dockerfiles).toEqual(["Containerfile", "Dockerfile", "Dockerfile.dev", "app.dockerfile"]);
  });

  it("does not read the contents of such files, and does not call for Dependabot's docker ecosystem", () => {
    const found = chainFacts({ paths: ["Dockerfile.md"], dockerfiles: [file("Dockerfile.md", "FROM node:latest")] });
    expect(found.dockerfiles).toEqual([]);
    expect(found.ecosystems).toEqual([]);
  });
});

describe("runsAsRoot by base image and stage", () => {
  const root = (content: string) =>
    chainFacts({ paths: ["Dockerfile"], dockerfiles: [file("Dockerfile", content)] }).dockerfiles[0]!.runsAsRoot;

  it.each([
    ["a distroless nonroot tag", "FROM gcr.io/distroless/static-debian12:nonroot", false],
    ["a distroless debug-nonroot tag", "FROM gcr.io/distroless/base-debian12:debug-nonroot", false],
    ["a latest-nonroot tag", "FROM gcr.io/distroless/base:latest-nonroot", false],
    ["a nonroot flavour in the middle of a tag", "FROM acme/app:20-nonroot-slim", false],
    ["a Chainguard image", "FROM cgr.dev/chainguard/node:latest", false],
    ["a Chainguard image without a tag", "FROM cgr.dev/acme/static", false],
    ["a distroless image with no nonroot tag", "FROM gcr.io/distroless/static-debian12", true],
    ["a distroless image at latest", "FROM gcr.io/distroless/static-debian12:latest", true],
    ["a tag that only contains the letters", "FROM acme/app:nonrooted", true],
    ["a nonroot image that then sets USER root", "FROM gcr.io/distroless/static:nonroot\nUSER root", true],
    ["a nonroot image that sets USER 0", "FROM cgr.dev/chainguard/node\nUSER 0", true],
    ["a nonroot image with a normal USER", "FROM gcr.io/distroless/static:nonroot\nUSER 65532", false],
  ])("is root for %s: %s", (_, content, expected) => {
    expect(root(content)).toBe(expected);
  });

  it("judges the last stage by its own base image, whatever the build stage was", () => {
    expect(root("FROM node:20 AS build\nFROM gcr.io/distroless/nodejs20:nonroot\nCOPY --from=build /a /a")).toBe(false);
    expect(root("FROM gcr.io/distroless/static:nonroot AS build\nFROM alpine:3.19\nCOPY --from=build /a /a")).toBe(true);
  });

  it("lets a stage built on an earlier stage keep that stage's user", () => {
    expect(root("FROM node:20 AS base\nUSER app\nFROM base AS final")).toBe(false);
    expect(root("FROM gcr.io/distroless/static:nonroot AS base\nFROM base")).toBe(false);
  });

  it("calls a stage built on an earlier root stage root", () => {
    expect(root("FROM node:20 AS base\nFROM base")).toBe(true);
    expect(root("FROM node:20 AS base\nUSER app\nFROM base AS final\nUSER root")).toBe(true);
  });

  it("does not let a USER in a derived stage change the stage it was built on", () => {
    expect(root("FROM node:20 AS base\nFROM base AS dev\nUSER app\nFROM base")).toBe(true);
  });
});

describe("key files by strength and cap", () => {
  const keys = (paths: string[]) => chainFacts({ paths }).keyFiles;

  it("keeps the strong files when more than 200 weak ones sort before them", () => {
    const weak = Array.from({ length: 211 }, (_, i) => `certs/c${String(i).padStart(3, "0")}.pem`);
    const found = keys([...weak, "zz/id_rsa", "zz/.env.production", "zz/.env"]);
    // Strong files come first, each in path order, then 200 of the 211 weak ones.
    expect(found.slice(0, 3)).toEqual([
      { path: "zz/.env", strength: "strong" },
      { path: "zz/.env.production", strength: "strong" },
      { path: "zz/id_rsa", strength: "strong" },
    ]);
    expect(found.filter((k) => k.strength === "weak")).toHaveLength(200);
    expect(found).toHaveLength(203);
  });

  it("cuts each strength at 200 on its own", () => {
    const strong = Array.from({ length: 250 }, (_, i) => `s${String(i).padStart(3, "0")}/.env`);
    const found = keys([...strong, "a/server.pem"]);
    expect(found.filter((k) => k.strength === "strong")).toHaveLength(200);
    expect(found.filter((k) => k.strength === "weak")).toEqual([{ path: "a/server.pem", strength: "weak" }]);
  });

  it("puts the files committed on purpose with the weak ones, so they never lower the grade", () => {
    expect(keys([".env.test", ".env.dev", "x/.env.dev-acme", ".env.ci", "debug.keystore"])).toEqual([
      { path: "x/.env.dev-acme", strength: "strong" },
      { path: ".env.ci", strength: "weak" },
      { path: ".env.dev", strength: "weak" },
      { path: ".env.test", strength: "weak" },
      { path: "debug.keystore", strength: "weak" },
    ]);
  });
});
