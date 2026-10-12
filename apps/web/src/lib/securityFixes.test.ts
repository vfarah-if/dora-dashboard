import { describe, expect, it } from "vitest";
import type { SecurityActionKind } from "@dora-dashboard/core";
import { copy } from "../copy";
import { securityAction } from "../test/fixtures";
import { ACTION_EFFORT } from "./security";
import {
  BRANCH_KINDS,
  LEARN_MORE,
  SETTINGS_KINDS,
  SNIPPETS,
  branchSettingsUrl,
  codeownersSnippet,
  codeqlLanguages,
  codeqlSnippet,
  dependabotYml,
  digestSnippet,
  firstActionRepo,
  gitignoreSnippet,
  isSafePath,
  nonRootSnippet,
  permissionsSnippet,
  persistCredentialsSnippet,
  pinnedUsesSnippet,
  pullRequestTargetSnippet,
  pullRequestTriggerSnippet,
  scriptInjectionRisky,
  scriptInjectionSnippet,
  securityPolicyMarkdown,
  settingsLinkFor,
  shaLookupSnippet,
  snippetsFor,
  untrackSnippet,
  upgradeAdvice,
  upgradeInstruction,
  type FixContext,
  type UpgradeAdvice,
  type UpgradeInput,
} from "./securityFixes";

const KINDS = Object.keys(ACTION_EFFORT) as SecurityActionKind[];
const NO_DASH = /[–—]/;

const context: FixContext = {
  repo: { owner: "acme", name: "widgets" },
  ecosystems: ["npm", "github-actions"],
  branch: "main",
  settingsUrl: "https://github.com/acme/widgets/settings/security_analysis",
};

const input = (overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
  ecosystem: "npm",
  manifestPath: "package-lock.json",
  name: "left-pad",
  version: "1.3.1",
  relationship: "direct",
  ...overrides,
});

/** The command of a command advice, failing the test when the advice is an instruction. */
const commandOf = (advice: UpgradeAdvice | null): string => {
  expect(advice?.kind).toBe("command");
  return (advice as Extract<UpgradeAdvice, { kind: "command" }>).command;
};

const instructionOf = (advice: UpgradeAdvice | null) => {
  expect(advice?.kind).toBe("instruction");
  return advice as Extract<UpgradeAdvice, { kind: "instruction" }>;
};

describe("upgradeAdvice for a direct dependency", () => {
  it.each([
    ["npm", "package-lock.json", "npm install left-pad@1.3.1"],
    ["npm", "apps/web/package.json", "cd apps/web && npm install left-pad@1.3.1"],
    ["npm", "npm-shrinkwrap.json", "npm install left-pad@1.3.1"],
    ["npm", "pnpm-lock.yaml", "pnpm update left-pad@1.3.1"],
    ["pip", "poetry.lock", "poetry add left-pad@^1.3.1"],
    ["pip", "uv.lock", "uv lock --upgrade-package left-pad==1.3.1"],
    ["pip", "Pipfile.lock", "pipenv install left-pad==1.3.1"],
    ["rust", "Cargo.lock", "cargo update -p left-pad --precise 1.3.1"],
    ["rubygems", "Gemfile.lock", "bundle update left-pad --conservative"],
    ["go", "go.mod", "go get left-pad@v1.3.1 && go mod tidy"],
    ["go", "go.sum", "go get left-pad@v1.3.1 && go mod tidy"],
    ["composer", "composer.lock", "composer update left-pad --with left-pad:1.3.1"],
    ["nuget", "src/App/App.csproj", "cd src/App && dotnet add package left-pad --version 1.3.1"],
    ["nuget", "packages.lock.json", "dotnet add package left-pad --version 1.3.1"],
  ])("chooses the command for %s from %s", (ecosystem, path, expected) => {
    expect(commandOf(upgradeAdvice(input({ ecosystem, manifestPath: path })))).toBe(expected);
  });

  it("matches the file name whatever its case or folder", () => {
    expect(commandOf(upgradeAdvice(input({ manifestPath: "Apps/Web/PACKAGE-LOCK.JSON", ecosystem: null })))).toBe(
      "cd Apps/Web && npm install left-pad@1.3.1",
    );
  });

  it("does not double the v of a Go version", () => {
    expect(
      commandOf(upgradeAdvice(input({ ecosystem: "go", manifestPath: "go.mod", name: "golang.org/x/net", version: "v0.17.0" }))),
    ).toBe("go get golang.org/x/net@v0.17.0 && go mod tidy");
  });

  it("keeps a scoped npm name whole", () => {
    expect(commandOf(upgradeAdvice(input({ name: "@acme/ui", version: "2.0.0" })))).toBe("npm install @acme/ui@2.0.0");
  });

  it("falls back to the ecosystem when the file is not one it knows", () => {
    for (const [ecosystem, expected] of [
      ["npm", "npm install left-pad@1.3.1"],
      ["RubyGems", "bundle update left-pad --conservative"],
      ["crates.io", "cargo update -p left-pad --precise 1.3.1"],
      ["Composer", "composer update left-pad --with left-pad:1.3.1"],
      ["NuGet", "dotnet add package left-pad --version 1.3.1"],
      ["go", "go get left-pad@v1.3.1 && go mod tidy"],
      ["gomod", "go get left-pad@v1.3.1 && go mod tidy"],
      ["uv", "uv lock --upgrade-package left-pad==1.3.1"],
      ["bundler", "bundle update left-pad --conservative"],
      ["cargo", "cargo update -p left-pad --precise 1.3.1"],
      ["rust", "cargo update -p left-pad --precise 1.3.1"],
    ] as const) {
      expect(commandOf(upgradeAdvice(input({ ecosystem, manifestPath: "somewhere/unknown.lock" })))).toBe(
        `cd somewhere && ${expected}`,
      );
      expect(commandOf(upgradeAdvice(input({ ecosystem, manifestPath: null })))).toBe(expected);
    }
  });

  it("gives words for the ecosystems whose fix is a file edit, when the file is not one it knows", () => {
    for (const ecosystem of ["PyPI", "pip", "Maven", "gradle"]) {
      expect(upgradeAdvice(input({ ecosystem, manifestPath: null }))?.kind).toBe("instruction");
    }
  });

  it("answers null for an unknown package manager", () => {
    expect(upgradeAdvice(input({ ecosystem: "swift", manifestPath: "Package.resolved" }))).toBeNull();
    expect(upgradeAdvice(input({ ecosystem: null, manifestPath: null }))).toBeNull();
  });

  it("answers null without a fixed version", () => {
    expect(upgradeAdvice(input({ version: null }))).toBeNull();
    expect(upgradeAdvice(input({ version: "" }))).toBeNull();
  });

  it("notes what stops a command reaching the fixed version, where the tool cannot go outside a constraint", () => {
    const note = (manifestPath: string, ecosystem: string) =>
      (upgradeAdvice(input({ ecosystem, manifestPath })) as Extract<UpgradeAdvice, { kind: "command" }>).note;
    expect(note("Gemfile.lock", "rubygems")).toContain("Gemfile");
    expect(note("composer.lock", "composer")).toContain("composer.json");
    expect(note("Cargo.lock", "rust")).toContain("Cargo.toml");
    expect(note("poetry.lock", "pip")).toContain("--group dev");
    expect(note("Pipfile.lock", "pip")).toContain("--dev");
    expect(note("package-lock.json", "npm")).toBeNull();
  });
});

describe("upgradeAdvice for a package that comes in through another", () => {
  it.each(["transitive", "mixed"] as const)(
    "does not install an npm %s package, and offers an override instead",
    (relationship) => {
      const advice = instructionOf(upgradeAdvice(input({ relationship })));
      expect(advice.text).toContain("force");
      expect(advice.text).toContain("an override in package.json");
      expect(advice.text).not.toContain("npm install");
      expect(advice.command).toBe("npm update left-pad");
      expect(advice.snippet).toEqual({
        id: "npmOverrides",
        code: ["{", '  "overrides": {', '    "left-pad": "1.3.1"', "  }", "}"].join("\n"),
      });
      expect(JSON.parse(advice.snippet!.code)).toEqual({ overrides: { "left-pad": "1.3.1" } });
    },
  );

  it("says a mixed package is also a direct dependency", () => {
    expect(instructionOf(upgradeAdvice(input({ relationship: "mixed" }))).text).toContain("direct dependency in some places");
    expect(instructionOf(upgradeAdvice(input({ relationship: "transitive" }))).text).not.toContain("direct dependency in some");
  });

  it("uses a resolution for Yarn and an override under pnpm for pnpm, each as valid JSON, and no command", () => {
    const yarn = instructionOf(upgradeAdvice(input({ manifestPath: "yarn.lock", relationship: "transitive" })));
    expect(yarn.command).toBeNull();
    expect(yarn.snippet!.id).toBe("yarnResolutions");
    expect(JSON.parse(yarn.snippet!.code)).toEqual({ resolutions: { "left-pad": "1.3.1" } });
    const pnpm = instructionOf(upgradeAdvice(input({ manifestPath: "pnpm-lock.yaml", relationship: "transitive" })));
    expect(pnpm.command).toBeNull();
    expect(pnpm.snippet!.id).toBe("pnpmOverrides");
    expect(JSON.parse(pnpm.snippet!.code)).toEqual({ pnpm: { overrides: { "left-pad": "1.3.1" } } });
  });

  it("runs the in-place update in the manifest's own folder", () => {
    const advice = instructionOf(
      upgradeAdvice(input({ manifestPath: "apps/web/package-lock.json", relationship: "transitive" })),
    );
    expect(advice.command).toBe("cd apps/web && npm update left-pad");
  });

  it("updates a Poetry package in place and explains the limit, instead of adding it as a direct dependency", () => {
    const advice = upgradeAdvice(input({ manifestPath: "poetry.lock", relationship: "transitive" }));
    expect(commandOf(advice)).toBe("poetry update left-pad");
    expect(commandOf(advice)).not.toContain("add");
  });

  it("keeps commands that already work for indirect packages", () => {
    expect(commandOf(upgradeAdvice(input({ manifestPath: "Cargo.lock", relationship: "transitive" })))).toBe(
      "cargo update -p left-pad --precise 1.3.1",
    );
    expect(commandOf(upgradeAdvice(input({ manifestPath: "go.mod", relationship: "transitive" })))).toBe(
      "go get left-pad@v1.3.1 && go mod tidy",
    );
    const nuget = upgradeAdvice(input({ manifestPath: "App.csproj", relationship: "transitive" })) as Extract<
      UpgradeAdvice,
      { kind: "command" }
    >;
    expect(nuget.note).toContain("direct reference");
  });

  it("gives a plain instruction for Pipenv", () => {
    expect(instructionOf(upgradeAdvice(input({ manifestPath: "Pipfile.lock", relationship: "transitive" }))).command).toBeNull();
  });

  it("treats a package with no known relationship as direct", () => {
    expect(commandOf(upgradeAdvice(input({ relationship: null })))).toBe("npm install left-pad@1.3.1");
  });
});

describe("upgradeAdvice that is prose and not a command", () => {
  it.each([
    ["pip", "requirements.txt", "Set left-pad==1.3.1 in requirements.txt, then install the requirements again."],
    ["pip", "deploy/requirements-dev.txt", "Set left-pad==1.3.1 in requirements-dev.txt, then install the requirements again."],
    [
      "pip",
      "yarn.lock",
      "Change left-pad to 1.3.1 in package.json, then run yarn install. The command differs between Yarn versions, so this works for both.",
    ],
    ["maven", "pom.xml", copy.security.upgradeText.build("left-pad", "1.3.1")],
    ["gradle", "app/build.gradle.kts", copy.security.upgradeText.build("left-pad", "1.3.1")],
  ])("returns an instruction for %s from %s", (ecosystem, path, text) => {
    const advice = instructionOf(upgradeAdvice(input({ ecosystem, manifestPath: path })));
    expect(advice.text).toBe(text);
    expect(advice.command).toBeNull();
    expect(advice.snippet).toBeNull();
  });
});

describe("upgradeAdvice in a folder", () => {
  it("runs the command in the manifest's folder and adds nothing at the root", () => {
    expect(commandOf(upgradeAdvice(input({ manifestPath: "services/billing/go.mod", ecosystem: "go" })))).toBe(
      "cd services/billing && go get left-pad@v1.3.1 && go mod tidy",
    );
    expect(commandOf(upgradeAdvice(input({ manifestPath: "package-lock.json" })))).toBe("npm install left-pad@1.3.1");
  });

  it.each([
    "../outside/package-lock.json",
    "/abs/package-lock.json",
    "a b/package-lock.json",
    "-x/package-lock.json",
    "a;b/package-lock.json",
    "a/./b/package-lock.json",
    "a//b/package-lock.json",
    "$(id)/package-lock.json",
  ])("does not put an unsafe folder %j after cd, and says to work in the folder instead", (path) => {
    const advice = instructionOf(upgradeAdvice(input({ manifestPath: path })));
    expect(advice.text).toBe(copy.security.upgradeText.folder("left-pad", "1.3.1"));
    expect(advice.command).toBeNull();
  });

  it("accepts a scoped folder and a hidden one", () => {
    expect(isSafePath("packages/@scope/app")).toBe(true);
    expect(isSafePath(".github/workflows")).toBe(true);
    expect(isSafePath("")).toBe(false);
  });
});

describe("upgradeAdvice refuses unsafe values", () => {
  it.each(["left-pad; rm -rf /", "left pad", "$(whoami)", "a`b`", "x|y", "a&&b", "x\ny", "a'b", "--force", "-x", "~x", "-", "~"])(
    "refuses a package name that a shell would treat as syntax or as an option, %j",
    (name) => {
      expect(upgradeAdvice(input({ name }))).toBeNull();
    },
  );

  it.each(["1.0.0; id", "1 0", "$(id)", "1.0|x", "--force", "-x", "~x", "~1.0.0", "-1"])(
    "refuses a version that a shell would treat as syntax or as an option, %j",
    (version) => {
      expect(upgradeAdvice(input({ version }))).toBeNull();
    },
  );

  it("still accepts a name or version with a dash, tilde or plus inside, and a leading v or @", () => {
    expect(commandOf(upgradeAdvice(input({ name: "left-pad", version: "1.3.1-beta.1+build~2" })))).toContain(
      "left-pad@1.3.1-beta.1+build~2",
    );
    expect(commandOf(upgradeAdvice(input({ name: "@acme/ui-kit", version: "v2.0.0" })))).toContain("@acme/ui-kit@v2.0.0");
  });
});

describe("fixed snippets", () => {
  it("limits the token to reading", () => {
    expect(permissionsSnippet()).toBe("permissions:\n  contents: read");
  });

  it("pins an action with a placeholder commit and the tag the finding named, and shows how to find the commit", () => {
    expect(pinnedUsesSnippet({ repo: "acme-tools/setup", ref: "v2" })).toBe(
      "- uses: acme-tools/setup@<full 40 character commit sha> # v2",
    );
    expect(shaLookupSnippet({ repo: "acme-tools/setup", ref: "v2.1.0" })).toBe(
      "gh api repos/acme-tools/setup/commits/v2.1.0 --jq .sha",
    );
  });

  it("marks the tag as a placeholder when the finding named none that is safe, instead of claiming v4", () => {
    expect(pinnedUsesSnippet()).toBe("- uses: owner/action@<full 40 character commit sha> # <version tag>");
    expect(shaLookupSnippet()).toBe("gh api repos/owner/action/commits/<version tag> --jq .sha");
    expect(pinnedUsesSnippet({ repo: "acme/x", ref: "v1; rm" })).toContain("# <version tag>");
    expect(shaLookupSnippet({ repo: "acme/x", ref: "a..b" })).toContain("commits/<version tag>");
  });

  it("copies only the safe way to use text written by outsiders, and shows the risky way apart", () => {
    const safe = scriptInjectionSnippet();
    expect(safe).toBe(["- env:", "    TITLE: ${{ github.event.issue.title }}", '  run: echo "$TITLE"'].join("\n"));
    expect(safe).not.toContain('echo "${{');
    expect(scriptInjectionRisky()).toBe('- run: echo "${{ github.event.issue.title }}"');
  });

  it("gives the pull_request trigger and the pull_request_target block as two separate snippets, each with one on key", () => {
    expect(pullRequestTriggerSnippet().match(/^on:/gm)).toHaveLength(1);
    expect(pullRequestTargetSnippet().match(/^on:/gm)).toHaveLength(1);
    expect(pullRequestTriggerSnippet()).not.toContain("pull_request_target");
    expect(pullRequestTargetSnippet()).not.toContain("head.sha");
    expect(pullRequestTargetSnippet()).toContain("contents: read");
  });

  it("asks for pull-requests write only in a comment, because the block does not need it", () => {
    const writes = pullRequestTargetSnippet()
      .split("\n")
      .filter((line) => line.includes("pull-requests: write"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^#/);
  });

  it("writes a starting security policy for the repository with a marked contact placeholder", () => {
    const text = securityPolicyMarkdown("acme/widgets");
    expect(text.split("\n")[0]).toBe("# Security policy for acme/widgets");
    expect(text).toContain("Report a vulnerability");
    expect(text).toContain("<your contact address>");
    expect(text).not.toContain("example.com");
    expect(text).not.toMatch(NO_DASH);
  });

  it("gives marked placeholders for code owners and says to replace them", () => {
    const text = codeownersSnippet();
    expect(text).toContain("@REPLACE-WITH-ORG/REPLACE-WITH-TEAM");
    expect(text.split("\n")[0]).toContain("Replace every REPLACE-WITH placeholder");
    expect(text).not.toContain("@your-org");
    expect(text).not.toContain("@acme");
  });

  it("ignores environment files but keeps the example", () => {
    expect(gitignoreSnippet().split("\n")).toEqual([".env", ".env.*", "!.env.example", "*.pem", "*.key"]);
  });

  it("stops tracking each file the finding names, so that ignoring it takes effect, and skips an unsafe path", () => {
    expect(
      untrackSnippet([
        { label: ".env", url: null },
        { label: "config/prod.pem", url: null },
        { label: "a b; rm -rf /", url: null },
        { label: "../secret.key", url: null },
      ]),
    ).toBe("git rm --cached -- .env\ngit rm --cached -- config/prod.pem");
    expect(untrackSnippet([])).toBe("git rm --cached -- <file>");
  });

  it("stops the checkout keeping the token, runs as a user that is not root and pins a digest", () => {
    expect(persistCredentialsSnippet()).toContain("persist-credentials: false");
    expect(nonRootSnippet()).toMatch(/^USER app$/m);
    expect(digestSnippet()).toContain("@sha256:<digest>");
  });

  it("marks the Debian syntax and gives the Alpine form for a user that is not root", () => {
    const text = nonRootSnippet();
    expect(text).toContain("Debian and Ubuntu");
    expect(text).toContain("RUN addgroup --system app && adduser --system --ingroup app app");
    expect(text).toContain("# RUN addgroup -S app && adduser -S app -G app");
  });
});

describe("dependabotYml", () => {
  it("writes a weekly schedule and grouped minor and patch updates for each ecosystem, naming the folder to change", () => {
    const text = dependabotYml(["npm", "github-actions"]);
    expect(text).toContain("In a monorepo add one entry for each folder");
    expect(text).toContain("directories:");
    expect(text.split("\n").filter((line) => !line.startsWith("#"))).toEqual([
      "version: 2",
      "updates:",
      '  - package-ecosystem: "npm"',
      '    directory: "/"',
      "    schedule:",
      '      interval: "weekly"',
      "    groups:",
      "      minor-and-patch:",
      "        update-types:",
      '          - "minor"',
      '          - "patch"',
      '  - package-ecosystem: "github-actions"',
      '    directory: "/"',
      "    schedule:",
      '      interval: "weekly"',
      "    groups:",
      "      minor-and-patch:",
      "        update-types:",
      '          - "minor"',
      '          - "patch"',
    ]);
  });

  it("covers actions alone and says so when no ecosystem is known", () => {
    const text = dependabotYml([]);
    expect(text).toContain('package-ecosystem: "github-actions"');
    expect(text.match(/package-ecosystem/g)).toHaveLength(1);
    expect(text).toContain("covers only GitHub Actions");
    expect(dependabotYml(["npm"])).not.toContain("covers only GitHub Actions");
  });

  it("lists each ecosystem once and leaves out any name that is not plain lower case words", () => {
    const text = dependabotYml(["npm", "npm", 'x"\n  - evil', "Bad", "gomod"]);
    expect(text.match(/package-ecosystem/g)).toHaveLength(2);
    expect(text).toContain('"gomod"');
    expect(text).not.toContain("evil");
  });
});

describe("the CodeQL workflow", () => {
  it.each([
    [["npm"], "javascript-typescript"],
    [["pip"], "python"],
    [["gomod"], "go"],
    [["maven", "gradle"], "java-kotlin"],
    [["nuget"], "csharp"],
    [["bundler"], "ruby"],
    [["swift"], "swift"],
    [["github-actions"], "actions"],
    [["npm", "pip", "npm", "github-actions"], "javascript-typescript,python,actions"],
  ])("takes the languages from the ecosystems %j", (ecosystems, languages) => {
    expect(codeqlLanguages(ecosystems).join(",")).toBe(languages);
    expect(codeqlSnippet("main", ecosystems)).toContain(`languages: ${languages}`);
  });

  it("changes the languages when the ecosystems change", () => {
    expect(codeqlSnippet("main", ["npm"])).not.toContain("python");
    expect(codeqlSnippet("main", ["pip"])).toContain("languages: python");
  });

  it("leaves a marked placeholder with the choices beside it when no ecosystem maps", () => {
    for (const ecosystems of [[], ["docker", "composer"]]) {
      const text = codeqlSnippet("main", ecosystems);
      expect(text).toContain("languages: <your languages>");
      expect(text).toContain("# Replace the placeholder with the languages your code uses");
      expect(text).toContain("javascript-typescript, python");
    }
  });

  it("asks for the permissions the analysis needs", () => {
    const text = codeqlSnippet("main", ["npm"]);
    expect(text).toContain("  actions: read\n  contents: read\n  security-events: write");
  });
});

describe("snippets for each kind of action", () => {
  it("has a writer for every kind", () => {
    expect(Object.keys(SNIPPETS).sort()).toEqual([...KINDS].sort());
  });

  it.each(KINDS)("builds the snippets for %s without a dash or a missing value", (kind) => {
    const snippets = snippetsFor(securityAction({ kind }), context);
    for (const s of snippets) {
      expect(s.label.length).toBeGreaterThan(5);
      expect(s.code.length).toBeGreaterThan(5);
      expect(s.code).not.toMatch(NO_DASH);
      expect(s.code).not.toMatch(/undefined|NaN/);
      expect(`${s.note ?? ""}${s.instead ?? ""}`).not.toMatch(NO_DASH);
    }
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
  });

  it("offers the upgrade command for the package an upgrade is about", () => {
    expect(snippetsFor(securityAction(), context).map((s) => [s.id, s.code])).toEqual([
      ["upgrade", "npm install left-pad@1.3.1"],
    ]);
  });

  it("reads how the package comes in from the action, and offers an override and no install for a transitive one", () => {
    const action = securityAction({ relationship: "transitive" });
    const snippets = snippetsFor(action, context);
    expect(snippets.map((s) => s.id)).toEqual(["upgradeInPlace", "npmOverrides"]);
    expect(snippets.map((s) => s.code).join("\n")).not.toContain("npm install");
    expect(upgradeInstruction(action)).toContain("comes in through another package");
  });

  it("gives each action its own advice from its own relationship, so the same package in two manifests can differ", () => {
    const root = securityAction({ manifestPath: "package-lock.json", relationship: "transitive" });
    const web = securityAction({ manifestPath: "apps/web/package-lock.json", relationship: "direct" });
    expect(snippetsFor(root, context).map((s) => s.id)).toEqual(["upgradeInPlace", "npmOverrides"]);
    expect(snippetsFor(web, context).map((s) => [s.id, s.code])).toEqual([
      ["upgrade", "cd apps/web && npm install left-pad@1.3.1"],
    ]);
    expect(upgradeInstruction(web)).toBeNull();
  });

  it("offers an instruction, and no copyable snippet, where the advice is prose", () => {
    const action = securityAction({ ecosystem: "pip", target: "pip:left-pad", manifestPath: "requirements.txt" });
    expect(snippetsFor(action, context)).toEqual([]);
    expect(upgradeInstruction(action)).toBe("Set left-pad==1.3.1 in requirements.txt, then install the requirements again.");
  });

  it("offers no upgrade command when none is known or there is no fixed version", () => {
    expect(snippetsFor(securityAction({ ecosystem: "swift", manifestPath: "Package.resolved" }), context)).toEqual([]);
    expect(snippetsFor(securityAction({ upgradeTo: null }), context)).toEqual([]);
    expect(upgradeInstruction(securityAction({ upgradeTo: null }))).toBeNull();
  });

  it("puts the note of a command beside its snippet", () => {
    const [snippet] = snippetsFor(
      securityAction({ ecosystem: "rubygems", target: "rubygems:left-pad", manifestPath: "Gemfile.lock" }),
      context,
    );
    expect(snippet!.note).toContain("Gemfile");
  });

  it("generates the Dependabot file from the repository's own ecosystems", () => {
    const [snippet] = snippetsFor(securityAction({ kind: "add_update_config" }), context);
    expect(snippet!.id).toBe("dependabot");
    expect(snippet!.code).toBe(dependabotYml(["npm", "github-actions"]));
    expect(snippetsFor(securityAction({ kind: "enable_dependabot" }), context)[0]!.code).toBe(snippet!.code);
    expect(
      snippetsFor(securityAction({ kind: "enable_dependabot" }), { ...context, versionUpdates: ".github/dependabot.yml" }),
    ).toEqual([]);
  });

  it("pins the action named in the references with the ref it names, and a placeholder when none has that shape", () => {
    const pinned = snippetsFor(
      securityAction({ kind: "pin_actions", refs: [{ label: "acme-tools/setup@v2", url: null }] }),
      context,
    );
    expect(pinned.map((s) => s.code)).toEqual([
      "- uses: acme-tools/setup@<full 40 character commit sha> # v2",
      "gh api repos/acme-tools/setup/commits/v2 --jq .sha",
    ]);
    const generic = snippetsFor(securityAction({ kind: "pin_actions", refs: [{ label: "ci.yml line 12", url: null }] }), context);
    expect(generic[0]!.code).toBe("- uses: owner/action@<full 40 character commit sha> # <version tag>");
    const subpath = snippetsFor(
      securityAction({ kind: "pin_own_actions", refs: [{ label: "acme/tools/deploy@release-1.2", url: null }] }),
      context,
    );
    expect(subpath[0]!.code).toBe("- uses: acme/tools@<full 40 character commit sha> # release-1.2");
    expect(subpath[1]!.code).toBe("gh api repos/acme/tools/commits/release-1.2 --jq .sha");
  });

  it.each([
    "../../x@v1",
    "acme/../v1",
    "acme/..@v1",
    "./local/action@v1",
    "docker://alpine@sha256:abc",
    "ac me/tools@v1",
    "acme/tools@",
    "$(id)/tools@v1",
    "acme/to..ols@v1",
  ])("takes no repository from the reference %j, so a path cannot climb out of repos/", (label) => {
    expect(firstActionRepo(securityAction({ refs: [{ label, url: null }] }))).toBeNull();
  });

  it("keeps the repository but drops a ref that is not a plain name", () => {
    expect(firstActionRepo(securityAction({ refs: [{ label: "acme/tools@v1;rm", url: null }] }))).toEqual({
      repo: "acme/tools",
      ref: null,
    });
    expect(firstActionRepo(securityAction({ refs: [{ label: "acme/tools@main", url: null }] }))).toEqual({
      repo: "acme/tools",
      ref: "main",
    });
  });

  it("writes the policy for this repository", () => {
    expect(snippetsFor(securityAction({ kind: "add_security_policy" }), context)[0]!.code).toContain(
      "# Security policy for acme/widgets",
    );
  });

  it("offers the CodeQL workflow for the branch where GitHub code scanning is available, with a caution about the upload", () => {
    const available = { ...context, branch: "trunk", codeScanning: true };
    for (const kind of ["add_static_analysis", "enable_code_scanning"] as const) {
      const [snippet] = snippetsFor(securityAction({ kind }), available);
      expect(snippet!.id).toBe("codeql");
      expect(snippet!.code).toContain("branches: [trunk]");
      expect(snippet!.code).toContain("languages: javascript-typescript,actions");
      expect(snippet!.note).toBe(copy.security.snippetNotes.codeql);
    }
    expect(snippetsFor(securityAction({ kind: "enable_code_scanning" }), { ...available, branch: "x; evil" })[0]!.code).toContain(
      "branches: [main]",
    );
  });

  it("offers a scanner that uploads nothing to GitHub where code scanning is not available, and says what it needs", () => {
    for (const kind of ["add_static_analysis", "enable_code_scanning"] as const) {
      const snippets = snippetsFor(securityAction({ kind }), { ...context, codeScanning: false });
      expect(snippets.map((s) => s.id)).toEqual(["semgrep"]);
      expect(snippets[0]!.code).toContain("semgrep scan --config auto --error");
      expect(snippets[0]!.code).toContain("pull_request:");
      expect(snippets[0]!.code).not.toContain("security-events");
      expect(snippets[0]!.code).not.toContain("codeql");
      expect(snippets[0]!.note).toBe(copy.security.snippetNotes.semgrep);
    }
    expect(copy.security.snippetNotes.semgrep).toContain("needs no GitHub Code Security");
    expect(copy.security.snippetNotes.codeql).toContain("needs GitHub Code Security");
  });

  it("says that dependency review needs GitHub Code Security on a private repository", () => {
    const [snippet] = snippetsFor(securityAction({ kind: "add_dependency_review" }), context);
    expect(snippet!.note).toContain("private repository it needs GitHub Code Security");
    expect(copy.security.fix.add_dependency_review.steps.join(" ")).toContain("GitHub Code Security");
  });

  it("offers the safe script injection block to copy and the risky one only to compare", () => {
    const [snippet] = snippetsFor(securityAction({ kind: "fix_script_injection" }), context);
    expect(snippet!.code).not.toContain('echo "${{');
    expect(snippet!.instead).toBe('- run: echo "${{ github.event.issue.title }}"');
  });

  it("offers the two triggers as separate snippets for a pull request head checkout", () => {
    const snippets = snippetsFor(securityAction({ kind: "fix_pr_head_checkout" }), context);
    expect(snippets.map((s) => s.id)).toEqual(["pullRequestTrigger", "pullRequestTarget"]);
  });

  it("offers the git rm command beside the ignore lines for key files, using the files the finding names", () => {
    const snippets = snippetsFor(
      securityAction({ kind: "remove_key_files", refs: [{ label: "deploy/.env", url: null }] }),
      context,
    );
    expect(snippets.map((s) => [s.id, s.code])).toEqual([
      ["untrack", "git rm --cached -- deploy/.env"],
      ["gitignore", gitignoreSnippet()],
    ]);
  });

  it("offers the environment line for turning code analysis on", () => {
    expect(snippetsFor(securityAction({ kind: "turn_on_code_analysis" }), context)[0]!.code).toBe("CODE_ANALYSIS=on");
  });

  it("offers no snippet where the fix is a setting or a decision", () => {
    for (const kind of ["rotate_secret", "protect_branch", "require_review", "replace_dependency", "fix_code_alert"] as const) {
      expect(snippetsFor(securityAction({ kind }), context)).toEqual([]);
    }
  });
});

describe("learn more links", () => {
  it("points every kind at a docs.github.com page, except a setting of this dashboard", () => {
    expect(Object.keys(LEARN_MORE).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      const url = LEARN_MORE[kind];
      if (kind === "turn_on_code_analysis") expect(url).toBeNull();
      else expect(url, kind).toMatch(/^https:\/\/docs\.github\.com\/en\/[a-z0-9_\-/]+$/);
    }
  });

  it("uses the final address of each page, with no redirect", () => {
    const urls = Object.values(LEARN_MORE).filter((url): url is string => url !== null);
    for (const old of [
      "security-for-github-actions",
      "hosting-your-own-runners",
      "code-security/dependabot/",
      "code-security/code-scanning/",
      "code-security/secret-scanning/",
      "code-security/security-advisories/",
      "code-security/supply-chain-security/",
      "getting-started/adding-a-security-policy",
    ]) {
      expect(
        urls.filter((url) => url.includes(old)),
        old,
      ).toEqual([]);
    }
    expect(LEARN_MORE.stop_self_hosted_public).toBe("https://docs.github.com/en/actions/concepts/runners/self-hosted-runners");
    expect(LEARN_MORE.rotate_secret).toBe(
      "https://docs.github.com/en/code-security/tutorials/remediate-leaked-secrets/remediating-a-leaked-secret",
    );
  });
});

describe("settings links", () => {
  it("works out the branch settings page from the security settings address", () => {
    expect(branchSettingsUrl("https://github.com/acme/widgets/settings/security_analysis")).toBe(
      "https://github.com/acme/widgets/settings/branches",
    );
    expect(branchSettingsUrl("https://ghe.example.com/acme/widgets/settings/security_analysis")).toBe(
      "https://ghe.example.com/acme/widgets/settings/branches",
    );
    expect(branchSettingsUrl("https://github.com/acme/widgets")).toBeNull();
  });

  it("offers the security settings for a setting, the branch settings for a branch rule and nothing otherwise", () => {
    expect(settingsLinkFor("enable_dependabot", context.settingsUrl)).toEqual({ url: context.settingsUrl, branch: false });
    expect(settingsLinkFor("protect_branch", context.settingsUrl)).toEqual({
      url: "https://github.com/acme/widgets/settings/branches",
      branch: true,
    });
    expect(settingsLinkFor("protect_branch", "https://github.com/acme/widgets")).toBeNull();
    expect(settingsLinkFor("pin_actions", context.settingsUrl)).toBeNull();
  });

  it("keeps the two sets of kinds apart", () => {
    for (const kind of SETTINGS_KINDS) expect(BRANCH_KINDS.has(kind)).toBe(false);
  });
});
