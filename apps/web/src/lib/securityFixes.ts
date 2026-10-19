import type {
  DependencyGroup,
  SecurityAction,
  SecurityActionKind,
  SecurityThresholds,
  SupplyChainCheckId,
  SupplyChainItem,
} from "@dora-dashboard/core";
import { copy, type UnknownWays } from "../copy";

/*
 * The snippets and commands that go with each kind of finding. They are plain text built from the report's own
 * structured facts, so they can be tested exactly. Nothing here is sent anywhere, and every value that reaches a
 * shell command is checked first, because a developer will paste it into a terminal.
 */

/** A copyable block, with the id of its label in copy.ts. */
export interface Snippet {
  id: keyof typeof copy.security.snippets;
  label: string;
  code: string;
  /** A sentence of caution shown with the block, such as a plan the feature needs. */
  note?: string;
  /** A block that is shown for comparison and is never copyable, such as the risky way of writing something. */
  instead?: string;
}

export interface FixContext {
  /** Dependabot ecosystem names the repository needs, from the report. */
  ecosystems: readonly string[];
  /** The branch the dashboard is set up for, which a CodeQL workflow names in its push trigger. */
  branch: string;
  /** The host's page for the repository's security settings. */
  settingsUrl: string;
  /** The update configuration path when version updates run while Dependabot alerts are off, else null. */
  versionUpdates?: string | null;
  /** The Dependabot or Renovate configuration file, whatever the state of Dependabot alerts, else null. */
  updateConfig?: string | null;
  /** True when Dependabot alerts were read, so the security updates advice can say they are already on. */
  dependabotAlertsOn?: boolean;
  /**
   * True where GitHub code scanning can be used, which is on a public repository or where it has been read. Where it
   * is not, a scanner that uploads nothing to GitHub is offered, because the CodeQL upload step fails there.
   */
  codeScanning?: boolean;
  /** The limits the report used, for sentences that name a number of days. */
  thresholds?: SecurityThresholds | null;
  /** True when private vulnerability reporting was read as on, so a security policy can point reporters to it. */
  privateReporting?: boolean;
}

const snippet = (id: Snippet["id"], code: string, extra: { note?: string | null; instead?: string | null } = {}): Snippet => ({
  id,
  label: copy.security.snippets[id],
  code,
  ...(extra.note ? { note: extra.note } : {}),
  ...(extra.instead ? { instead: extra.instead } : {}),
});

// --- Safe values -----------------------------------------------------------------------------------------------

/**
 * What registries allow in a package name, starting with a letter, a digit or the @ of a scope, never a dash that a shell
 * reads as an option.
 */
const SAFE_NAME = /^[@A-Za-z0-9][@A-Za-z0-9._/+~-]*$/;
/** A version starts with a digit or a letter, such as the v of a Go version, and never with a dash or a tilde. */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_@+.][A-Za-z0-9._@+-]*$/;

/** A relative path of plain segments, so it can be put in a command without quoting and cannot climb out of the repository. */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

// --- Upgrade advice ---------------------------------------------------------------------------------------------

/**
 * What to do to reach a fixed version. A command can be copied and run. An instruction is prose, optionally with a
 * command to try first and a snippet to paste into a file, and it is never styled or offered as a command.
 */
export type UpgradeAdvice =
  | { kind: "command"; command: string; note: string | null }
  | {
      kind: "instruction";
      text: string;
      command: string | null;
      snippet: { id: Snippet["id"]; code: string } | null;
    };

type Instruction = Extract<UpgradeAdvice, { kind: "instruction" }>;

export interface UpgradeInput {
  ecosystem: string | null;
  manifestPath: string | null;
  name: string | null;
  version: string | null;
  relationship: DependencyGroup["relationship"];
}

type Tool =
  | "npm"
  | "yarn"
  | "pnpm"
  | "poetry"
  | "uv"
  | "pipenv"
  | "requirements"
  | "cargo"
  | "bundler"
  | "go"
  | "composer"
  | "nuget"
  | "build";

/** The package manager, from the file that names the package, else from the ecosystem when the file is not one this knows. */
function toolOf(file: string, ecosystem: string | null): Tool | null {
  switch (file) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
    case "package.json":
      return "npm";
    case "yarn.lock":
      return "yarn";
    case "pnpm-lock.yaml":
      return "pnpm";
    case "poetry.lock":
      return "poetry";
    case "uv.lock":
      return "uv";
    case "pipfile.lock":
      return "pipenv";
    case "cargo.lock":
      return "cargo";
    case "gemfile.lock":
      return "bundler";
    case "go.mod":
    case "go.sum":
      return "go";
    case "composer.lock":
      return "composer";
    case "pom.xml":
    case "build.gradle":
    case "build.gradle.kts":
      return "build";
  }
  if (/^requirements.*\.txt$/.test(file)) return "requirements";
  if (/\.csproj$|packages\.lock\.json$/.test(file)) return "nuget";
  switch ((ecosystem ?? "").toLowerCase()) {
    case "npm":
      return "npm";
    case "pip":
    case "pypi":
      return "requirements";
    case "uv":
      return "uv";
    case "rubygems":
    case "bundler":
      return "bundler";
    case "go":
    case "gomod":
      return "go";
    case "composer":
      return "composer";
    case "nuget":
      return "nuget";
    case "rust":
    case "cargo":
    case "crates.io":
      return "cargo";
    case "maven":
    case "gradle":
      return "build";
    default:
      return null;
  }
}

/** The folder that holds the manifest, null at the root, and whether it is safe to put after `cd`. */
function manifestFolder(path: string | null): { dir: string | null; safe: boolean } {
  if (!path || !path.includes("/")) return { dir: null, safe: true };
  const dir = path.slice(0, path.lastIndexOf("/"));
  return isSafePath(dir) ? { dir, safe: true } : { dir: null, safe: false };
}

const overridesJson = (key: string[], name: string, version: string): string => {
  const open = key.map((part, i) => `${"  ".repeat(i + 1)}"${part}": {`);
  const close = key.map((_, i) => `${"  ".repeat(key.length - i)}}`);
  return ["{", ...open, `${"  ".repeat(key.length + 1)}"${name}": "${version}"`, ...close, "}"].join("\n");
};

/**
 * The advice that upgrades one package to the version that fixes it, chosen by the file that names the package and
 * by how the package comes in. A package that comes in through another package is not installed directly, because
 * that would add a dependency the project does not otherwise have. The command is run in the manifest's own folder.
 * It answers null for a package manager it does not know and for a name or version that is not plain text, so
 * nothing odd is ever offered for pasting.
 */
export function upgradeAdvice({ ecosystem, manifestPath, name, version, relationship }: UpgradeInput): UpgradeAdvice | null {
  if (!version || !name || !SAFE_NAME.test(name) || !SAFE_VERSION.test(version)) return null;
  const file = manifestPath ? baseName(manifestPath) : "";
  const tool = toolOf(file, ecosystem);
  if (tool === null) return null;
  const text = copy.security.upgradeText;
  const { dir, safe } = manifestFolder(manifestPath);
  if (!safe) return { kind: "instruction", text: text.folder(name, version), command: null, snippet: null };
  const run = (words: string) => (dir ? `cd ${dir} && ${words}` : words);
  const instruction = (words: string, tryFirst: string | null = null, paste: Instruction["snippet"] = null): UpgradeAdvice => ({
    kind: "instruction",
    text: words,
    command: tryFirst === null ? null : run(tryFirst),
    snippet: paste,
  });

  const indirect = relationship === "transitive" || relationship === "mixed";
  const through = (mechanism: string) =>
    relationship === "mixed" ? text.mixed(name, version, mechanism) : text.transitive(name, version, mechanism);
  // A source that does not say how the package comes in, such as OSV.dev, gets both ways where they differ, because
  // installing a package that another one brings in would add a dependency the project does not otherwise have.
  const unknown = (ways: UnknownWays, tryFirst: string | null, paste: Instruction["snippet"] = null) =>
    instruction(text.unknown(name, version, ways, tryFirst === null ? null : run(tryFirst)), tryFirst, paste);
  const command = (words: string, note: string | null = null): UpgradeAdvice => ({
    kind: "command",
    command: run(words),
    note,
  });
  const goVersion = version.startsWith("v") ? version : `v${version}`;

  const npmOverride = { id: "npmOverrides", code: overridesJson(["overrides"], name, version) } as const;
  const yarnResolution = { id: "yarnResolutions", code: overridesJson(["resolutions"], name, version) } as const;
  const pnpmOverride = { id: "pnpmOverrides", code: overridesJson(["pnpm", "overrides"], name, version) } as const;

  switch (tool) {
    case "npm":
      if (relationship === null) return unknown(text.unknownWays.npm(name, version), `npm update ${name}`, npmOverride);
      return indirect
        ? instruction(through(text.mechanism.npm), `npm update ${name}`, npmOverride)
        : command(`npm install ${name}@${version}`);
    case "yarn":
      if (relationship === null) return unknown(text.unknownWays.yarn(name, version), null, yarnResolution);
      return indirect ? instruction(through(text.mechanism.yarn), null, yarnResolution) : instruction(text.yarn(name, version));
    case "pnpm":
      if (relationship === null) return unknown(text.unknownWays.pnpm(name, version), null, pnpmOverride);
      return indirect ? instruction(through(text.mechanism.pnpm), null, pnpmOverride) : command(`pnpm update ${name}@${version}`);
    case "poetry":
      if (relationship === null) return unknown(text.unknownWays.poetry(name, version), `poetry update ${name}`);
      return indirect
        ? command(`poetry update ${name}`, text.notes.poetryUpdate)
        : command(`poetry add ${name}@^${version}`, text.notes.poetryDev);
    case "uv":
      return command(`uv lock --upgrade-package ${name}==${version}`);
    case "pipenv":
      if (relationship === null) return unknown(text.unknownWays.pipenv(name, version), null);
      return indirect
        ? instruction(text.pip(name, version))
        : command(`pipenv install ${name}==${version}`, text.notes.pipenvDev);
    case "requirements":
      return instruction(
        relationship === "transitive" ? text.pip(name, version) : text.requirements(name, version, file || "requirements.txt"),
      );
    case "cargo":
      return command(`cargo update -p ${name} --precise ${version}`, text.notes.cargo);
    case "bundler":
      return command(`bundle update ${name} --conservative`, text.notes.bundler);
    case "go":
      return command(`go get ${name}@${goVersion} && go mod tidy`);
    case "composer":
      return command(`composer update ${name} --with ${name}:${version}`, text.notes.composer);
    case "nuget":
      return command(`dotnet add package ${name} --version ${version}`, indirect ? text.notes.nugetTransitive : null);
    case "build":
      return instruction(text.build(name, version));
  }
}

// --- Fixed texts -----------------------------------------------------------------------------------------------

const lines = (...text: string[]) => text.join("\n");

export const permissionsSnippet = (): string => lines("permissions:", "  contents: read");

/** An action named by a finding, such as `acme-tools/setup@v2`, kept to values that are safe to put in a command. */
export interface ActionRef {
  repo: string;
  /** The tag or branch after the `@`, or null when it is not a plain name. */
  ref: string | null;
}

const OWNER_REPO = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG_PLACEHOLDER = "<version tag>";

const safeRef = (ref: string | null): string | null => (ref !== null && SAFE_REF.test(ref) && !ref.includes("..") ? ref : null);

/** A pinned `uses:` line with a placeholder for the commit and the tag the finding named kept as a comment. */
export function pinnedUsesSnippet(use: ActionRef | null = null): string {
  return `- uses: ${use?.repo ?? "owner/action"}@<full 40 character commit sha> # ${safeRef(use?.ref ?? null) ?? TAG_PLACEHOLDER}`;
}

/** The command that finds the commit a tag points at. */
export function shaLookupSnippet(use: ActionRef | null = null): string {
  return `gh api repos/${use?.repo ?? "owner/action"}/commits/${safeRef(use?.ref ?? null) ?? TAG_PLACEHOLDER} --jq .sha`;
}

/** Only the safe way, because what is copied is pasted into a workflow. The risky way is shown apart from it. */
export const scriptInjectionSnippet = (): string =>
  lines("- env:", "    TITLE: ${{ github.event.issue.title }}", '  run: echo "$TITLE"');

export const scriptInjectionRisky = (): string => '- run: echo "${{ github.event.issue.title }}"';

/** The trigger that is safe for code from forks, on its own so that it can be pasted as a whole `on:` block. */
export const pullRequestTriggerSnippet = (): string => lines("on:", "  pull_request:");

/** For the rare workflow that really needs secrets, which must never run the pull request's own code. */
export const pullRequestTargetSnippet = (): string =>
  lines(
    "# Never check out or run the pull request's own code in this workflow.",
    "# Add pull-requests: write only if the workflow comments on or labels pull requests.",
    "on:",
    "  pull_request_target:",
    "permissions:",
    "  contents: read",
  );

const ECOSYSTEM_NAME = /^[a-z][a-z-]*$/;

/** A `.github/dependabot.yml` covering the given ecosystems, with a weekly schedule and minor and patch updates grouped. */
export function dependabotYml(ecosystems: readonly string[]): string {
  const chosen = [...new Set(ecosystems.filter((name) => ECOSYSTEM_NAME.test(name)))];
  const none = chosen.length === 0;
  const list = none ? ["github-actions"] : chosen;
  return lines(
    ...(none
      ? [
          "# No ecosystems were found, so this covers only GitHub Actions.",
          "# Add one entry for each other ecosystem you use, such as npm or pip.",
        ]
      : []),
    "# directory is the folder that holds the manifest. In a monorepo add one entry for each folder,",
    '# or use directories: with globs such as ["/apps/*"] to cover several at once.',
    "version: 2",
    "updates:",
    ...list.flatMap((name) => [
      `  - package-ecosystem: "${name}"`,
      '    directory: "/"',
      "    schedule:",
      '      interval: "weekly"',
      "    groups:",
      "      minor-and-patch:",
      "        update-types:",
      '          - "minor"',
      '          - "patch"',
    ]),
  );
}

/**
 * A starting SECURITY.md. It sends reporters to the "Report a vulnerability" button only when private vulnerability
 * reporting is known to be on, because the button is not there otherwise, and asks for an address instead. It names
 * no repository, since GitHub shows it in place, and promises nothing about releases, which a repository may not have.
 */
export const securityPolicyMarkdown = (privateReporting: boolean): string =>
  lines(
    "# Security policy",
    "",
    "## Reporting a vulnerability",
    "",
    privateReporting
      ? 'Please do not open a public issue for a security problem. Instead, use the "Report a vulnerability" button on the Security tab of this repository, which reaches the maintainers privately.'
      : "Please do not open a public issue for a security problem. Instead, write to <your contact address>.",
    "",
    "We will acknowledge your report within three working days and keep you informed until the problem is fixed.",
    "",
    "## Supported versions",
    "",
    "Fixes are made on the default branch. <Say which releases also receive fixes, or remove this sentence if you do not publish releases.>",
  );

export const gitignoreSnippet = (): string => lines(".env", ".env.*", "!.env.example", "*.pem", "*.key");

/**
 * The commands that make git stop tracking files that were already committed, one for each file the finding names
 * whose path is plain text, or a placeholder when none is. Ignoring a file does not stop git tracking it.
 */
export function untrackSnippet(refs: SecurityAction["refs"]): string {
  const paths = refs.map((ref) => ref.label).filter(isSafePath);
  return paths.length === 0 ? "git rm --cached -- <file>" : lines(...paths.map((path) => `git rm --cached -- ${path}`));
}

export const persistCredentialsSnippet = (): string =>
  lines(pinnedUsesSnippet({ repo: "actions/checkout", ref: null }), "  with:", "    persist-credentials: false");

/** A pinned step of a workflow template. The tag is a placeholder too, so the template never names an old version. */
const usesStep = (repo: string): string => `      ${pinnedUsesSnippet({ repo, ref: null })}`;

/** The checkout step of a workflow template, which never leaves the token on disk for the steps after it. */
const checkoutStep = (...options: string[]): string[] => [
  usesStep("actions/checkout"),
  "        with:",
  ...options.map((option) => `          ${option}`),
  "          persist-credentials: false",
];

export const nonRootSnippet = (): string =>
  lines(
    "# Create an unprivileged user and switch to it before the application starts.",
    "# This is the Debian and Ubuntu syntax. On an Alpine image use the two lines after it instead.",
    "RUN addgroup --system app && adduser --system --ingroup app app",
    "# RUN addgroup -S app && adduser -S app -G app",
    "USER app",
  );

export const digestSnippet = (): string =>
  lines("# Find the digest with docker buildx imagetools inspect node:22-slim", "FROM node:22-slim@sha256:<digest>");

export const remoteAddSnippet = (): string =>
  lines(
    "# Instead of ADD https://example.com/tool.tar.gz /tmp/",
    "RUN curl -fsSLo /tmp/tool.tar.gz https://example.com/tool.tar.gz \\",
    ' && echo "<expected sha256>  /tmp/tool.tar.gz" | sha256sum -c -',
  );

export const curlPipeSnippet = (): string =>
  lines(
    "# Instead of piping a download into a shell",
    "- run: |",
    "    curl -fsSLo install.sh https://example.com/install.sh",
    '    echo "<expected sha256>  install.sh" | sha256sum -c -',
    "    sh install.sh",
  );

export const secretsInheritSnippet = (): string =>
  lines(
    "jobs:",
    "  call:",
    "    uses: ./.github/workflows/build.yml",
    "    secrets:",
    "      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
  );

const DEPENDENCY_REVIEW_ACTION = "actions/dependency-review-action";

export const dependencyReviewSnippet = (): string =>
  lines(
    "name: Dependency review",
    "on: pull_request",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      # Compares the dependency graphs of the two commits through GitHub, so nothing is checked out.",
    usesStep(DEPENDENCY_REVIEW_ACTION),
  );

export const secretScannerSnippet = (): string =>
  lines(
    "name: Secret scan",
    "on: pull_request",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...checkoutStep("fetch-depth: 0"),
    usesStep("trufflesecurity/trufflehog"),
    "        with:",
    "          extra_args: --only-verified",
  );

/** CodeQL's name for the language of each Dependabot ecosystem, for the ecosystems that CodeQL can analyse. */
const CODEQL_LANGUAGES: Readonly<Record<string, string>> = {
  npm: "javascript-typescript",
  pip: "python",
  uv: "python",
  gomod: "go",
  maven: "java-kotlin",
  gradle: "java-kotlin",
  nuget: "csharp",
  bundler: "ruby",
  swift: "swift",
  "github-actions": "actions",
};

/** The CodeQL languages for the ecosystems, each once, in the order the ecosystems come, empty when none maps. */
export function codeqlLanguages(ecosystems: readonly string[]): string[] {
  return [...new Set(ecosystems.flatMap((name) => CODEQL_LANGUAGES[name] ?? []))];
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * The CodeQL workflow. It uploads to GitHub code scanning, which a private repository can use only with GitHub Code
 * Security, so the page offers it only where code scanning is available. The languages come from the repository's
 * own ecosystems, or are left as a marked placeholder with the choices beside it.
 */
export function codeqlSnippet(branch: string, ecosystems: readonly string[] = []): string {
  const languages = codeqlLanguages(ecosystems);
  return lines(
    "name: CodeQL",
    "on:",
    "  push:",
    `    branches: [${SAFE_BRANCH.test(branch) ? branch : "main"}]`,
    "  pull_request:",
    "  schedule:",
    '    - cron: "0 5 * * 1"',
    "permissions:",
    "  actions: read",
    "  contents: read",
    "  security-events: write",
    "jobs:",
    "  analyse:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...checkoutStep(),
    usesStep("github/codeql-action/init"),
    "        with:",
    ...(languages.length > 0
      ? [
          "          # Taken from the dependency files found here. Add any other language that your code uses.",
          `          languages: ${languages.join(",")}`,
        ]
      : [
          "          # Replace the placeholder with the languages your code uses, from: actions, c-cpp, csharp, go,",
          "          # java-kotlin, javascript-typescript, python, ruby, swift",
          "          languages: <your languages>",
        ]),
    usesStep("github/codeql-action/analyze"),
  );
}

/** A scanner that runs in the pipeline and uploads nothing to GitHub, for where GitHub code scanning is not available. */
export const semgrepSnippet = (): string =>
  lines(
    "name: Semgrep",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  semgrep:",
    "    runs-on: ubuntu-latest",
    "    container:",
    "      # Pin the image to a digest. Find it with docker buildx imagetools inspect semgrep/semgrep",
    "      image: semgrep/semgrep@sha256:<digest>",
    "    steps:",
    ...checkoutStep(),
    "      - run: semgrep scan --config auto --error",
  );

export const selfHostedSnippet = (): string => lines("jobs:", "  build:", "    runs-on: ubuntu-latest");

export const analysisOnSnippet = (): string => "CODE_ANALYSIS=on";

// --- The snippets for each kind of action ---------------------------------------------------------------------

/** The action named by one `owner/repo[/path]@ref` label, kept to values that are safe to put in a command, or null. */
export function actionRefOf(label: string): ActionRef | null {
  const match = /^([^@\s/]+\/[^@\s/]+)(?:\/[^@\s]*)?@(\S+)$/.exec(label);
  if (!match || !OWNER_REPO.test(match[1]!) || match[1]!.includes("..")) return null;
  return { repo: match[1]!, ref: safeRef(match[2]!) };
}

/** The first action named in a list of references, such as `owner/repo@v4`, or null when none has that shape. */
export function firstActionRepo(action: SecurityAction): ActionRef | null {
  for (const ref of action.refs) {
    const found = actionRefOf(ref.label);
    if (found) return found;
  }
  return null;
}

const none = (): Snippet[] => [];
const updateConfig = (_a: SecurityAction, ctx: FixContext) => [snippet("dependabot", dependabotYml(ctx.ecosystems))];
const pin = (a: SecurityAction): Snippet[] => {
  const use = firstActionRepo(a);
  return [snippet("pinnedUses", pinnedUsesSnippet(use)), snippet("shaLookup", shaLookupSnippet(use))];
};

/** The command that finds the commit for the placeholders in a workflow template. */
const lookUp = (repo: string | null = null): Snippet => snippet("shaLookup", shaLookupSnippet(repo ? { repo, ref: null } : null));

/** The scanner that suits the repository: CodeQL where GitHub code scanning can be used, else one that uploads nothing. */
const codeScanner = (_a: SecurityAction, ctx: FixContext): Snippet[] => [
  ctx.codeScanning === false
    ? snippet("semgrep", semgrepSnippet(), { note: copy.security.snippetNotes.semgrep })
    : snippet("codeql", codeqlSnippet(ctx.branch, ctx.ecosystems), { note: copy.security.snippetNotes.codeql }),
  lookUp(),
];

const secretScanner = (): Snippet[] => [snippet("secretScanner", secretScannerSnippet()), lookUp()];

/** CodeQL query names, after the language and any folder, and the advice that suits each. Other rules get none. */
const CODE_RULE_ADVICE: ReadonlyMap<string, keyof typeof copy.security.codeAlertAdvice> = new Map([
  ["polynomial-redos", "slowRegex"],
  ["redos", "slowRegex"],
  ["sql-injection", "sqlInjection"],
  ["xss", "xss"],
  ["reflected-xss", "xss"],
  ["reflective-xss", "xss"],
  ["stored-xss", "xss"],
  ["xss-through-dom", "xss"],
  ["xss-through-exception", "xss"],
  ["html-constructed-from-input", "xss"],
  ["command-line-injection", "commandInjection"],
  ["command-injection", "commandInjection"],
  ["indirect-command-line-injection", "commandInjection"],
  ["shell-command-constructed-from-input", "commandInjection"],
  ["path-injection", "pathInjection"],
]);

/**
 * Advice for the rule behind a code scanning action, such as `js/polynomial-redos` or `cs/web/xss`, when it is one of
 * the common rules that the page knows, else null, so the steps' advice to follow the rule's own help stands alone.
 */
export function codeAlertAdvice(action: SecurityAction): string | null {
  if (action.kind !== "fix_code_alert" || !action.target) return null;
  const key = CODE_RULE_ADVICE.get(action.target.slice(action.target.lastIndexOf("/") + 1).toLowerCase());
  return key ? copy.security.codeAlertAdvice[key] : null;
}

/** The advice for an upgrade action, or null when no command or instruction is known, as when the package has no name. */
export function upgradeAdviceFor(action: SecurityAction): UpgradeAdvice | null {
  if (action.kind !== "upgrade_dependency") return null;
  const { ecosystem, manifestPath, name, upgradeTo, relationship } = action.package;
  return upgradeAdvice({ ecosystem, manifestPath, name, version: upgradeTo, relationship });
}

/** The prose of an upgrade that is an instruction and not a command, or null. */
export function upgradeInstruction(action: SecurityAction): string | null {
  const advice = upgradeAdviceFor(action);
  return advice?.kind === "instruction" ? advice.text : null;
}

function upgradeSnippets(action: SecurityAction): Snippet[] {
  const advice = upgradeAdviceFor(action);
  if (advice === null) return [];
  if (advice.kind === "command") return [snippet("upgrade", advice.command, { note: advice.note })];
  return [
    ...(advice.command ? [snippet("upgradeInPlace", advice.command)] : []),
    ...(advice.snippet ? [snippet(advice.snippet.id, advice.snippet.code)] : []),
  ];
}

/** One writer for every kind of action, so a kind added in core must be given its snippets, or none, before this compiles. */
export const SNIPPETS: Record<SecurityActionKind, (action: SecurityAction, ctx: FixContext) => Snippet[]> = {
  rotate_secret: none,
  upgrade_dependency: upgradeSnippets,
  replace_dependency: none,
  fix_code_alert: none,
  fix_pr_head_checkout: () => [
    snippet("pullRequestTrigger", pullRequestTriggerSnippet()),
    snippet("pullRequestTarget", pullRequestTargetSnippet()),
  ],
  fix_script_injection: () => [snippet("scriptInjection", scriptInjectionSnippet(), { instead: scriptInjectionRisky() })],
  stop_self_hosted_public: () => [snippet("selfHosted", selfHostedSnippet())],
  pin_actions: pin,
  restrict_permissions: () => [snippet("permissions", permissionsSnippet())],
  remove_unsecure_commands: none,
  remove_key_files: (a) => [snippet("untrack", untrackSnippet(a.refs)), snippet("gitignore", gitignoreSnippet())],
  protect_branch: none,
  block_force_push: none,
  enable_dependabot: (a, ctx) => (ctx.versionUpdates ? [] : updateConfig(a, ctx)),
  pin_own_actions: pin,
  add_update_config: updateConfig,
  add_lockfile: none,
  add_security_policy: (_a, ctx) => [
    snippet("securityPolicy", securityPolicyMarkdown(ctx.privateReporting === true), {
      note: ctx.privateReporting === true ? null : copy.security.snippetNotes.securityPolicyAddress,
    }),
  ],
  review_weak_key_files: none,
  enable_code_scanning: codeScanner,
  check_secret_scanning: secretScanner,
  grant_alert_access: none,
  turn_on_code_analysis: () => [snippet("analysisOn", analysisOnSnippet())],
  fix_low_alerts: none,
  require_status_checks: none,
  require_signed_commits: none,
  enable_security_updates: none,
  enable_push_protection: none,
  enable_private_reporting: none,
  triage_advisories: none,
  add_dependency_review: () => [
    snippet("dependencyReview", dependencyReviewSnippet(), { note: copy.security.snippetNotes.dependencyReview }),
    lookUp(DEPENDENCY_REVIEW_ACTION),
  ],
  add_secret_scanner_ci: secretScanner,
  add_static_analysis: codeScanner,
  avoid_curl_pipe_shell: () => [snippet("curlPipe", curlPipeSnippet())],
  avoid_secrets_inherit: () => [snippet("secretsInherit", secretsInheritSnippet())],
  disable_persist_credentials: () => [snippet("persistCredentials", persistCredentialsSnippet())],
  pin_base_images: () => [snippet("digest", digestSnippet())],
  avoid_latest_images: () => [snippet("digest", digestSnippet())],
  run_as_non_root: () => [snippet("nonRoot", nonRootSnippet())],
  avoid_remote_add: () => [snippet("remoteAdd", remoteAddSnippet())],
  merge_dependency_updates: none,
};

export function snippetsFor(action: SecurityAction, ctx: FixContext): Snippet[] {
  return SNIPPETS[action.kind](action, ctx);
}

// --- Links ------------------------------------------------------------------------------------------------------

const DOCS = "https://docs.github.com/en";
const HARDENING = `${DOCS}/actions/reference/security/secure-use`;
const PROTECTED = `${DOCS}/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches`;
const ALERTS = `${DOCS}/code-security/how-tos/manage-security-alerts/manage-dependabot-alerts/view-dependabot-alerts`;
const SUPPLY = `${DOCS}/code-security/concepts/supply-chain-security/supply-chain-security`;
const REMOVING = `${DOCS}/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository`;
const SECRET_SCANNING = `${DOCS}/code-security/concepts/secret-security/secret-scanning`;
const CODE_SCANNING = `${DOCS}/code-security/concepts/code-scanning/code-scanning`;
const ADVISORIES = `${DOCS}/code-security/concepts/vulnerability-reporting-and-management/repository-security-advisories`;
const FEATURES = `${DOCS}/code-security/getting-started/github-security-features`;
const SECURE_DEPENDENCIES = `${DOCS}/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies`;

/**
 * The GitHub documentation page that explains each kind of finding, or null for a setting of this dashboard rather than of
 * GitHub.
 */
export const LEARN_MORE: Record<SecurityActionKind, string | null> = {
  rotate_secret: `${DOCS}/code-security/tutorials/remediate-leaked-secrets/remediating-a-leaked-secret`,
  upgrade_dependency: ALERTS,
  replace_dependency: ALERTS,
  fix_code_alert: `${DOCS}/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts`,
  fix_pr_head_checkout: HARDENING,
  fix_script_injection: HARDENING,
  stop_self_hosted_public: `${DOCS}/actions/concepts/runners/self-hosted-runners`,
  pin_actions: HARDENING,
  restrict_permissions: `${DOCS}/actions/tutorials/authenticate-with-github_token`,
  remove_unsecure_commands: HARDENING,
  remove_key_files: REMOVING,
  protect_branch: PROTECTED,
  block_force_push: PROTECTED,
  enable_dependabot: `${SECURE_DEPENDENCIES}/configure-dependabot-alerts`,
  pin_own_actions: HARDENING,
  add_update_config: `${SECURE_DEPENDENCIES}/configure-version-updates`,
  add_lockfile: SUPPLY,
  add_security_policy: `${DOCS}/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy`,
  review_weak_key_files: REMOVING,
  enable_code_scanning: CODE_SCANNING,
  check_secret_scanning: SECRET_SCANNING,
  grant_alert_access: FEATURES,
  turn_on_code_analysis: null,
  fix_low_alerts: ALERTS,
  require_status_checks: PROTECTED,
  require_signed_commits: `${DOCS}/authentication/managing-commit-signature-verification/about-commit-signature-verification`,
  enable_security_updates: `${SECURE_DEPENDENCIES}/configure-security-updates`,
  enable_push_protection: `${DOCS}/code-security/concepts/secret-security/push-protection`,
  enable_private_reporting: `${DOCS}/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository`,
  triage_advisories: ADVISORIES,
  add_dependency_review: `${DOCS}/code-security/concepts/supply-chain-security/dependency-review`,
  add_secret_scanner_ci: SECRET_SCANNING,
  add_static_analysis: CODE_SCANNING,
  avoid_curl_pipe_shell: HARDENING,
  avoid_secrets_inherit: `${DOCS}/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets`,
  disable_persist_credentials: HARDENING,
  pin_base_images: SUPPLY,
  avoid_latest_images: SUPPLY,
  run_as_non_root: SUPPLY,
  avoid_remote_add: SUPPLY,
  merge_dependency_updates: `${DOCS}/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs`,
};

/** Kinds whose fix is a change in the repository's security settings, so the page offers a link to them. */
export const SETTINGS_KINDS: ReadonlySet<SecurityActionKind> = new Set<SecurityActionKind>([
  "enable_dependabot",
  "enable_security_updates",
  "enable_push_protection",
  "enable_private_reporting",
  "enable_code_scanning",
  "check_secret_scanning",
  "grant_alert_access",
  "triage_advisories",
]);

/** Kinds whose fix is a rule on the deploy branch. */
export const BRANCH_KINDS: ReadonlySet<SecurityActionKind> = new Set<SecurityActionKind>([
  "protect_branch",
  "block_force_push",
  "require_status_checks",
  "require_signed_commits",
]);

/** The branch settings page, worked out from the security settings address, or null when it does not have that shape. */
export function branchSettingsUrl(settingsUrl: string): string | null {
  return /\/settings\/[^/?#]*$/.test(settingsUrl) ? settingsUrl.replace(/\/settings\/[^/?#]*$/, "/settings/branches") : null;
}

/** The settings page that suits an action, or null when the fix is not a setting. */
export function settingsLinkFor(kind: SecurityActionKind, settingsUrl: string): { url: string; branch: boolean } | null {
  if (SETTINGS_KINDS.has(kind)) return { url: settingsUrl, branch: false };
  if (BRANCH_KINDS.has(kind)) {
    const url = branchSettingsUrl(settingsUrl);
    return url ? { url, branch: true } : null;
  }
  return null;
}

// --- What would clear one finding -------------------------------------------------------------------------------

/** The step that clears one finding, as sentences and, where one fits, a block to copy. */
export interface ClearingStep {
  steps: string[];
  snippet: Snippet | null;
}

/** The kind of action whose generic steps apply to each check, so a finding with nothing more specific still has steps. */
const GENERIC_KIND: Record<SupplyChainCheckId, SecurityActionKind> = {
  prHeadCheckout: "fix_pr_head_checkout",
  scriptInjection: "fix_script_injection",
  selfHostedPublic: "stop_self_hosted_public",
  unpinnedActions: "pin_actions",
  ownActionsUnpinned: "pin_own_actions",
  workflowPermissions: "restrict_permissions",
  unsecureCommands: "remove_unsecure_commands",
  keyFiles: "remove_key_files",
  weakKeyFiles: "review_weak_key_files",
  curlPipeShell: "avoid_curl_pipe_shell",
  secretsInherit: "avoid_secrets_inherit",
  persistCredentials: "disable_persist_credentials",
  updateConfig: "add_update_config",
  lockfiles: "add_lockfile",
  securityPolicy: "add_security_policy",
  dependencyReview: "add_dependency_review",
  secretScanInCi: "add_secret_scanner_ci",
  staticAnalysis: "add_static_analysis",
  baseImagesPinned: "pin_base_images",
  latestImages: "avoid_latest_images",
  nonRootImages: "run_as_non_root",
  remoteAdd: "avoid_remote_add",
};

/** The blocks that need nothing from the report, for the checks whose generic steps have one. */
const GENERIC_SNIPPET: Partial<Record<SupplyChainCheckId, () => Snippet>> = {
  workflowPermissions: () => snippet("permissions", permissionsSnippet()),
  persistCredentials: () => snippet("persistCredentials", persistCredentialsSnippet()),
  curlPipeShell: () => snippet("curlPipe", curlPipeSnippet()),
  secretsInherit: () => snippet("secretsInherit", secretsInheritSnippet()),
  baseImagesPinned: () => snippet("digest", digestSnippet()),
  latestImages: () => snippet("digest", digestSnippet()),
  nonRootImages: () => snippet("nonRoot", nonRootSnippet()),
  remoteAdd: () => snippet("remoteAdd", remoteAddSnippet()),
  selfHostedPublic: () => snippet("selfHosted", selfHostedSnippet()),
};

/** A job id as GitHub allows it, which can go into a sentence about code without being read as anything else. */
const SAFE_JOB = /^[A-Za-z0-9_-]+$/;

export const workflowRunGuard = (): string => "if: github.event.workflow_run.event == 'push'";
export const forkGuard = (): string => "if: github.event.pull_request.head.repo.full_name == github.repository";

/**
 * What would clear one finding. A finding that a pull request reaches through `workflow_run` or `pull_request_target`
 * gets the condition that keeps it out, named for the job that starts it where the route says so. A job name or path
 * goes into the sentence only after it passes a check, and otherwise the wording stays general. Anything without a more
 * specific step gets the generic steps for its check.
 */
export function clearingStep(check: SupplyChainCheckId, item: SupplyChainItem): ClearingStep {
  const text = copy.security.findingDetail.clear;
  if (check === "prHeadCheckout") {
    const run = item.routes.find((route) => route.trigger === "workflow_run");
    if (run) {
      const hop = run.via?.[0];
      const named =
        hop && hop.job !== null && SAFE_JOB.test(hop.job) && isSafePath(hop.file) ? { job: hop.job, file: hop.file } : null;
      return {
        steps: [named ? text.workflowRun(named.job, named.file) : text.workflowRunHere],
        snippet: snippet("workflowRunPush", workflowRunGuard()),
      };
    }
    if (item.routes.some((route) => route.trigger === "pull_request_target")) {
      return { steps: [text.fork], snippet: snippet("forkGuard", forkGuard()) };
    }
  }
  if (check === "scriptInjection") {
    return {
      steps: [text.injection],
      snippet: snippet("scriptInjection", scriptInjectionSnippet(), { instead: scriptInjectionRisky() }),
    };
  }
  const ref = check === "unpinnedActions" || check === "ownActionsUnpinned" ? actionRefOf(item.detail ?? "") : null;
  const made = ref ? snippet("pinnedUses", pinnedUsesSnippet(ref)) : (GENERIC_SNIPPET[check]?.() ?? null);
  return { steps: copy.security.fix[GENERIC_KIND[check]].steps, snippet: made };
}
