/**
 * Every user-facing string in the application. Components read from here and never write copy inline,
 * so wording can be reviewed in one place. Functions are used where a sentence carries a value.
 */
import type { CloseReason, NotUsedReason, SecurityActionKind, SecurityThresholds } from "@dora-dashboard/core";

/** The figures an action's sentence is written from. */
export interface ActionFacts {
  /** How many things the action covers. */
  count: number;
  /** The package, rule, workflow, secret type or source the action is about, or an empty text. */
  name: string;
  upgradeTo: string | null;
  /** The severity in lower case words, or null. */
  severity: string | null;
  /** The limits the report used, or null where the page has only a summary, which carries none. */
  thresholds: SecurityThresholds | null;
}

/** The three answers every finding gives, in plain words. */
export interface FixCopy {
  /** What is wrong, in one sentence with the numbers. */
  what: (facts: ActionFacts) => string;
  /** Why it matters, in terms of what an attacker could do. */
  why: string;
  /** What to do, in order. */
  steps: readonly string[];
}

/** " with the message "x"" for a failure that gave one, and nothing for one that gave none. */
const withMessage = (message: string) => (message ? ` with the message "${message}"` : "");
const unnamedPackage = "A package that GitHub did not name";
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const some = (count: number, noun: string, nouns = `${noun}s`) => `${count} ${plural(count, noun, nouns)}`;

/** Where to switch a GitHub security feature on. GitHub keeps them together under Advanced Security. */
const SETTINGS_PATH = "Open the repository's Settings and choose Advanced Security in the Security section of the sidebar";

/** Scheduled updates come from Dependabot or from Renovate, and the file says which. */
const updater = (file: string) =>
  /renovate/i.test(file)
    ? { subject: "Renovate is", keeps: "keeps" }
    : { subject: "Dependabot version updates are", keeps: "keep" };

const FIX = {
  rotate_secret: {
    what: ({ count, name }) =>
      `GitHub found ${plural(count, "one exposed", `${count} exposed`)} ${name || "secret"} in this repository, and ${plural(count, "it", "they")} may still work.`,
    why: "A secret that has been committed can be read by anyone who can see the repository or its history, and automated tools search for them within minutes of a push. Deleting the file does not help because the value stays in the history, so the safe response is to treat it as stolen.",
    steps: [
      "Create a replacement secret in the service that issued the old one and update the places that use it.",
      "Revoke the exposed secret in that service so that it stops working, because this is the step that actually removes the risk.",
      "Check the service's logs for use that you do not recognise, then close the alert on GitHub as revoked.",
    ],
  },
  upgrade_dependency: {
    what: ({ count, name, upgradeTo, severity }) =>
      `${name || unnamedPackage} has ${some(count, `open ${severity ? `${severity} ` : ""}alert`)}, and version ${upgradeTo ?? "a newer one"} fixes ${plural(count, "it", "them")}.`,
    why: "The version of this package that you use contains a flaw that has been published, so attackers know how to use it against every project that has not upgraded. Upgrading to the fixed version closes the gap, usually without any change to your own code.",
    steps: [
      "Run the upgrade command shown below, or merge the pull request that Dependabot has already raised for it if there is one.",
      "Run your tests to check that nothing relies on behaviour that changed between the two versions.",
      "Commit the updated lockfile together with the manifest so that everyone installs the same fixed version.",
    ],
  },
  replace_dependency: {
    what: ({ count, name }) =>
      `${name || unnamedPackage} has ${some(count, "open alert")}, and its maintainers have not published a fixed version yet.`,
    why: "No patched release exists, so upgrading cannot help. The flaw stays in your project until you replace the package, stop using the feature that is affected, or the maintainers publish a fix.",
    steps: [
      "Read the advisory linked below to see which feature of the package is affected and whether your code uses it.",
      "Look for a maintained alternative, or a different version range that the advisory does not cover.",
      "If you have to keep the package for now, dismiss the alert with a reason that explains why, so that the decision is visible to the whole team.",
    ],
  },
  fix_code_alert: {
    what: ({ count, name }) =>
      `Code scanning found ${some(count, "open alert")} for ${name ? `the rule ${name}` : "a rule that GitHub did not name"}.`,
    why: "Code scanning has spotted a pattern in your own code that is known to cause security problems, such as building a database query out of text that a visitor typed. These are weaknesses that an attacker can reach through your running application.",
    steps: [
      "Open the first location listed below and read the message on the alert to see what the scanner saw.",
      "Change the code so that anything coming from outside is checked or escaped before it is used, following the advice on the alert.",
      "Push the change and wait for the next scan, which closes the alert by itself once the pattern has gone.",
    ],
  },
  fix_pr_head_checkout: {
    what: ({ name }) => `The workflow ${name} runs code from a pull request while holding your secrets.`,
    why: "Workflows started by pull_request_target or workflow_run run with write access and secrets, even for pull requests from strangers. Checking out and running the pull request's own code there lets anyone who opens a pull request run commands with your credentials.",
    steps: [
      "Open the workflow file and find the checkout step that names the pull request's head commit or branch.",
      "Either change the trigger to pull_request, where pull requests from forks get no secrets and only a read-only token, or stop checking out the pull request's code in that workflow.",
      "If you need both, split the work into one workflow that builds the untrusted code without secrets and a second one that only reads its results.",
    ],
  },
  fix_script_injection: {
    what: ({ name }) => `The workflow ${name} pastes text written by outsiders straight into a shell command.`,
    why: "Titles, branch names and comments are chosen by whoever creates them. When a workflow pastes them into a command using the expression syntax, a title that contains a quote followed by a command is run as code, and these workflows usually hold secrets and write access.",
    steps: [
      "Find the run step that contains the expression listed below.",
      "Move the value into an environment variable on that step and refer to it as an ordinary shell variable inside the script.",
      "Check the other run steps in the same workflow for the same pattern, since it tends to be copied.",
    ],
  },
  stop_self_hosted_public: {
    what: ({ name }) => `The workflow ${name} runs pull requests from a public repository on a machine that you look after.`,
    why: "Anyone can open a pull request on a public repository, and a workflow on a self hosted runner runs that person's code on your own machine, which may sit inside your network and may keep files between runs. That gives a stranger a foothold.",
    steps: [
      "Switch the job to a GitHub hosted runner, which is a fresh virtual machine for every run.",
      "If you need your own machine, limit it to pull requests that someone from your organisation has approved first.",
      "Make sure that any self hosted runner is cleaned between jobs so that nothing is left behind for the next one.",
    ],
  },
  pin_actions: {
    what: ({ count, name }) =>
      `The workflow ${name} uses ${some(count, "action")} from other organisations that ${plural(count, "is", "are")} not pinned to a commit.`,
    why: "A version tag such as v4 can be moved by the action's owner, or by anyone who takes over their account, so the code that runs in your pipeline can change without any change in your repository. A full commit identifier cannot be moved.",
    steps: [
      "Look up the commit identifier for the version you use with the command shown below.",
      "Replace the tag with the full forty character identifier and keep the tag in a comment so that people can see which version it is.",
      "Let Dependabot raise pull requests for pinned actions, so that pinning does not leave you on old versions.",
    ],
  },
  restrict_permissions: {
    what: ({ name }) => `The workflow ${name} does not limit what its automatic token is allowed to do.`,
    why: "Every run receives a token that can act on your repository. Without a permissions block it may be able to write to your code, packages and pull requests, so a compromised step or action could change them. Granting read access only, and extra rights only where a job needs them, limits the damage.",
    steps: [
      "Add a permissions block at the top of the workflow that grants read access to the repository contents.",
      "Run the workflow, and if a step fails with a permissions error, grant that one permission to that one job only.",
      "Remove any setting of write-all, which gives every permission to every job.",
    ],
  },
  remove_unsecure_commands: {
    what: ({ name }) => `The workflow ${name} switches back on a feature that GitHub turned off for safety.`,
    why: "Allowing unsecure commands lets any text printed by a step change the environment variables and the search path of the steps that follow, so an attacker who controls a little log output can take control of the whole job.",
    steps: [
      "Delete the ACTIONS_ALLOW_UNSECURE_COMMANDS setting from the workflow.",
      "Replace any use of the old set-env and add-path commands with writes to the environment files that GitHub describes in its documentation.",
      "Run the workflow again to check that it still passes without the setting.",
    ],
  },
  remove_key_files: {
    what: ({ count }) =>
      `${some(count, "file")} that look${plural(count, "s", "")} like ${plural(count, "a private key or an environment file", "private keys or environment files")} ${plural(count, "is", "are")} stored in the repository.`,
    why: "Files such as .env and private keys usually hold passwords and keys. Everyone who can read the repository, including everyone who has ever cloned it, has a copy, and removing the file later does not remove it from the history.",
    steps: [
      "Check whether each file listed below really holds a secret.",
      "Treat every value in those files as leaked and rotate it, because anything that was ever committed stays in the history and cannot be taken back by deleting the file.",
      "Stop tracking the files with the git rm --cached command shown below, add them to .gitignore and keep the real values in your secret store or your deployment settings.",
    ],
  },
  protect_branch: {
    what: ({ name }) => `The deploy branch ${name} has no protection rules.`,
    why: "Without rules, anyone with write access can push straight to the branch that gets deployed, skip the checks, and rewrite its history. One mistake or one stolen token then reaches production directly.",
    steps: [
      "Open the branch settings of the repository and create a rule or a ruleset for the deploy branch.",
      "Require a pull request and passing status checks before anything reaches the branch.",
      "Block force pushes and deletion of the branch while you are there.",
    ],
  },
  block_force_push: {
    what: ({ name }) => `Force pushes are allowed on the deploy branch ${name}.`,
    why: "A force push can replace the history of the branch, which can remove the evidence of what changed and discard other people's work without anyone being asked.",
    steps: [
      "Open the rule that protects the deploy branch.",
      "Turn on the option that blocks force pushes.",
      "Turn on the option that blocks deleting the branch as well.",
    ],
  },
  enable_dependabot: {
    what: () => "Dependabot alerts are switched off, so nobody is told when a package you use turns out to be vulnerable.",
    why: "Most of the code in a modern project comes from packages that other people wrote. When a flaw is published in one of them, Dependabot is how you hear about it, and without it you could run a vulnerable version for months without knowing.",
    steps: [
      `${SETTINGS_PATH}, then switch on Dependabot alerts with its Enable button.`,
      "Switch on Dependabot security updates as well, so that it raises pull requests containing the fixes.",
      "Add the configuration file shown below so that it also keeps your dependencies up to date on a regular schedule.",
    ],
  },
  pin_own_actions: {
    what: ({ count, name }) =>
      `The workflow ${name} uses ${some(count, "action")} from your own organisation that ${plural(count, "is", "are")} not pinned to a commit.`,
    why: "Actions from your own organisation are trusted more, but a tag can still be moved by anyone who can write to that repository. This is advice and does not change the grade.",
    steps: [
      "Look up the commit identifier for the version you use with the command shown below.",
      "Replace the tag with the full commit identifier and keep the tag in a comment.",
      "Let Dependabot keep the pinned versions up to date for you.",
    ],
  },
  add_update_config: {
    what: () => "No Dependabot or Renovate configuration was found, so nothing schedules dependency updates for you.",
    why: "Regular small updates keep you close to the latest fixes and make each upgrade easy to review, whereas leaving dependencies alone for a year turns every security fix into a large piece of work.",
    steps: [
      "Create .github/dependabot.yml with the content shown below, which covers the kinds of dependency this repository uses.",
      "Commit it to the default branch and Dependabot will raise its first pull requests within a day.",
      "Choose a regular time for the team to review and merge those pull requests.",
    ],
  },
  add_lockfile: {
    what: ({ count }) =>
      `${some(count, "manifest")} ${plural(count, "has", "have")} no lockfile beside ${plural(count, "it", "them")}.`,
    why: "A lockfile records the exact version of every package, so that everyone installs the same code. Without one, a new release of any dependency, including a malicious one, can reach your build the next time it runs.",
    steps: [
      "Run your package manager's install command in the folder listed below to create the lockfile.",
      "Commit the lockfile alongside the manifest.",
      "Use the lockfile based install command in your pipeline, such as npm ci, so that a build fails when the two disagree.",
    ],
  },
  add_security_policy: {
    what: () => "The repository has no security policy telling people how to report a problem.",
    why: "Someone who finds a flaw needs to know how to tell you about it privately. Without a policy they may post it publicly, or decide not to report it at all.",
    steps: [
      "Create SECURITY.md using the starting text shown below.",
      "Replace the contact with an address, or the private reporting feature, that your team really monitors.",
      "Commit it to the default branch so that GitHub links to it from the repository.",
    ],
  },
  review_weak_key_files: {
    what: ({ count }) =>
      `${some(count, "file")} with ${plural(count, "a name", "names")} such as .pem or .key ${plural(count, "is", "are")} stored in the repository.`,
    why: "Files with these names are often public certificates, which are safe to share, but they can also be private keys, which are not. Only a person can tell the difference by opening them.",
    steps: [
      "Open each file listed below and check whether it contains a line that mentions a private key.",
      "If it does, treat the key as leaked and replace it, because it stays in the history even after the file is deleted, and stop tracking the file with git rm --cached.",
      "Public certificates can stay where they are, and this advice does not change the grade.",
    ],
  },
  enable_code_scanning: {
    what: () => "Code scanning is not switched on for this repository.",
    why: "Code scanning reads your own code for patterns that lead to security flaws, so that you hear about them in a pull request and not from an attacker.",
    steps: [
      `${SETTINGS_PATH}, then choose to set up code scanning with the default setup. On a public repository this is free.`,
      "On a private repository, code scanning needs GitHub Code Security, so check that your plan includes it.",
      "The workflow shown below suits this repository. It is a CodeQL workflow where GitHub code scanning is available, and a Semgrep workflow, which runs in your own pipeline and uploads nothing to GitHub, where it is not.",
    ],
  },
  check_secret_scanning: {
    what: () => "The dashboard could not read secret scanning alerts for this repository.",
    why: "Secret scanning finds passwords and keys that were committed by mistake. Without it, or without being able to read its alerts, you cannot tell whether one has leaked.",
    steps: [
      "Ask a repository administrator to check, under Settings and then Advanced Security, that secret scanning is switched on, and to look at its alerts.",
      "On a private repository this needs GitHub Secret Protection, so check that your plan includes it.",
      "Consider adding a secret scanner to your pipeline, such as the workflow shown below, while you wait.",
    ],
  },
  grant_alert_access: {
    what: ({ name }) => `GitHub refused the dashboard access to ${name || "some alerts"}, so the grade leaves them out.`,
    why: "The sign in that the dashboard uses is not allowed to read this information, so the grade describes only the parts that could be read and may look better than the whole picture.",
    steps: [
      "Look at the sources section at the end of this page to see which source was refused and why.",
      "Ask a repository administrator to give the account or token that the dashboard uses permission to read security alerts.",
      "Crawl the repository again to read them.",
    ],
  },
  turn_on_code_analysis: {
    what: () => "Workflow and dependency checks are off because code analysis is switched off on this dashboard.",
    why: "These checks read the files from a copy of your repository, and the dashboard only makes that copy when code analysis is on.",
    steps: [
      "Set CODE_ANALYSIS=on in the environment file of the dashboard.",
      "Restart the API so that it reads the new setting.",
      "Crawl the repository again to read its workflow files.",
    ],
  },
  fix_low_alerts: {
    what: ({ count, thresholds }) =>
      `${some(count, "low severity alert")} ${plural(count, "has", "have")} been open for more than ${thresholds ? `${thresholds.lowAlertAdviceDays} days` : "the time a low severity alert is allowed"}.`,
    why: "Low severity alerts rarely cause harm on their own, but they pile up, and attackers often combine several small flaws into a serious one.",
    steps: [
      "Sort the alerts table below by age and start with the oldest.",
      "Fix the ones that are quick, such as upgrading a package, and dismiss the rest with a reason that says why they do not apply.",
      "Set aside a little time each month so that the list does not grow back.",
    ],
  },
  require_status_checks: {
    what: () => "Merging does not wait for your tests and checks to pass.",
    why: "Checks only protect you when a failing one blocks the merge. If they are advisory, a rushed change can reach production with a red build.",
    steps: [
      "Open the rule for the deploy branch and turn on required status checks.",
      "Choose the checks that must pass, such as your tests and your linter.",
      "Ask for branches to be up to date before merging, so that checks run against what will really be deployed.",
    ],
  },
  require_signed_commits: {
    what: () => "Commits to the deploy branch do not have to be signed.",
    why: "A signature proves that a commit came from the person it claims to come from, so someone who steals a token cannot pass off their changes as a colleague's.",
    steps: [
      "Ask each contributor to set up commit signing with a key or with a hardware token.",
      "Turn on the branch rule that requires signed commits once everyone is ready.",
      "Remember that signing is optional advice here and does not change the grade.",
    ],
  },
  enable_security_updates: {
    what: () => "Dependabot security updates are switched off.",
    why: "With security updates on, Dependabot opens a pull request with the fix as soon as an alert appears, which turns a warning into a change that you only have to review.",
    steps: [
      `${SETTINGS_PATH}.`,
      "Switch on Dependabot security updates. It is a setting, so no file in the repository can switch it on.",
      "Review and merge the pull requests that Dependabot opens.",
    ],
  },
  enable_push_protection: {
    what: () => "Push protection is switched off, so a committed secret is only noticed after the push.",
    why: "Push protection stops a push that contains a recognised secret before it reaches the repository, which is far cheaper than rotating the secret afterwards.",
    steps: [
      `${SETTINGS_PATH}.`,
      "Switch on push protection, which sits with secret scanning.",
      "Tell the team what the warning looks like so that nobody bypasses it out of habit.",
    ],
  },
  enable_private_reporting: {
    what: () => "Private vulnerability reporting is switched off.",
    why: "It gives people who find a flaw a private way to tell you, so that the report reaches you before it reaches the public.",
    steps: [
      `${SETTINGS_PATH}.`,
      "Switch on private vulnerability reporting.",
      "Mention it in your SECURITY.md so that people know to use it.",
    ],
  },
  triage_advisories: {
    what: ({ count }) =>
      `${some(count, "security advisory", "security advisories")} ${plural(count, "is", "are")} waiting for you to look at ${plural(count, "it", "them")}.`,
    why: "An advisory in triage or draft is a report that somebody has taken the trouble to send you, and the person who sent it is waiting to hear back.",
    steps: [
      "Open the security advisories of the repository.",
      "Decide for each one whether it is a real problem, and reply to the person who reported it.",
      "Publish a fix and an advisory for the real ones, and close the rest with an explanation.",
    ],
  },
  add_dependency_review: {
    what: () => "Pull requests are not checked for newly added vulnerable dependencies.",
    why: "Dependency review warns in the pull request that adds a vulnerable package, which is the cheapest moment to choose a different one.",
    steps: [
      "Check that your plan allows it. Dependency review is free on public repositories, but on a private repository it needs GitHub Code Security.",
      "Add the workflow shown below to .github/workflows and commit it to the default branch.",
      "Make the check required on the deploy branch so that it blocks a vulnerable addition.",
    ],
  },
  add_secret_scanner_ci: {
    what: () => "No secret scanner runs in your pipeline.",
    why: "GitHub's own secret scanning is not available to you, so a scanner in your pipeline is the way to find a password or key that was committed by mistake.",
    steps: [
      "Add a scanner such as the workflow shown below to .github/workflows.",
      "Run it once over the full history to find anything old.",
      "Rotate anything it finds, because a committed secret must be treated as stolen.",
    ],
  },
  add_static_analysis: {
    what: () => "No code scanner runs in your pipeline.",
    why: "GitHub's own code scanning is not available to you, so a scanner in your pipeline is the way to find insecure patterns in your own code before they are released.",
    steps: [
      "Add the workflow shown below to .github/workflows. It is a CodeQL workflow where GitHub code scanning is available, and a Semgrep workflow where it is not, because the CodeQL results are uploaded to GitHub code scanning, which a private repository can use only with GitHub Code Security.",
      "Check the languages named in the workflow against those your repository uses.",
      "Read the first results together as a team to decide how to handle them.",
    ],
  },
  avoid_curl_pipe_shell: {
    what: ({ count, name }) =>
      `${some(count, "place")} download${plural(count, "s", "")} a script and run it straight away${name ? ` in ${name}` : ""}.`,
    why: "Piping a download into a shell runs whatever the server sends at that moment, so anyone who can change that file, or who sits in the middle of the connection, can run commands in your pipeline or your image.",
    steps: [
      "Download the file to disk first.",
      "Check it against a checksum that you have recorded, so that a change is noticed.",
      "Run it only when the checksum matches.",
    ],
  },
  avoid_secrets_inherit: {
    what: ({ count, name }) =>
      `${some(count, "call")} to another workflow pass${plural(count, "es", "")} on every secret${name ? ` in ${name}` : ""}.`,
    why: "Passing every secret means the called workflow can read all of them, even those it does not need, so a flaw in it exposes more than it should.",
    steps: [
      "List the secrets that the called workflow really uses.",
      "Replace the setting that passes everything with one line for each of those secrets.",
      "Run the workflow again to check that nothing is missing.",
    ],
  },
  disable_persist_credentials: {
    what: ({ count, name }) =>
      `${some(count, "checkout step")} keep${plural(count, "s", "")} the repository token on disk${name ? ` in ${name}` : ""} while later steps run.`,
    why: "By default the checkout step leaves the token in the local git settings, where any later step, including a third party action, can read and reuse it.",
    steps: [
      "Add persist-credentials set to false to the checkout step.",
      "Run the workflow, and if a later step really needs to push, give it the token explicitly.",
      "Repeat for each workflow that checks out code.",
    ],
  },
  pin_base_images: {
    what: ({ count, name }) =>
      `${some(count, "base image")} ${plural(count, "is", "are")} not pinned to a digest${name ? ` in ${name}` : ""}.`,
    why: "A tag such as 22-slim moves as the image is rebuilt, so the same Dockerfile can produce different software next week. A digest always means exactly the same image.",
    steps: [
      "Look up the digest of the image you use with the command shown below.",
      "Add it after the tag in the FROM line.",
      "Let Dependabot update the digest so that you still receive new releases.",
    ],
  },
  avoid_latest_images: {
    what: ({ count, name }) =>
      `${some(count, "base image")} use${plural(count, "s", "")} the latest tag or none${name ? ` in ${name}` : ""}.`,
    why: "The latest tag points at whatever was published most recently, so your build can change without any change from you, including to a release that has not been tested with your code.",
    steps: [
      "Choose the version your application is tested with.",
      "Write that version as the tag in the FROM line.",
      "Pin the digest as well, using the example shown below.",
    ],
  },
  run_as_non_root: {
    what: ({ name }) => `The image built from ${name || "this Dockerfile"} runs as the root user.`,
    why: "When a process runs as root, a flaw in the application gives an attacker full control of the container, and sometimes a way out of it. An ordinary user limits what they can reach.",
    steps: [
      "Create an unprivileged user in the Dockerfile.",
      "Add a USER line for it before the command that starts the application.",
      "Check that the application can still read and write the folders it needs.",
    ],
  },
  avoid_remote_add: {
    what: ({ count, name }) =>
      `${some(count, "ADD instruction")} fetch${plural(count, "es", "")} a file from the internet${name ? ` in ${name}` : ""}.`,
    why: "ADD with a web address downloads whatever is there at build time without checking it, so a changed file changes your image without anyone noticing.",
    steps: [
      "Replace it with a RUN step that downloads the file.",
      "Check the file against a checksum that you have recorded.",
      "Fail the build if the checksum does not match.",
    ],
  },
  merge_dependency_updates: {
    what: ({ count, thresholds }) =>
      `${some(count, "dependency update pull request")} ${plural(count, "has", "have")} been waiting for more than ${thresholds ? `${thresholds.staleUpdateDays} days` : "the time an update should wait"}.`,
    why: "An update that waits gets harder to merge as the code moves on, and if it carries a security fix, the fix is not reaching production while it waits.",
    steps: [
      "Open the oldest update pull request and check that the tests pass.",
      "Merge it, or close it with a note if you have decided not to take that update.",
      "Agree a regular time to deal with these pull requests so that they do not collect.",
    ],
  },
} satisfies Record<SecurityActionKind, FixCopy>;

export const copy = {
  appName: "Delivery Metrics",
  skipToContent: "Skip to main content",

  common: {
    loading: "Loading",
    unreadableResponse: "The server sent a reply that could not be read. Try again in a moment.",
    retry: "Try again",
    notAvailable: "No data",
    and: "and",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving",
    close: "Close",
    viewAsTable: "View as table",
    backToRepos: "Back to repositories",
    backToSpaces: "Back to Jira spaces",
    backToIssues: "Back to GitHub Issues",
    requestFailed: (status: number) => `The request failed with status ${status}.`,
    networkFailed: "The dashboard could not reach its API. Check that the API is running and try again.",
    errorTitle: "Something went wrong",
    opensInNewTab: "(opens in a new tab)",
  },

  theme: {
    toLight: "Switch to light theme",
    toDark: "Switch to dark theme",
    light: "Light",
    dark: "Dark",
  },

  auth: {
    checking: "Checking your GitHub session",
    signInTitle: "Sign in to see your delivery metrics",
    signInBody: "The dashboard reads pull requests and deploy runs from GitHub using your own access.",
    signInButton: "Sign in with GitHub",
    ghCliTitle: "The GitHub CLI is not signed in",
    ghCliBody: "This dashboard uses the GitHub CLI session on the machine running the API.",
    ghCliInstruction: "Run the command below in a terminal, then reload this page.",
    ghCliCommand: "gh auth login",
    reload: "Reload",
    signOut: "Sign out",
    signedInAs: (login: string) => `Signed in as ${login}`,
    avatarAlt: (login: string) => `${login} avatar`,
    device: {
      or: "Or sign in with your GitHub account from this page.",
      starting: "Contacting GitHub",
      codeLabel: "Your one-time code",
      copy: "Copy code",
      copied: "Copied",
      stepsTitle: "To finish signing in",
      stepOpen: "Open the GitHub page using the link below.",
      stepEnter: "Enter the code shown above.",
      stepApprove: "Approve the request, then return to this page.",
      openLink: "Open GitHub to enter the code",
      newTab: "(opens in a new tab)",
      waiting: "Waiting for GitHub",
      expired: "The code has expired. Start again to get a new one.",
      denied: "The request was declined on GitHub. Start again if you would like to try once more.",
      incomplete:
        "GitHub approved the request, but the sign-in could not be completed here. Your browser may not be keeping the session cookie. Start again, and if it repeats, check that you are using a secure address.",
      tryAgain: "Try again",
    },
  },

  nav: {
    label: "Main",
    home: "Why it matters",
    repositories: "Repositories",
    reviewQueue: "Review queue",
    jira: "Jira",
    codeAnalysis: "Code analysis",
    security: "Security",
    issues: "GitHub Issues",
    menu: "Menu",
    menuList: "Main menu",
  },

  repos: {
    title: "Repositories",
    lede: "Add the repositories you want to measure. Each one is crawled from GitHub in the background.",
    addTitle: "Add a repository",
    repoLabel: "Repository",
    repoHint: "Use owner/name, for example acme/widgets, or paste a github.com link.",
    repoPlaceholder: "acme/widgets",
    workflowLabel: "Deploy workflow (optional)",
    workflowHint: "Workflow file names whose successful runs count as deployments. Separate several with commas.",
    workflowPlaceholder: "deploy.yml",
    branchLabel: "Deploy branch (optional)",
    branchHint: "Only runs on this branch count as production deployments.",
    branchPlaceholder: "main",
    addButton: "Add repository",
    adding: "Adding",
    added: (name: string) => `${name} was added and its first crawl has started.`,
    listTitle: "Your repositories",
    emptyTitle: "No repositories yet",
    emptyBody: "Add a repository above to start collecting pull request and deployment history.",
    pullRequests: "Pull requests",
    deployRuns: "Deploy runs",
    lastCrawled: "Last crawled",
    neverCrawled: "Not yet crawled",
    deployConfig: "Deploys",
    noDeployWorkflow: "No deploy workflow configured",
    deployDescription: (workflows: string, branch: string) => `${workflows} on ${branch}`,
    status: {
      idle: "Up to date",
      crawling: "Crawling",
      failed: "Crawl failed",
    },
    crawlingFallback: "Starting crawl",
    recrawl: "Re-crawl",
    fullRecrawl: "Full re-crawl",
    configure: "Configure deploy",
    remove: "Remove",
    confirmRemove: (name: string) => `Remove ${name} and all of its collected history?`,
    selectForCompare: (name: string) => `Select ${name} for comparison`,
    compareButton: "Compare",
    compareHint: "Select two to four repositories to compare them side by side.",
    compareSelected: (count: number) => `${count} selected`,
    openDashboard: (name: string) => `Open the dashboard for ${name}`,
  },

  configure: {
    title: (name: string) => `Deploy settings for ${name}`,
    workflowsLegend: "Deploy workflows",
    workflowsHint: "Successful runs of the ticked workflows count as deployments.",
    loadingWorkflows: "Loading workflows",
    noWorkflows: "This repository has no GitHub Actions workflows.",
    branchLabel: "Deploy branch",
    saved: "Deploy settings saved. Re-crawl to pick up runs from newly ticked workflows.",
  },

  jira: {
    title: "Jira spaces",
    lede: "Jira issues are linked to this repository's pull requests by the issue key in the pull request title or branch name.",
    notConnectedTitle: "Jira is not connected",
    connect: "Connect Jira",
    connectAgain: "Connect Jira again",
    disconnect: "Disconnect Jira",
    disconnecting: "Disconnecting",
    lapsed: {
      idle: {
        title: "Your Jira connection was closed after a period of inactivity",
        body: "Jira was not used for more than 8 hours, which is the length of a dashboard session, so the connection was closed. Connect Jira again to carry on. Links you have already saved are kept.",
      },
      refused: {
        title: "Jira turned the connection down",
        body: "Jira or Atlassian refused the connection, for example because access was revoked. Connect Jira again to carry on. Links you have already saved are kept.",
      },
      expired: {
        title: "Your Jira connection ran out",
        body: "The access it was given ran out and could not be renewed. Connect Jira again to carry on. Links you have already saved are kept.",
      },
    },
    unauthorisedTitle: "Your Jira connection has expired or is missing",
    unauthorisedBody: "Connect Jira again to carry on reading spaces. Links you have already saved are kept.",
    outcomes: {
      denied: {
        title: "Jira access was not allowed",
        body: "You chose not to allow access at Atlassian, so nothing has changed. You can connect Jira whenever you are ready.",
      },
      error: {
        title: "Jira could not be connected",
        body: "The connection could not be completed. Try connecting again, and if it keeps failing, the dashboard's API log says why.",
      },
      expired: {
        title: "The Jira sign-in took too long or was lost",
        body: "The request lapsed because consent took more than 10 minutes, consent was started again in another tab, the dashboard was restarted, or the page was opened at a different address from the one the dashboard is set up with. Connect Jira again, and if this keeps happening, open the dashboard at the address set as WEB_ORIGIN.",
      },
      misconfigured: {
        title: "Atlassian refused the dashboard's own settings",
        body: "Whoever runs the dashboard should check ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET and the callback URL in .env against the app in the Atlassian developer console. Trying again will not help until they are corrected.",
      },
      rate_limited: {
        title: "Too many Jira sign-in attempts",
        body: "More than 20 attempts were made in a minute. Wait a minute and then try again.",
      },
    },
    dismiss: "Dismiss",
    loading: "Loading Jira",
    siteLabel: "Jira site",
    sitePlaceholder: "Choose a site",
    noSites: "Your Jira account has no sites the dashboard can read.",
    searchLabel: "Search spaces by name or key",
    spacesLegend: "Spaces to link",
    spacesHint: (max: number) =>
      `Choose up to ${max} spaces on this site. Saving replaces this repository's spaces on this site and leaves spaces on other sites linked.`,
    loadingSpaces: "Loading spaces",
    noSpaces: "This site has no spaces you can read.",
    noMatches: "No spaces match your search.",
    showing: (shown: number, total: number) => `Showing ${shown} of ${total} spaces`,
    selectedCount: (count: number) => (count === 1 ? "1 space selected" : `${count} spaces selected`),
    limitReached: (max: number) => `You have reached the limit of ${max} spaces.`,
    saveLinks: "Save links",
    savingLinks: "Saving links",
    linksSaved: "Links saved. The spaces are being crawled now.",
    linkedTitle: "Linked spaces",
    noLinked: "No spaces are linked to this repository yet.",
    loadingLinked: "Loading linked spaces",
    siteHeading: "Site",
    workItems: "Work items",
    lastCrawled: "Last crawled",
    neverCrawled: "Not crawled yet",
    status: {
      idle: "Up to date",
      crawling: "Crawling",
      failed: "Crawl failed",
    },
    crawlingFallback: "Starting crawl",
    crawlAlreadyRunning: "This space is already being crawled. Its progress is shown above and will update on its own.",
    recrawl: "Re-crawl",
    fullRecrawl: "Full re-crawl",
    recrawlLabel: (name: string) => `Re-crawl ${name}`,
    fullRecrawlLabel: (name: string) => `Full re-crawl ${name}`,
    flowToggle: "How this space flows",
    flowToggleLabel: (name: string) => `How the ${name} space flows`,
    loadingFlow: "Loading statuses and columns",
    columnsTitle: "Board columns, left to right",
    noBoard: "This space has no board, so only its statuses are shown.",
    boardForbiddenTitle: "Jira refused access to this space's board",
    boardForbidden:
      "The board columns are unknown, so only the statuses are shown. Add the read:board-scope.admin:jira-software scope to the app in the Atlassian developer console and connect Jira again, or check that your account can see the board.",
    noColumnStatuses: "No statuses",
    categoriesTitle: "Statuses by category",
    categories: {
      todo: "To do",
      in_progress: "In progress",
      done: "Done",
    },
    noStatuses: "This space has no statuses the dashboard can read.",
  },

  range: {
    legend: "Date range",
    from: "From",
    to: "To",
    presetsLabel: "Presets",
    allActive: "Period all were active",
    allTime: "All time",
    last90: "Last 90 days",
    last30: "Last 30 days",
    includeBots: "Include bots",
    includeBotsHint: "Count pull requests opened by automation accounts such as dependency updaters.",
  },

  dora: {
    title: "DORA measures",
    lede: "The four measures of software delivery performance, each placed in a performance band.",
    band: {
      elite: "Elite",
      high: "High",
      medium: "Medium",
      low: "Low",
    },
    bandLabel: (band: string) => `${band} performance band`,
    notMeasured: "Not measured",
    deploymentFrequency: "Deployment frequency",
    deploymentFrequencyDefinition: "How often a successful deploy reaches production.",
    perWeek: (value: string) => `${value} per week`,
    leadTime: "Lead time for changes",
    leadTimeDefinition: "Median time from a change's first commit to its successful deploy.",
    changeFailure: "Change failure rate",
    changeFailureDefinition: "Share of production deploys that failed.",
    timeToRestore: "Time to restore",
    timeToRestoreDefinition: "Median time from a failed deploy to the next successful one.",
    profileLead: "Graded against",
    profileMismatch: "These repositories were graded against different DORA profiles, so their bands are not comparable.",
    rework: "Rework rate",
    reworkDefinition: "Share of successful deploys that shipped at least one revert or hotfix pull request.",
    reworkNoBand: "DORA publishes no band for this measure, so none is shown.",
    reworkCount: (deploys: number, total: number) => `${deploys} of ${total} deploys shipped a revert or hotfix`,
    reasons: {
      noRework: "No successful deploys in this range, so there was nothing to check for reverts or hotfixes.",
      noWorkflow: "No deploy workflow is configured for this repository.",
      noRuns: (branch: string) => `No completed deploy runs on ${branch} in this range.`,
      noShipped: "No merged pull request was shipped by an observed deploy in this range.",
      noFailures: "No failed deploys in this range, so there was nothing to restore.",
      noRecovery: "No failed deploy has been followed by a successful one yet.",
      unrecovered: (since: string, runs: number) =>
        `Failures have not been put right since ${since}. ${runs} failed ${runs === 1 ? "run has" : "runs have"} had no successful deploy after ${runs === 1 ? "it" : "them"}.`,
    },
    deploysCount: (total: number, weeks: number) => `${total} successful deploys over ${weeks} weeks`,
    leadCount: (count: number) => `Across ${count} shipped pull requests`,
    failureCount: (failed: number, total: number) => `${failed} of ${total} deploys failed`,
    restoreCount: (count: number) => `Across ${count} recoveries`,
    explain: {
      summary: "Why this band, and how to move up",
      /** Read after the summary by assistive technology only, so each tile's disclosure names its measure. */
      summaryMeasure: (measure: string) => `, ${measure}`,
      meaningHeading: "What the band means",
      gapHeading: "How far to the next band",
      findingsHeading: "What drives this figure",
      practicesHeading: "Practices to try",
      systemNote: "These explanations describe stages, batches and workflows, never individual people.",
      source: {
        label: "2023 Accelerate State of DevOps Report, performance levels",
        href: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf#page=12",
      },
      meaning: {
        deploymentFrequency: {
          elite:
            "Changes reach production on demand, whenever one is ready, which is the pace DORA's 2023 report gives for its elite cluster.",
          high: "The team deploys between once a day and once a week, the pace of DORA's high cluster.",
          medium: "The team deploys between once a week and once a month, the pace of DORA's medium cluster.",
          low: "The team deploys less often than once every four weeks, which is slower than any range DORA's 2023 report gives for its medium cluster.",
        },
        leadTime: {
          elite: "A typical change reaches production less than a day after it is committed, as in DORA's elite cluster.",
          high: "A typical change takes between one day and one week to reach production, as in DORA's high cluster.",
          medium: "A typical change takes between one week and one month to reach production, as in DORA's medium cluster.",
          low: "A typical change takes longer than a month to reach production, which is slower than any range DORA's 2023 report gives for its medium cluster.",
        },
        changeFailure: {
          elite:
            "About one deployment in twenty or fewer needs immediate intervention, matching the 5% DORA reports for its elite cluster.",
          high: "About one deployment in ten or fewer needs immediate intervention, matching the 10% DORA reports for its high cluster.",
          medium:
            "Up to about one deployment in seven needs immediate intervention, matching the 15% DORA reports for its medium cluster.",
          low: "More than 15% of deployments need immediate intervention; DORA's 2023 low cluster reported 64%.",
        },
        timeToRestore: {
          elite: "A failed deployment is typically put right in less than an hour, as in DORA's elite cluster.",
          high: "A failed deployment is typically put right in less than a day, as in DORA's high cluster.",
          medium: "A failed deployment typically takes between one day and one week to put right, as in DORA's medium cluster.",
          low: "A failed deployment typically takes longer than a week to put right; DORA's 2023 low cluster reported between one month and six months.",
        },
      },
      restoreRename:
        "DORA's 2023 report calls this measure failed deployment recovery time. This dashboard keeps the label time to restore.",
      reviewQuote: {
        text: "Speeding up code reviews is one of the most effective paths to improving software delivery performance. Teams with faster code reviews have 50% higher software delivery performance.",
        label: "2023 report, executive summary",
        href: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf#page=5",
      },
      gap: {
        raise: (value: string, band: string, requirement: string, by: string) =>
          `Deployments run at ${value}. The ${band} band needs ${requirement}, which is ${by} more than now.`,
        lowerRate: (value: string, band: string, requirement: string, by: string) =>
          `${value} of deploys failed. The ${band} band needs ${requirement}, which is ${by} lower than now.`,
        lowerDuration: (value: string, band: string, requirement: string, by: string) =>
          `The median is ${value}. The ${band} band needs ${requirement}, which is ${by} shorter than now.`,
        onLimit: (value: string, band: string, requirement: string) =>
          `The median is ${value}, which sits exactly on the limit for the ${band} band. That band needs ${requirement}, so the figure must fall below the limit to qualify.`,
        holds: (value: string, requirement: string, margin: string) =>
          `At ${value} the figure is ${margin} inside the elite requirement of ${requirement}, which keeps it in the elite band.`,
        holdsOnLimit: (value: string, requirement: string) =>
          `At ${value} the figure sits exactly on the elite requirement of ${requirement}, and that limit itself counts, so it stays in the elite band.`,
        atLeast: (value: string) => `at least ${value}`,
        atMost: (value: string) => `${value} or less`,
        under: (value: string) => `under ${value}`,
        points: (value: string) => `${value} ${value === "1" ? "percentage point" : "percentage points"}`,
      },
      parts: {
        coding: "Coding",
        waitingForReview: "Waiting for review",
        inReview: "In review",
        toMerge: "Approval to merge",
        toDeploy: "Merge to deploy",
      },
      findings: {
        largestPart: (part: string, hours: string, share: string, mean: string) =>
          `${part} is the largest part of lead time, averaging ${hours}, or ${share} of the ${mean} mean. The tile shows the median, so the parts add up to the mean rather than to the tile.`,
        nextPart: (part: string, hours: string, share: string) =>
          `${part} comes next, averaging ${hours}, or ${share} of the mean.`,
        spread: (p75: string, size: string | null) =>
          size === null
            ? `One in four changes took ${p75} or longer from first commit to deploy.`
            : `One in four changes took ${p75} or longer from first commit to deploy, and the median change was ${size} lines added or removed.`,
        fewDeploys: (deploys: number, tileWeeks: number, complete: number, without: number) =>
          `The tile divides ${deploys} successful ${deploys === 1 ? "deploy" : "deploys"} by ${tileWeeks} ${tileWeeks === 1 ? "week" : "weeks"}, counting every week the range touches, partial ones included. ` +
          (complete === 0
            ? "None of those weeks was complete, so none is counted as a week without a deploy."
            : `Of the ${complete} complete ${complete === 1 ? "week" : "weeks"}, ${without} had no deploy.`),
        largeBatches: (median: string) =>
          `The median deploy shipped ${median} pull requests, so changes are released in batches.`,
        failures: (failed: number, total: number, rate: string) =>
          `${failed} of ${total} production deploys failed, which is ${rate}.`,
        worstWorkflow: (workflow: string, failed: number, total: number) =>
          `The ${workflow} workflow had the most failures, ${failed} of its ${total} runs.`,
        rework: (deploys: number, total: number) =>
          `${deploys} of ${total} successful deploys shipped a revert or hotfix pull request.`,
        streaks: (streaks: number, median: string | null, longest: string | null) =>
          `${streaks} failure ${streaks === 1 ? "streak was" : "streaks were"} put right` +
          (median === null ? "" : `, with a median of ${median} failed ${median === "1" ? "run" : "runs"} per streak`) +
          (longest === null ? "" : `, and the longest took ${longest}`) +
          ".",
        unrecovered: (since: string, runs: number) =>
          `${runs} failed ${runs === 1 ? "run has" : "runs have"} had no successful deploy after ${runs === 1 ? "it" : "them"} since ${since}.`,
      },
      practices: {
        workingInSmallBatches: {
          name: "Working in small batches",
          href: "https://dora.dev/capabilities/working-in-small-batches/",
          why: "Smaller pieces of work get feedback sooner and are easier to triage and fix, and the 2023 report names reducing batch size as a common way to improve all four measures.",
        },
        trunkBasedDevelopment: {
          name: "Trunk-based development",
          href: "https://dora.dev/capabilities/trunk-based-development/",
          why: "Merging small changes into trunk at least daily, on branches that last hours rather than days, keeps merges simple, and the page advises making review synchronous or a priority.",
        },
        streamliningChangeApproval: {
          name: "Streamlining change approval",
          href: "https://dora.dev/capabilities/streamlining-change-approval/",
          why: "DORA found that peer review inside the development process, backed by automated checks, works better than approval from outside the team, which slows delivery and enlarges batches.",
        },
        deploymentAutomation: {
          name: "Deployment automation",
          href: "https://dora.dev/capabilities/deployment-automation/",
          why: "A push-button deploy that works the same way in every environment lowers the risk of each deployment and lets anyone with the right access deploy any version on demand, including a known good one.",
        },
        continuousDelivery: {
          name: "Continuous delivery",
          href: "https://dora.dev/capabilities/continuous-delivery/",
          why: "Keeping the software deployable at all times means a change can be released on demand, and DORA reports that doing this well improves all four key metrics.",
        },
        continuousIntegration: {
          name: "Continuous integration",
          href: "https://dora.dev/capabilities/continuous-integration/",
          why: "Integrating into trunk at least daily, with automated tests on every commit, keeps the software working and branches close to trunk.",
        },
        testAutomation: {
          name: "Test automation",
          href: "https://dora.dev/capabilities/test-automation/",
          why: "Tests that run on every change give fast feedback, and DORA's research links this to better software stability and a short lead time from check-in to release.",
        },
        codeMaintainability: {
          name: "Code maintainability",
          href: "https://dora.dev/capabilities/code-maintainability/",
          why: "Code that is easy to find, reuse and change, with stable dependencies, lets a team change any part of the codebase quickly when an incident needs it.",
        },
        monitoringAndObservability: {
          name: "Monitoring and observability",
          href: "https://dora.dev/capabilities/monitoring-and-observability/",
          why: 'Tooling that shows the health of the system and lets the team debug production contributes to continuous delivery, and the page calls time to restore "the key metric in the event of an outage or service degradation".',
        },
        proactiveFailureNotification: {
          name: "Proactive failure notification",
          href: "https://dora.dev/capabilities/proactive-failure-notification/",
          why: "Alerting when monitored values approach a known failure threshold, rather than hearing about a failure from users, lets a team diagnose and solve problems quickly.",
        },
      },
      moveUp: {
        title: "How teams move up",
        body: 'DORA\'s research treats these measures as a baseline rather than a target. Its 2023 report says they "are not the means by which a team will improve"; a team improves by finding the capability that is holding it back, giving itself time to experiment, and checking again. The change DORA most often recommends is to make each change smaller, because "smaller changes are easier to reason about and to move through the delivery process" and are "easy to recover from if there\'s a failure". Each explanation on a repository\'s page names the largest driver in the team\'s own data and links to the DORA capabilities that address it. The fairest comparison is the same repository over time, since DORA warns that comparing different applications "discards the context of each application".',
        linksLead: "Good places to start are",
        links: ["workingInSmallBatches", "continuousDelivery", "testAutomation"] as const,
      },
      system: {
        quote:
          "Software delivery performance is not an individual measure; it measures your ability to change and update an application, and this can only be done by teams.",
        label: "DORA, how to empower software delivery teams",
        href: "https://dora.dev/guides/how-to-empower-software-delivery-teams/",
      },
      meaningTitle: "What each band means",
      meaningLede: "One line for each band, following the performance levels in DORA's 2023 report.",
      whyBand: "Why this band",
      whyBandRow: "Why each band",
      whyBandLabel: (repo: string) => `Why this band, ${repo}`,
    },
  },

  aiCohorts: {
    title: "AI-assisted work",
    lede: "Merged pull requests marked as AI-assisted set beside those that are not, so the two can be compared rather than guessed at.",
    caption: "Merged pull requests, AI-assisted against unassisted",
    measure: "Measure",
    assisted: "AI-assisted",
    unassisted: "Unassisted",
    prs: "Pull requests",
    medianCycle: "Median cycle time",
    p75Cycle: "75th percentile cycle time",
    medianSize: "Median size (lines)",
    reviewed: "Reviewed by someone else",
    reverts: "Revert or hotfix share",
    cycleNote: "Cycle time runs from the first commit to the merge, not to the deploy.",
    rule: "A pull request counts as AI-assisted when it carries the label ai-assisted, or when one of its commits has a Co-Authored-By trailer naming an assistant such as Claude or Copilot. Use of an assistant that leaves no label or trailer counts as unassisted, so the AI-assisted figures are a floor rather than a total.",
    unknown: (count: number) =>
      `${count} merged ${count === 1 ? "pull request" : "pull requests"} could not be classified because labels and trailers were not recorded when they were crawled.`,
    unknownHint: "Run a full crawl of this repository to record them.",
  },

  flow: {
    title: "Pull request flow",
    lede: "How work moves from first commit to merge. Medians are used so a few outliers do not dominate.",
    merged: "PRs merged",
    mergedHint: (opened: number) => `${opened} opened in this range`,
    coding: "Coding time",
    codingHint: "Median first commit to PR opened",
    firstReview: "Time to first review",
    firstReviewHint: "Median ready for review to first review",
    openToMerge: "Open to merge",
    openToMergeHint: (p75: string) => `Median, 75th percentile ${p75}`,
    reviewed: "Reviewed",
    reviewedHint: "Share of merged PRs reviewed by someone else",
    selfMerged: "Self-merged",
    selfMergedHint: "Share of merged PRs merged by their author",
    perAuthorWeek: "Merged per author-week",
    perAuthorWeekHint: "Merged PRs divided by weekly active authors",
    unreviewed: "Merged with no review",
    unreviewedHint: (unreviewed: number, counted: number, exempt: number) =>
      `${unreviewed} of ${counted} merged ${plural(counted, "pull request", "pull requests")} had no review at all; ${exempt} ${plural(exempt, "was", "were")} left out as reviewed elsewhere`,
  },

  reviewExemptions: {
    open: "Change what counts as reviewed elsewhere",
    close: "Hide the reviewed elsewhere rules",
    title: "Pull requests reviewed elsewhere",
    lede: "A merged pull request counts as having no review only when nobody reviewed it on GitHub. A review posted by Claude or any other tool under the author's own account counts as a review, because GitHub cannot tell it from the author's own comment. A pull request that copies code which was already reviewed in another repository, such as a sync, can be left out of the figure by a word in its title or by a label.",
    titleWordsLabel: "Title words",
    titleWordsHint:
      "Whole words, separated by commas. Capitals and punctuation are ignored, so Sync: shared library matches sync.",
    labelsLabel: "Labels",
    labelsHint: "Label names, separated by commas. Capitals are ignored.",
    defaultsLine: (words: string, labels: string) => `The defaults are the title words ${words} and the label ${labels}.`,
    emptyNote: "A box left empty leaves nothing out for that kind. Use the reset button to return to the defaults.",
    applyNote: "Changes apply to the figure straight away, with no crawl, because it is worked out when the report is built.",
    save: "Save rules",
    reset: "Reset to defaults",
    saved: "Rules saved. The figure already uses them, so no crawl is needed.",
    resetDone: "Rules reset to the defaults. The figure already uses them, so no crawl is needed.",
    tooMany: (limit: number) => `Name at most ${limit} entries in each box.`,
    tooLong: (limit: number) => `Each entry can have at most ${limit} characters.`,
    control: "Entries cannot contain control characters, such as a tab or a line break.",
    noWord: "Each title word needs at least one letter or digit, because titles are matched on whole words.",
    unreadable: "The rules saved for this repository could not be read, so the defaults apply until you save them again.",
    loadingDefaults: "Loading the default rules. Saving is available once they have loaded.",
  },

  charts: {
    weekStarting: "Week starting",
    partWeek: {
      soFar: (name: string) => `${name}, so far`,
      to: (name: string, day: string) => `${name}, to ${day}`,
      current: (week: string) =>
        `The week starting ${week} is not over yet, so its figures are marked so far. Its counts are drawn lighter inside an outline, because a part week holds fewer pull requests and deploys than a whole one.`,
      cut: (week: string, day: string) =>
        `The range ends on ${day}, part way through the week starting ${week}, so that week's figures stop there. Its counts are drawn lighter inside an outline, because a part week holds fewer pull requests and deploys than a whole one.`,
    },
    zoomLabel: "Weeks shown. Drag either handle to widen or narrow the range, or drag the band to move along it.",
    hours: "Hours",
    share: "Share of merged PRs",
    count: "Count",
    openedVsMerged: {
      title: "Pull requests opened and merged",
      subtitle: "Weekly count of pull requests opened against those merged.",
      opened: "Opened",
      merged: "Merged",
    },
    weeklyOpenToMerge: {
      title: "Median open to merge",
      subtitle: "The median time a pull request merged that week spent open, in hours.",
      series: "Median open to merge",
    },
    deploys: {
      title: "Deploys and failures",
      subtitle: "Weekly count of successful and failed production deploys.",
      deploys: "Successful deploys",
      failures: "Failed deploys",
    },
    stages: {
      title: "Cycle time by stage",
      subtitle: "Mean hours per stage for pull requests merged each week. Means are shown because they add up to the whole bar.",
      coding: "Coding",
      waitingForReview: "Waiting for review",
      inReview: "In review",
      toMerge: "To merge",
      stage: "Stage",
      meanHours: "Mean hours",
    },
    distribution: {
      title: "Time to merge",
      subtitle: "How long merged pull requests stayed open, as a share of all merged pull requests.",
      bucket: "Time open",
    },
    scatter: {
      title: "Pull request size and time to merge",
      subtitle: "Each dot is a merged pull request. Both axes use a log scale so small and large changes are visible together.",
      size: "Lines changed",
      openToMerge: "Hours open",
      pr: "Pull request",
    },
    noData: "No data in this range.",
  },

  authors: {
    title: "Authors",
    subtitle: "Pull request activity by author in this range.",
    login: "Author",
    opened: "Opened",
    merged: "Merged",
    medianOpenToMerge: "Median open to merge",
    reviewsGiven: "Reviews given",
    empty: "No authors in this range.",
  },

  prTable: {
    title: "Pull requests",
    subtitle: "Pull requests opened in this range. Select a column heading to sort.",
    number: "Number",
    titleColumn: "Title",
    author: "Author",
    opened: "Opened",
    merged: "Merged",
    openToMerge: "Open to merge",
    firstReview: "First review",
    size: "Lines",
    reviewed: "Reviewed",
    yes: "Yes",
    no: "No",
    notMerged: "Open or closed",
    previous: "Previous page",
    next: "Next page",
    pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
    empty: "No pull requests were opened in this range.",
    sortBy: (column: string) => `Sort by ${column}`,
  },

  authorFilter: {
    summary: (included: number, total: number) =>
      included === total ? `All authors (${total})` : included === 0 ? "No authors" : `${included} of ${total} authors`,
    hint: "Untick an author to leave their pull requests out of every figure on this page. Deploys, failure rate and restore time come from workflow runs, so of the DORA measures only lead time changes.",
    all: "All authors",
    none: "No authors",
    legend: "Authors to include",
    opened: (count: number) => (count === 1 ? "1 PR" : `${count} PRs`),
    noneChosen: "Every author is left out, so there is nothing to measure. Choose at least one author from the authors menu.",
  },

  report: {
    download: "Download PDF report",
    hint: "Opens your browser's print dialog. Choose Save as PDF as the destination.",
    prepared: (day: string) => `Report prepared on ${day}`,
    compareSubject: (names: readonly string[]) => names.join(" vs "),
  },

  codeHealth: {
    title: "Code health",
    lede: "A verdict on the deploy branch as it stands after the most recent crawl, with what is good, what to improve and the figures behind it. The grade does not follow the date range, which only decides which merged pull requests count towards the testing figure.",
    analysedAt: (sha: string, when: string) => `Analysed commit ${sha} on ${when}`,
    loading: "Loading code health",
    detailedLink: "Detailed code analysis",
    staleTitle: "The latest analysis failed",
    stale: (commitDate: string, attemptDate: string, message: string) =>
      `These figures are from the commit dated ${commitDate}. The latest attempt on ${attemptDate} failed with the message "${message}".`,
    yes: "Yes",
    no: "No",
    unknown: "Not known",

    verdict: {
      title: "Overall grade",
      definition: "The lowest of the three parts below, because code is only as healthy as its weakest area.",
      lowestPart: (part: string, sentence: string) => `${part} is the lowest part. ${sentence}.`,
      allPass: "All checks pass in every part.",
      bandName: (band: string) => `${band} code health`,
      missingTitle: "No grade yet",
      missing:
        "The grade needs the repository's tooling files as well as its functions, so it has not been produced for this analysis. The next crawl will produce it.",
    },

    parts: {
      title: "Grade by part",
      maintainability: "Maintainability",
      testing: "Testing",
      hygiene: "Hygiene",
      maintainabilityDefinition: "How much of the code sits in complex, long or wide functions.",
      testingDefinition: "How much test code there is, and whether pull requests and CI keep it up.",
      hygieneDefinition: "Whether a linter and a formatter are set up and run in CI.",
      limitedBy: (sentence: string) => `${sentence}.`,
      nothingLimits: "All checks in this part pass.",
    },

    lists: {
      goodTitle: "Good",
      goodEmpty: "Nothing stands out as a strength yet.",
      improveTitle: "To improve",
      improveEmpty: "Nothing needs improving.",
      improveHint: "Listed with the most serious first.",
    },

    findings: {
      linesAboveWarn: (good: boolean, share: string) =>
        `${good ? "Only " : ""}${share} of source lines are in functions above complexity 10`,
      linesAboveHigh: (good: boolean, share: string) =>
        `${good ? "Only " : ""}${share} of source lines are in functions above complexity 20`,
      longFunctions: (
        good: boolean,
        share: string,
        count: number | undefined,
        longest: { name: string; nloc: number } | null,
      ) => {
        if (good) return `Only ${share} of functions are longer than 60 lines`;
        if (count === undefined) return `${share} of functions are longer than 60 lines`;
        const lead = `${count} ${count === 1 ? "function is" : "functions are"} longer than 60 lines`;
        return longest ? `${lead}, the longest being ${longest.name} at ${longest.nloc} lines` : lead;
      },
      manyParams: (good: boolean, share: string, count: number | undefined) => {
        if (good) return `Only ${share} of functions take more than 5 parameters`;
        if (count === undefined) return `${share} of functions take more than 5 parameters`;
        return `${count} ${count === 1 ? "function takes" : "functions take"} more than 5 parameters`;
      },
      testRatio: (good: boolean, poor: boolean, ratio: string) =>
        ratio === "0.00"
          ? "No test code was found"
          : `Test code is ${good || !poor ? "" : "only "}${ratio} of the size of source code`,
      prsWithTests: (good: boolean, poor: boolean, share: string, withTests: number, total: number) =>
        good || !poor
          ? `${share} of merged pull requests that changed source also changed tests (${withTests} of ${total})`
          : `Only ${share} of merged pull requests changed tests alongside code (${withTests} of ${total})`,
      ciRunsTests: (good: boolean) => (good ? "CI runs the tests" : "CI does not run the tests"),
      coverageFloor: (floor: number | null, good: boolean) =>
        floor === null
          ? "No coverage floor is set"
          : good
            ? `A coverage floor of ${floor}% is configured`
            : `A coverage floor of ${floor}% is configured but below the 60% needed for elite`,
      linter: (tools: readonly string[]) =>
        tools.length > 0 ? `A linter is configured (${tools.join(", ")})` : "No linter is configured",
      formatter: (tools: readonly string[], onlyEditorconfig: boolean) =>
        tools.length > 0
          ? `A formatter is configured (${tools.join(", ")})`
          : onlyEditorconfig
            ? "No formatter is configured, because an editorconfig file only guides editors"
            : "No formatter is configured",
      ciLinter: (tools: readonly string[]) =>
        tools.length > 0 ? `The linter runs in CI (${tools.join(", ")})` : "CI does not run a linter",
      ciFormat: (tools: readonly string[]) =>
        tools.length > 0 ? `Formatting is checked in CI with ${tools.join(", ")}` : "CI does not check formatting",
    },

    detail: {
      title: "Detail",
      above: (limit: number) => `Functions above ${limit}`,
      aboveValue: (count: string, share: string) => `${count} (${share})`,
      aboveHint: (limit: number) => `Source functions with a complexity above ${limit}, and their share of all source functions.`,
      mostComplex: "Most complex function",
      mostComplexValue: (ccn: string) => `Complexity ${ccn}`,
      mostComplexNone: "No functions",
      mostComplexHint: (name: string, location: string) => `${name} at ${location}`,
      nloc: "Source lines",
      nlocHint: "Lines of code inside source functions, leaving out blank lines and comments.",
      functions: "Source functions",
      functionsHint: (tests: string) => `${tests} test functions are counted separately, and only feed the test ratio.`,
    },

    explainerTitle: "What cyclomatic complexity means",
    explainer:
      "Cyclomatic complexity counts the independent paths through a function, so each branch, loop or condition adds one. A low score is easy to read and to test. Scores above 10 are worth reviewing and scores above 20 are hard to change safely.",

    chart: {
      title: "Complexity distribution",
      subtitle: "How many source functions fall into each complexity range, where a higher score means more paths to test.",
      x: "Cyclomatic complexity",
      series: "Functions",
      keyTitle: "What the ranges mean",
      key: [
        { range: "1 to 10", meaning: "Simple" },
        { range: "11 to 20", meaning: "Moderate" },
        { range: "21 to 50", meaning: "Complex" },
        { range: "Over 50", meaning: "Very hard to test" },
      ],
    },

    testing: {
      title: "Testing checks",
      subtitle: "Signals read from the repository's files and its merged pull requests.",
      ratio: "Test ratio",
      ratioValue: (ratio: string) => `${ratio} lines inside test functions per line inside source functions`,
      prs: "Pull requests that changed tests",
      prsValue: (share: string, withTests: number, total: number) => `${share} (${withTests} of ${total} that changed source)`,
      prsNeedsCrawl: "Needs a full crawl, because file names have not been collected for these pull requests",
      prsNone: "No merged pull requests in this range changed source code",
      floor: "Coverage floor",
      floorNone: "None set",
      floorValue: (floor: number) => `${floor}% of lines, configured`,
      floorBelow: (floor: number) => `${floor}% of lines, configured but below the 60% needed for elite`,
      ci: "CI runs tests",
      unavailable: "The repository's files were not read for this analysis, so the tooling checks are not known yet.",
    },

    hygiene: {
      title: "Hygiene checks",
      subtitle: "Each tool found in the repository, and whether CI runs it.",
      tool: "Tool",
      kind: "Kind",
      configured: "Configured",
      enforced: "Runs in CI",
      linter: "Linter",
      formatter: "Formatter",
      weak: "Editor settings only",
      weakNote: "Weak, because it guides editors but does not check or change code.",
      notApplicable: "Not applicable",
      none: "No linter or formatter was found.",
    },

    hotspots: {
      title: "Most complex functions",
      subtitle:
        "The functions with the highest complexity. Complexity is weighed with length, because the grade counts the lines inside complex functions, so a long complex function costs more than a short one.",
      function: "Function",
      location: "File and line",
      ccn: "Complexity",
      nloc: "Lines",
      advice: "What would help",
      startHere: "Start here",
      adviceFor: {
        component: "Extracting a subcomponent for each state or section usually makes this component easier to follow.",
        dense:
          "This function has many small branches, often defaults or a case per value, so a lookup table or small helpers usually reads better, and part of the score comes from how the analyser counts.",
        long: "This function is long as well as branching, so splitting it into named steps usually helps most.",
        branching: "Naming the conditions as small helper functions usually makes this function easier to follow.",
        within: "This function is within every complexity and length limit, so it needs no change.",
      },
      empty: "No functions were found.",
    },

    start: {
      title: "Where to start",
      lift: (count: number, lines: number, from: string, to: string) =>
        `Simplifying ${count === 1 ? "this function" : `these ${count} functions`} (${lines} lines) would lift maintainability from ${from} to ${to}.`,
      functionItem: (name: string, location: string, lines: number) => `${name} at ${location} (${lines} lines)`,
      floor:
        "This is the least that would be needed, because changes that add lines elsewhere, or a function that stays above a limit after simplifying, can call for more. A function listed here may not appear in the table below, which shows only the ten most complex.",
      elite: "Maintainability is already in the elite band, so no function needs simplifying to lift it.",
    },

    partly: {
      title: "Some functions may not have been measured",
      body: (count: number) =>
        `${count === 1 ? "This JavaScript or TypeScript file" : `These ${count} JavaScript or TypeScript files`} could not be read in full, either because the parser met code it could not read or because ${count === 1 ? "it is" : "they are"} larger than 2 MiB or could not be opened, so some or all of ${count === 1 ? "its" : "their"} functions may be missing and the figures can read better than the code is.`,
      more: (count: number) => `and ${count} more`,
    },

    unmeasured: {
      title: "Some files were not measured",
      body: (count: number) =>
        `The API could not find lizard on its PATH, so ${count === 1 ? "1 file" : `${count} files`} in languages other than JavaScript and TypeScript ${count === 1 ? "was" : "were"} not measured and ${count === 1 ? "is" : "are"} not in any figure. Installing lizard, restarting the API if it was already running, and crawling this repository again will add ${count === 1 ? "it" : "them"}.`,
    },

    none: {
      title: "Code health has not been measured yet",
      body: "Crawl this repository to clone the deploy branch and analyse its functions.",
    },
    error: {
      title: "Code health could not be measured",
      when: (when: string) => `The last attempt was on ${when}.`,
    },

    install: {
      title: "Install lizard on the machine that runs the API",
      intro:
        "Lizard measures the languages other than JavaScript and TypeScript, which are always measured without it. Choose whichever of these suits the machine. Each installs the same tool.",
      options: [
        { label: "Any platform, if you already use uv", commands: ["uv tool install lizard"] },
        { label: "Any platform, if you already use pipx", commands: ["pipx install lizard"] },
        { label: "macOS, with Homebrew", commands: ["brew install pipx", "pipx ensurepath", "pipx install lizard"] },
        { label: "Windows, with winget", commands: ["winget install --id astral-sh.uv -e", "uv tool install lizard"] },
        {
          label: "Windows, with Python already installed",
          commands: ["py -m pip install --user pipx", "py -m pipx ensurepath", "py -m pipx install lizard"],
        },
      ],
      after:
        "Open a new terminal and run lizard --version to check it is on the PATH. If the API was already running, restart it so it can find lizard, then crawl the repository again.",
    },
  },

  codeAnalysis: {
    listTitle: "Code analysis",
    listLede:
      "Choose a repository to see its deploy branch broken down by area, with the figures for one area at a time and, when your CI publishes it, the test coverage that was measured.",
    listLoading: "Loading repositories",
    listEmptyTitle: "No repository has been added yet",
    listEmptyBody: "Add a repository and let its first crawl finish, and its detailed code analysis will be available from here.",
    listToRepos: "Go to repositories",
    listLastCrawled: "Last crawled",
    listNeverCrawled: "Not crawled yet",
    listCrawlStatus: "Crawl status",
    listOpen: (name: string) => `Open the detailed code analysis for ${name}`,
    repoLink: "Code analysis for this repository",
    title: "Detailed code analysis",
    lede: "The deploy branch broken down by area, with the figures for one area at a time and, when your CI publishes it, the test coverage that was measured. Apart from the overall grade, nothing on this page follows the date range, and coverage never changes a grade.",
    backToRepo: "Back to the repository",
    reportLabel: "code analysis",
    analysedAt: (sha: string, when: string) => `Analysed commit ${sha} on ${when}`,
    gradeLine: "Overall grade for the whole repository",
    gradeNone: "No overall grade has been produced yet",
    gradeUnavailable: "The overall grade for the whole repository could not be loaded.",
    loading: "Loading the detailed code analysis",
    notFound: "This address does not name a repository.",
    staleTitle: "The latest analysis failed",
    stale: (commitDate: string, attemptDate: string, message: string) =>
      `These figures are from the commit dated ${commitDate}. The latest attempt on ${attemptDate} failed with the message "${message}".`,
    none: {
      title: "Code has not been analysed yet",
      body: "Crawl this repository to clone the deploy branch and analyse its functions. The areas and any coverage appear after that.",
    },
    error: {
      title: "The code could not be analysed",
      when: (when: string) => `The last attempt was on ${when}.`,
    },

    unknownMode: {
      title: "The areas are a first guess",
      body: "The analysis has no list of this repository's files, because it was stored before they were recorded or the listing failed, so the areas below come from folder names alone. A full re-crawl of the repository finds its workspaces.",
    },
    missingArea: {
      title: "That area was not found",
      body: (area: string) => `This repository has no area called ${area}, so the figures below are for the whole repository.`,
      clear: "Show the whole repository",
    },

    areas: {
      packagesTitle: "Packages",
      foldersTitle: "Folders",
      none: "No area",
      root: "Files at the repository root",
      wholeRepository: "Whole repository",
      subtitleWorkspace:
        "Each workspace package or project with its own manifest, and also folder and root areas for code that sits outside every package, with the size and complexity of its source code. Choose one to see its figures below.",
      subtitleFolder:
        "The folders found by following the folder that holds most of the source, with the size and complexity of its source code. Choose one to see its figures below.",
      bandNote:
        "The band is for maintainability only. An area has no overall grade, because testing and tooling are measured across the whole repository.",
      chart: {
        title: "Complex code by area",
        subtitle: (warn: number) =>
          `Source lines inside functions with a complexity above ${warn}, for the areas with the most, so the best places to simplify stand out.`,
        series: "Lines above the warning complexity",
        x: "Source lines in complex functions",
        capped: (shown: number, total: number) =>
          `The chart shows the ${shown} areas with the most. The table lists all ${total}.`,
      },
      table: {
        area: "Area",
        files: "Source files",
        functions: "Functions",
        nloc: "Source lines",
        above: (warn: number) => `Above ${warn}`,
        mean: "Mean complexity",
        band: "Maintainability",
        coverage: "Coverage",
        noBand: "No functions",
        noCoverage: "Not reported",
        selected: "Selected",
      },
      capped: (shown: number, total: number) => `Showing the ${shown} largest of ${total} areas.`,
      empty: "No areas were found.",
    },

    scope: {
      titleWhole: "Whole repository",
      titleArea: (area: string) => `Area ${area}`,
      subtitle: "The same figures as the code health section, for the part of the repository chosen above.",
      empty: "This scope has no source functions.",
      checks: {
        title: "Maintainability checks",
        subtitle: "The four checks that set the maintainability band for this scope, each with the share it measured.",
        bandLabel: "Maintainability band for this scope",
        bandNote: "This is the maintainability part only. It is not an overall grade.",
        noBand: "No source function in this scope, so there is no band.",
      },
      partly: {
        title: "Some functions in this scope may not have been measured",
        body: (count: number) =>
          `${count === 1 ? "This file" : `These ${count} files`} could not be read in full, so some functions may be missing and the figures can read better than the code is.`,
      },
      startFloor:
        "This is the least that would be needed, because changes that add lines elsewhere, or a function that stays above a limit after simplifying, can call for more.",
    },

    functions: {
      title: "Functions in this scope",
      subtitle:
        "Source functions with the most complex first, with the area each one sits in and, when coverage was read, how much of it ran.",
      area: "Area",
      coverage: "Measured coverage",
      coverageUnknown: "Not known",
      capped: (shown: number, total: number) => `Showing the ${shown} most complex of ${total} functions.`,
      printNote: "The full table is on screen only. The functions most worth simplifying are listed under where to start.",
    },

    ranges: {
      span: (first: number, last: number) => `${first} to ${last}`,
      withMore: (label: string, more: number) => `${label} and ${more} more`,
    },

    coverage: {
      title: "Measured test coverage",
      lede: "Read from the coverage report your CI published. It shows what the tests ran and never changes a grade, band or check.",
      empty: {
        title: "No coverage has been read for this repository",
        intro:
          "Coverage is read from a GitHub Actions artefact. To have it appear here, upload one from the workflow that runs on the deploy branch.",
        points: [
          "The artefact name must contain the word coverage, for example coverage or coverage-api.",
          "It must hold one of lcov.info or a .lcov file, coverage-final.json, coverage-summary.json, or a Cobertura XML file named coverage.xml or with cobertura in its name.",
          "It must come from a run on the deploy branch of this repository. Coverage is read on the next crawl while code analysis is switched on.",
        ],
      },
      error: {
        title: "Coverage could not be read",
        body: (message: string, when: string) => `The attempt on ${when} failed with the message "${message}".`,
      },
      lastError: {
        title: "The latest coverage read failed",
        body: (message: string, when: string) =>
          `The figures below are from an earlier read. The attempt on ${when} failed with the message "${message}".`,
      },
      otherCommit: {
        title: "This coverage is from a different commit",
        body: (coverageSha: string, analysedSha: string) =>
          `The coverage was measured on commit ${coverageSha}, but the code above was analysed at commit ${analysedSha}, so the two can differ a little.`,
      },
      lineNote:
        "These line figures were measured on a different commit from the one analysed, so a function that has moved since may be listed against the wrong lines.",
      source: (artefacts: string, runId: number, when: string, formats: string, created: string) =>
        `Read from ${artefacts}, run ${runId}, on ${when}, in ${formats} format. The newest report was created on ${created}.`,
      artefactsRead: (read: number, inRun: number) =>
        `${read} of the ${inRun} coverage artefacts in that run were read, so the figures may leave out the rest.`,
      unreadable: (count: number) =>
        `${count} coverage ${count === 1 ? "file" : "files"} could not be read and ${count === 1 ? "was" : "were"} left out.`,
      notCovered: {
        titleArea: "The coverage report does not cover this area",
        titleWhole: "The coverage report does not match any file in this repository",
        body: "None of the files in the report match a source file here, so there are no figures to show. Your CI may upload coverage for other packages only.",
      },
      files: (matched: number, inReport: number, unmatched: number) =>
        unmatched === 0
          ? `All ${inReport} source files in the report were matched to files in this repository.`
          : `${matched} of the ${inReport} source files in the report were matched to files in this repository. The other ${unmatched} could not be matched and are left out of the figures.`,
      totalsOnly:
        "This report holds totals for each file only, so the lines that were not run and the coverage of each function are not available.",
      tiles: {
        lines: "Line coverage",
        branches: "Branch coverage",
        functions: "Function coverage",
        notReported: "Not reported",
        linesHint: (covered: string, total: string) => `${covered} of ${total} lines that can run were run by the tests.`,
        branchesHint: (covered: string, total: string) =>
          `${covered} of ${total} branches, the two sides of each condition, were taken.`,
        functionsHint: (covered: string, total: string) => `${covered} of ${total} functions were called at least once.`,
        notReportedHint:
          "This report does not carry that figure for the files here, or those files have nothing that can be measured for it.",
      },
      least: {
        title: "Least covered files",
        subtitle: "The files with the most lines that no test ran, with the line ranges that were not run.",
        file: "File",
        covered: "Lines run",
        coveredValue: (covered: number, total: number) => `${covered} of ${total}`,
        notRun: "Lines not run",
        empty: "No file among the kinds of code this report covers has a line that was not run.",
        capped: (shown: number, total: number) => `Showing the ${shown} files with the most lines not run, out of ${total}.`,
      },
      notInReport: {
        title: "Files not in the coverage report",
        subtitle: "Source files with functions that the report does not mention, which usually means no test loads them.",
        file: "File",
        functions: "Functions",
        nloc: "Source lines",
        empty: "No source file is missing from the report among the kinds of code it covers.",
        otherKinds: (count: number) =>
          `${count} source ${count === 1 ? "file" : "files"} in areas or languages the report does not cover ${count === 1 ? "is" : "are"} not listed.`,
        capped: (shown: number, total: number) => `Showing the ${shown} largest of ${total} files.`,
      },
      untested: {
        title: "Complex functions with no coverage",
        subtitle: (warn: number) =>
          `Functions with a complexity above ${warn} where none of the lines that can run were run, so the riskiest code has no test behind it.`,
        empty: "No complex function in the code this report covers is entirely uncovered.",
        totalsOnly: "Per-function coverage is not available, because the report holds totals for each file only.",
        capped: (shown: number, total: number) => `Showing the ${shown} most complex of ${total} functions.`,
      },
    },
  },

  repo: {
    loadingTitle: "Loading repository",
    lastCrawled: (when: string) => `Last crawled ${when}`,
    rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
    excludingAuthors: (logins: readonly string[]) =>
      `Leaving out pull requests by ${new Intl.ListFormat("en-GB", { type: "conjunction" }).format(logins)}.`,
    crawlInProgress: "A crawl is in progress, so these figures may still change.",
    notFound: "This repository could not be found.",
    toRepos: "Go to repositories",
    issuesLink: "GitHub Issues for this repository",
  },

  spaces: {
    title: "Jira spaces",
    lede: "The spaces the dashboard has crawled from Jira. Open one to see how its work flows from idea to production.",
    loading: "Loading Jira spaces",
    emptyTitle: "No Jira spaces are tracked yet",
    emptyBody:
      "Open Configure deploy on a repository and link a space under Jira spaces. The space is crawled once it is linked, and it then appears here.",
    toRepos: "Go to repositories",
    offTitle: "Jira is not switched on",
    offBody:
      "Add the Atlassian settings to .env in the repository root and restart the API, then connect Jira from a repository.",
    site: "Site",
    issues: "Issues",
    lastCrawled: "Last crawled",
    neverCrawled: "Not crawled yet",
    linkedRepos: "Linked repositories",
    noLinkedRepos: "None linked",
    crawlFailedTitle: "The last crawl of this space failed",
    crawlFailedReason: (reason: string) => `The reason given was ${reason}`,
  },

  space: {
    loadingTitle: "Loading space",
    notFoundTitle: "This space could not be found",
    notFoundBody: "It may have been unlinked, or Jira may not be switched on for this dashboard.",
    toSpaces: "Go to Jira spaces",
    crawlFailedTitle: "The latest crawl of this space failed",
    crawlFailedBody: "These figures may be out of date, because they come from the last crawl that completed.",
    crawlFailedReason: (reason: string) => `The reason given was ${reason}`,
    rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
    lastCrawled: (when: string) => `Last crawled ${when}`,
    showPeople: "Show people",
    showPeopleHint: "Group the hygiene lists by assignee name. Names never appear in charts or tiles.",
    showAll: (count: number) => `Show all ${count}`,
    showFewer: "Show fewer",
    printMore: (count: number) => `and ${count} more, listed on the page on screen`,
    openInJira: "(opens in Jira)",

    headline: {
      title: "Delivery from Jira",
      lede: "Stories, bugs, tasks and features are counted. Sub-tasks are not counted, but a pull request that names a sub-task counts towards its parent, and epics are shown apart.",
      done: "Done",
      doneHint: (created: number) => `Items finished in this range, with ${created} created`,
      inProgress: "In progress",
      inProgressHint: (epics: number) =>
        `At the end of the range. ${epics} ${epics === 1 ? "epic is" : "epics are"} open now and not counted`,
      cycle: "Issue cycle time",
      cycleHint: (p75: string) => `Median started to done, 75th percentile ${p75}`,
      lead: "Issue lead time",
      leadHint: (p75: string) => `Median created to done, 75th percentile ${p75}`,
      flowEfficiency: "Flow efficiency",
      flowEfficiencyHint: "Time spent actively worked as a share of started to done",
      linked: "Linked to a pull request",
      linkedHint: (linked: number, of: number) => `${linked} of ${of} done items have at least one pull request`,
    },

    flow: {
      title: "Flow",
      lede: "How much work finishes each week, how much is under way at once, and what has been waiting longest.",
      throughput: {
        title: "Items done each week",
        subtitle:
          "Delivery items finished each week, stacked by issue type. Weeks cut short by the end of the range are left out.",
        total: "Total",
        /** The one series every issue type beyond story, bug, task and feature is folded into. */
        otherType: "Other",
      },
      wip: {
        title: "Work in progress",
        subtitle:
          "Delivery items in an in-progress status at the end of each week. Weeks cut short by the end of the range are left out.",
        series: "In progress",
      },
      ageing: {
        title: "Ageing work",
        subtitle: "Items in progress now, oldest first, with the time since they started.",
        key: "Issue",
        summary: "Summary",
        type: "Type",
        status: "Status",
        age: "Age",
        empty: "Nothing is in progress now.",
      },
    },

    columns: {
      title: "Time per column",
      lede: "Where finished work spent its time on the board.",
      chartTitle: "Mean time in each board column",
      subtitle:
        "Mean hours per done item in each column, from started to done, so the columns add up to the mean issue cycle time.",
      column: "Column",
      mean: "Mean",
      median: "Median",
      items: "Items",
      barLabel: "Mean time",
      /** The label for time in statuses that no board column holds, which the report gives as a column of null. */
      notOnBoard: "Not on the board",
      noBoardNote: "This space has no board, so each status is shown as its own column.",
      forbiddenTitle: "The board could not be read",
      forbiddenNote:
        "Jira refused access to this space's board, so each status is shown as its own column. Add the read:board-scope.admin:jira-software scope to the app in the Atlassian developer console and connect Jira again, or check that your account has permission to see the board.",
    },

    idea: {
      title: "Idea to production",
      lede: (linked: number, of: number, share: string) =>
        `Only done items with a linked pull request can be measured, so these figures cover at most ${linked} of ${of} done items (${share}), and issue to production covers fewer when a linked pull request has not shipped. Work with no linked pull request is left out, so the times may not represent the whole picture.`,
      toFirstPr: "Issue to first pull request",
      toFirstPrHint: (p75: string, count: number) =>
        `Median created to first pull request opened, 75th percentile ${p75}, across ${count} items`,
      toProduction: "Issue to production",
      toProductionHint: (p75: string, count: number) =>
        `Median created to the deploy that shipped the last pull request, 75th percentile ${p75}, across ${count} items`,
    },

    hygiene: {
      title: "Jira hygiene",
      lede: "Prompts to tidy the board so the figures above can be trusted. They are not a score, and some work genuinely needs no code.",
      checkThese: "Check these",
      none: "Nothing to check here.",
      found: (count: number) => `${count} to check`,
      foundOf: (count: number, of: number, share: string) => `${count} of ${of} to check (${share})`,
      unassigned: "Unassigned",
      /** Someone is assigned, but the space was crawled before names were recorded or holds no name for them. */
      nameNotRecorded: "Assigned, name not recorded",
      movedTogether: (count: number, at: string) => `${count} moved to done at ${at}`,
      checks: {
        pr_without_key: {
          title: "Pull requests with no issue key",
          explanation:
            "Merged pull requests whose title or branch names no Jira issue, so their work cannot be traced back to the board.",
        },
        done_without_pr: {
          title: "Done items with no pull request",
          explanation:
            "Items marked done that no pull request mentions. Some work needs no code, so check whether a key is missing.",
        },
        skipped_in_progress: {
          title: "Done items that skipped in progress",
          explanation: "Items that went straight to done without being started, which hides how long the work really took.",
        },
        bulk_move: {
          title: "Items closed together",
          explanation:
            "Five or more items moved to done within ten minutes, which usually means the board was tidied rather than updated as work finished.",
        },
        reopened: {
          title: "Reopened items",
          explanation:
            "Items moved from done back to a status that is not done, which is worth a look at what was missed the first time.",
        },
        stale_in_progress: {
          title: "Stale work in progress",
          explanation: "Items in progress now with no update in the last seven days.",
        },
        in_progress_unassigned: {
          title: "In progress with no assignee",
          explanation: "Items being worked on that nobody is shown as owning.",
        },
      },
    },
  },

  issues: {
    title: "GitHub Issues",
    lede: "The repositories whose issues the dashboard has read from GitHub. Open one to see how its issues flow from being raised to reaching production.",
    loading: "Loading repositories with issues",
    emptyTitle: "No repository has GitHub issues yet",
    emptyBody:
      "Issues are read from GitHub during each crawl, so a repository appears here once a crawl has found issues in it. Start a crawl from the repositories page, and check that the repository has issues switched on and that your token can read them.",
    toRepos: "Go to repositories",
    issues: "Issues",
    lastCrawled: "Last crawled",
    neverCrawled: "Not crawled yet",
    openReport: (name: string) => `Open the GitHub Issues report for ${name}`,
    errorTitle: "The last read of issues failed",
    errorReason: (reason: string) => `The reason given was ${reason}. The rest of the crawl was not affected.`,
  },

  issue: {
    loadingTitle: "Loading repository",
    /** Names the kind of report in the file name offered when the page is saved as a PDF. */
    reportLabel: "github issues report",
    notFoundTitle: "This repository could not be found",
    notFoundBody: "The address may not name a repository the dashboard tracks, or the repository may have been removed.",
    toIssues: "Go to GitHub Issues",
    crawlFailedTitle: "The latest crawl of this repository failed",
    crawlFailedBody: "These figures may be out of date, because they come from the last crawl that completed.",
    crawlFailedReason: (reason: string) => `The reason given was ${reason}`,
    issueErrorTitle: "The last read of this repository's issues failed",
    issueErrorBody: "These figures come from the last read that completed, so they may be out of date.",
    issueErrorReason: (reason: string) => `The reason given was ${reason}`,
    issuesDisabledTitle: "Issues are switched off on GitHub for this repository",
    issuesDisabledBody: "Any figures here come from issues read before they were switched off, so they may be out of date.",
    reposFailedTitle: "The crawl status could not be loaded",
    reposFailedBody: "The report below is unaffected, but a failed crawl or a failed read of issues would not be shown here.",
    rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
    lastCrawled: (when: string) => `Last crawled ${when}`,
    showPeople: "Show people",
    showPeopleHint:
      "Show assignee names in the ageing list and group the hygiene lists by assignee. Names never appear in charts or tiles.",
    kinds: {
      bug: "Bug",
      feature: "Feature",
      maintenance: "Maintenance",
      incident: "Incident",
      security: "Security",
      other: "Other",
      epic: "Epic",
    },
    priorities: {
      P0: "P0",
      P1: "P1",
      P2: "P2",
      P3: "P3",
      P4: "P4",
      none: "No priority",
    },
    weeks: "Weeks",

    headline: {
      title: "Delivery from GitHub Issues",
      lede: "Epics are left out of every figure and shown only as a count of those still open. Issues closed as not planned or as duplicates are not counted as closed, and they are left out of every time.",
      opened: "Opened",
      openedHint: "Issues raised in this range",
      closed: "Closed",
      closedHint: (notPlanned: number) =>
        `Closed as completed in this range, with ${notPlanned} more closed as not planned or as duplicates`,
      open: "Open at the end",
      openHint: (epics: number) =>
        `Still open when the range ends. ${epics} ${epics === 1 ? "epic is" : "epics are"} open and not counted`,
      timeToClose: "Time to close",
      timeToCloseHint: (p75: string) => `Median from opened to closed as completed, 75th percentile ${p75}`,
      linked: "Linked to a pull request",
      linkedHint: (linked: number, total: number) =>
        `${linked} of ${total} issues closed as completed have at least one pull request`,
      oldest: "Longest open",
      oldestHint: (number: number) => `Issue #${number} has been open longest, measured to the end of the range`,
      oldestNone: "No issue is open when the range ends",
    },

    flow: {
      title: "Flow",
      lede: "How many issues are raised and closed each week, which kinds of work get closed, and how many are left open.",
      partWeek: {
        current: (week: string) =>
          `The week starting ${week} is not over yet, so its figures are marked so far. Its counts are drawn lighter inside an outline, because a part week holds fewer issues than a whole one. The open count is a position at one moment and is not lowered by a short week.`,
        cut: (week: string, day: string) =>
          `The range ends on ${day}, part way through the week starting ${week}, so that week's figures stop there. Its counts are drawn lighter inside an outline, because a part week holds fewer issues than a whole one. The open count is a position at one moment and is not lowered by a short week.`,
      },
      openedClosed: {
        title: "Issues opened and closed",
        subtitle:
          "Weekly count of issues opened against those closed as completed. Issues closed as not planned or as duplicates are not counted.",
        opened: "Opened",
        closed: "Closed",
      },
      closedByKind: {
        title: "Closed by kind",
        subtitle:
          "Issues closed as completed each week, stacked by kind. The kind comes from the issue type, a label or the title, and an issue that names none counts as other.",
        total: "Total",
      },
      openAtEnd: {
        title: "Open at the end of each week",
        subtitle:
          "Issues still open at the end of each week, or at the end of the range for the last week. Epics are not counted.",
        series: "Open issues",
      },
    },

    open: {
      title: "Open issues and time to close",
      lede: "What is still open at the end of the range, by kind and by priority, and how long closed issues took.",
      byKind: {
        title: "Open by kind",
        subtitle: "Issues open at the end of the range, by kind. Epics are not counted.",
        series: "Open issues",
        kind: "Kind",
      },
      byPriority: {
        title: "Open by priority",
        subtitle: "Issues open at the end of the range, by priority. An issue that names no priority is shown as no priority.",
        series: "Open issues",
        priority: "Priority",
      },
      timeToClose: {
        title: "Time to close by priority",
        subtitle:
          "Median time from opened to closed as completed for issues closed in this range, by priority. The table gives the median, 75th percentile and mean, and how many issues each covers.",
        series: "Median time to close",
        issues: "Issues",
        median: "Median",
        p75: "75th percentile",
        mean: "Mean",
        priority: "Priority",
      },
    },

    ageing: {
      title: "Ageing issues",
      subtitle: "Issues open at the end of the range, oldest first, with how long each had been open when the range ends.",
      number: "Issue",
      issueTitle: "Title",
      kind: "Kind",
      priority: "Priority",
      age: "Age",
      assignee: "Assignee",
      noPriority: "None",
      unassigned: "Unassigned",
      empty: "No issue is open when the range ends.",
      cut: (shown: number, total: number) => `Showing the ${shown} oldest of ${total} open issues.`,
    },

    idea: {
      title: "Idea to production",
      lede: (linked: number, total: number, share: string) =>
        `Only issues closed as completed that have a linked pull request can be measured, so these figures cover at most ${linked} of ${total} issues (${share}), and issue to production covers fewer when a linked pull request has not shipped. A pull request is linked by a closing reference, which includes the link in the issue's Development section, by an issue number in its title, or by a number in its branch name. The times leave out work that is linked in none of those ways.`,
      toFirstPr: "Issue to first pull request",
      toFirstPrHint: (p75: string, count: number) =>
        `Median from opened to the first linked pull request opened, 75th percentile ${p75}, across ${count} issues`,
      toProduction: "Issue to production",
      toProductionHint: (p75: string, count: number) =>
        `Median from opened to the deploy that shipped the last of its merged linked pull requests, 75th percentile ${p75}, across ${count} issues`,
    },

    hygiene: {
      title: "Issue hygiene",
      lede: "Prompts to tidy the issues so the figures above can be trusted. They are not a score, and some issues genuinely need no code.",
      checkThese: "Check these",
      none: "Nothing to check here.",
      found: (count: number) => `${count} to check`,
      foundOf: (count: number, of: number, share: string) => `${count} of ${of} to check (${share})`,
      checks: {
        closed_without_pr: {
          title: "Closed with no pull request",
          explanation:
            "Issues closed as completed in this range that no pull request is linked to. Some work needs no code, so check whether a closing keyword or an issue number is missing.",
        },
        reopened: {
          title: "Reopened issues",
          explanation:
            "Issues that were closed and then opened again in this range, which is worth a look at what was missed the first time.",
        },
        urgent_unassigned: {
          title: "Urgent issues with no assignee",
          explanation: "Issues open at the end of the range with priority P0 or P1 that nobody is assigned to.",
        },
        stale_urgent: {
          title: "Stale urgent issues",
          explanation: (days: number) =>
            `Open P0 and P1 issues, incidents and security issues with no update in the ${days} days before the range ends.`,
        },
        unclassified: {
          title: "Open issues with no kind or priority",
          explanation:
            "Open issues whose type, labels and title name neither a kind nor a priority, so they are counted as other and cannot be ranked.",
        },
        pr_without_issue: {
          title: "Pull requests with no issue",
          explanation:
            "Pull requests merged in this range by a person that no issue is linked to. A pull request counts as linked when it has a closing keyword or an issue number in its title or branch name, so where pull requests carry none of those this list will be long.",
        },
      },
    },
  },

  issueLabels: {
    title: "GitHub issue labels",
    lede: "Issues are given a kind and a priority from their type, labels and title. Name the labels your team uses for each, separated by commas. A box left empty keeps the default, which is shown inside it.",
    kindsLegend: "Kinds",
    prioritiesLegend: "Priorities",
    kindLabel: (kind: string) => `${kind} labels`,
    priorityLabel: (priority: string) => `${priority} labels`,
    save: "Save labels",
    reset: "Reset to defaults",
    saved: "Labels saved. The report already uses them, so no crawl is needed.",
    resetDone: "Labels reset to the defaults. The report already uses them, so no crawl is needed.",
    applyNote: "Changes apply to the report straight away, because kinds and priorities are worked out when the report is built.",
    tooMany: (limit: number) => `Name at most ${limit} labels for each kind or priority.`,
    tooLong: (limit: number) => `Each label can have at most ${limit} characters.`,
    control: "Label names cannot contain control characters, such as a tab or a line break.",
    unreadable: "The label names saved for this repository could not be read, so the defaults apply until you save them again.",
    loadingDefaults: "Loading the default label names. Saving is available once they have loaded.",
  },

  compare: {
    title: "Compare repositories",
    lede: "The same measures for each repository on shared axes. Each repository keeps one colour throughout.",
    needTwo: "Pick at least two repositories to compare.",
    tooMany: "Only the first four repositories are compared.",
    controls: "Comparison options",
    align: "Align to project start",
    alignHint: "Count weeks from each project's first pull request instead of by calendar date.",
    perContributor: "Per contributor",
    perContributorHint: "Divide weekly throughput by the number of people active that week.",
    showPeople: "Show people",
    showPeopleHint: "Off by default so the comparison stays about process rather than individuals.",
    logScale: "Log scale",
    alignedAxis: "Week N since first PR",
    weekN: (n: number) => `Week ${n}`,
    clippedNote: (weeks: number) =>
      `Aligned view is clipped to ${weeks} weeks, the length of the shortest history, so every repository covers the same span.`,
    missing: (count: number) =>
      count === 1 ? "One requested repository could not be found." : `${count} requested repositories could not be found.`,
    headline: {
      title: "Headline figures",
      subtitle: "One column per repository for the selected range.",
      metric: "Measure",
      merged: "PRs merged",
      authors: "Authors",
      authorWeeks: "Author-weeks",
      perAuthorWeek: "Merged per author-week",
      medianSize: "Median PR size (lines)",
      coding: "Median coding time",
      firstReview: "Median time to first review",
      openToMerge: "Median open to merge",
      openToMergeReviewed: "Median open to merge, reviewed",
      openToMergeUnreviewed: "Median open to merge, unreviewed",
      reviewed: "Share reviewed",
      selfMerged: "Share self-merged",
      deploysPerWeek: "Deploys per week",
      leadTime: "Lead time for changes",
      changeFailure: "Change failure rate",
      timeToRestore: "Time to restore",
    },
    cumulative: {
      title: "Cumulative pull requests merged",
      subtitle: "Running total of merged pull requests for each repository.",
      yLabel: "PRs merged to date",
    },
    throughput: {
      title: "Pull requests merged per week",
      titlePerContributor: "Pull requests merged per active author per week",
      subtitle: "Weekly merged pull requests for each repository.",
      subtitlePerContributor: "Weekly merged pull requests divided by the number of people active that week.",
      yLabel: "PRs merged",
      yLabelPerContributor: "PRs merged per author",
    },
    openToMerge: {
      title: "Median open to merge per week",
      subtitle: "The median hours a pull request merged that week spent open.",
      logNote: "Weeks with a zero median are left out on a log scale.",
      yLabel: "Time open",
    },
    distribution: {
      title: "Time to merge distribution",
      subtitle:
        "Share of each repository's merged pull requests in each time bucket, so repositories of different sizes compare fairly.",
    },
    composition: {
      title: "Cycle time composition",
      subtitle: "Mean of the weekly stage means over the range, shown as a share of the whole cycle.",
      noStages: "No merged pull requests with stage data in this range.",
    },
    deploys: {
      title: "Deploys per week",
      subtitle: "Weekly successful production deploys for each repository.",
      yLabel: "Deploys",
    },
    batch: {
      title: "Batch size",
      subtitle: "Lines merged per author-week and median pull request size for each repository.",
      caveat:
        "Lines changed include generated files, lockfiles and vendored code, so treat them as an indication of batch size rather than output.",
      linesPerAuthorWeek: "Lines merged per author-week",
      medianSize: "Median PR size (lines)",
    },
    people: {
      title: "People",
      subtitle: (repo: string) => `Authors in ${repo} for the selected range.`,
    },
    fair: {
      title: "Reading this fairly",
      teamSizes: "Team sizes differ. Authors in this range",
      authorsOf: (repo: string, count: number) => `${repo} ${count === 1 ? "has 1 author" : `has ${count} authors`}`,
      reviewSplit:
        "Reviewed and unreviewed pull requests are shown separately, because a solo author waits for nobody and would otherwise look fast.",
      ages: "Projects of different ages are best compared with Align to project start switched on.",
      overlap:
        "Period all were active compares the same calendar weeks, when every team was working at once; Align to project start compares each project's first weeks instead.",
      leadTime: "Lead time only counts pull requests merged after deploy runs were first observed for that repository.",
      partialWeek:
        "The current week is left off the weekly charts until it ends, so a week only two days old does not look like a slump.",
    },
  },

  home: {
    eyebrow: "Why we measure",
    title: "Deliver small changes often, and keep the code easy to change",
    lede: "This dashboard measures how work moves from a first commit to production, and how healthy the code is that it moves through. This page explains the ideas behind those figures, why they matter to the people who write the software, and how to read them without turning them into targets.",
    toRepos: "Go to your repositories",
    toKeys: "Start with the four keys",
    heroDiagram:
      "A change moves from commit to review, merge, deploy and the people who use it, and what they learn feeds back into the next commit.",
    pipeline: ["Commit", "Review", "Merge", "Deploy", "Users"],
    feedback: "Feedback",

    principlesTitle: "The short version",
    principles: [
      {
        title: "Speed and stability move together",
        body: "The DORA research programme has found, year after year, that teams who deploy more often also tend to fail less and recover sooner, so speed and safety are not a trade to be negotiated.",
      },
      {
        title: "Batch size is the lever",
        body: "Small pull requests are reviewed sooner, merged sooner and are easier to undo, which improves every one of the four keys at the same time.",
      },
      {
        title: "Simple code keeps it that way",
        body: "Code that is tested, clear and free of duplication stays cheap to change, and cheap change is what lets a team keep its pace as the system grows.",
      },
    ],

    doraEyebrow: "Delivery performance",
    doraTitle: "The four keys",
    doraLede:
      "The DevOps Research and Assessment programme, described in the book Accelerate and in the yearly State of DevOps reports, identified four measures that predict both software delivery performance and wider organisational outcomes. Two describe throughput and two describe stability, and they are most useful when read together.",
    groups: {
      throughput: {
        title: "Throughput",
        body: "How quickly a change can reach the people who use it.",
      },
      stability: {
        title: "Stability",
        body: "How often a change causes harm, and how quickly the team recovers.",
      },
    },
    measureLabels: {
      measures: "What we measure",
      why: "Why it matters",
      improve: "How to improve it",
    },
    measures: [
      {
        key: "frequency",
        group: "throughput",
        name: "Deployment frequency",
        question: "How often do we ship to production?",
        measures: "Successful runs of the deploy workflow on the deploy branch, counted per week.",
        why: "Frequent deploys mean each one carries less, so each is less risky and far easier to understand when something does go wrong.",
        improve:
          "Automate the path to production, keep the main branch releasable and hide unfinished work behind flags rather than on long-lived branches.",
      },
      {
        key: "lead",
        group: "throughput",
        name: "Lead time for changes",
        question: "How long does a change wait before it is live?",
        measures:
          "The median time from the first commit of a pull request to the end of the first successful deploy after it merged.",
        why: "Short lead time means fast feedback, because the sooner a change is in front of users the sooner the team learns whether it was the right change.",
        improve:
          "Open smaller pull requests, review within hours rather than days and remove manual gates that add waiting without adding safety.",
      },
      {
        key: "failure",
        group: "stability",
        name: "Change failure rate",
        question: "How often does a deploy go wrong?",
        measures: "Failed deploy runs as a share of all counted deploy runs.",
        why: "It keeps speed honest, since shipping faster only helps when the changes that are shipped still work.",
        improve:
          "Run meaningful tests on every change, review for behaviour rather than style and keep each deploy small enough to reason about.",
      },
      {
        key: "restore",
        group: "stability",
        name: "Time to restore",
        question: "When something breaks, how quickly do we recover?",
        measures: "The median time from the first failed deploy in a streak to the next successful one.",
        why: "Failure is unavoidable in any system that changes, so the ability to recover quickly matters more than the pretence of never failing.",
        improve:
          "Make rollback a single, rehearsed step, keep deploys small so the cause is obvious and fix forward only when that is genuinely quicker.",
      },
    ],

    flowTitle: "Where the time goes",
    flowLede:
      "Lead time is the sum of several waits. The dashboard splits it into the stages below, because the longest stage is usually a queue rather than work, and a queue is something a team can shorten by agreement.",
    flowDiagram:
      "An illustrative split of lead time into coding, waiting for review, in review, to merge and to deploy, where waiting for review is the longest stage.",
    flowIllustrative: "Illustrative proportions, not your data.",
    cycleTime: "Cycle time",
    leadTime: "Lead time",
    stages: [
      { key: "coding", name: "Coding", detail: "First commit to the pull request being opened." },
      { key: "waiting", name: "Waiting for review", detail: "Ready for review to the first review by someone else." },
      { key: "review", name: "In review", detail: "First review to approval." },
      { key: "merge", name: "To merge", detail: "Approval to the merge itself." },
      { key: "deploy", name: "To deploy", detail: "Merge to the end of the first successful deploy." },
    ],
    flowInsight:
      "In most teams the waiting stages are longer than the working ones. Reviewing a colleague's pull request before starting new work is often the quickest way to improve lead time for everyone.",

    bandsTitle: "Reading the bands",
    bandsLede:
      "Each measure is placed in one of four bands so a figure can be read at a glance. A band is always shown with its name as well as its colour, and it describes a team's system of work, never an individual.",
    bandsCaption: "The thresholds this dashboard uses for each DORA band, taken from the DORA 2023 profile.",
    bandsProfile:
      "These bands come from the DORA 2023 profile, which follows the clusters in the 2023 Accelerate State of DevOps Report. Every grade in the dashboard names the profile it used.",
    bandsSource: "Read the 2023 Accelerate State of DevOps Report",
    bandsSourceHref: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf",
    bandsMeasure: "Measure",
    bandRows: [
      {
        name: "Deployment frequency",
        elite: "7 or more a week",
        high: "1 or more a week",
        medium: "1 or more every four weeks",
        low: "Less often",
      },
      { name: "Lead time for changes", elite: "Under a day", high: "Under a week", medium: "Under a month", low: "Longer" },
      { name: "Change failure rate", elite: "5% or less", high: "10% or less", medium: "15% or less", low: "More" },
      { name: "Time to restore", elite: "Under an hour", high: "Under a day", medium: "Under a week", low: "Longer" },
    ],

    beckEyebrow: "Code quality",
    beckTitle: "Kent Beck's four rules of simple design",
    beckLede:
      "Delivery measures describe how fast change flows, but whether it can keep flowing depends on the code it flows through. Kent Beck's rules of simple design, summarised by Martin Fowler, give a short and practical definition of code that stays easy to change. The rules are given in priority order, so the first outweighs the others.",
    beckSource: "Read Beck Design Rules by Martin Fowler",
    beckMeasured: "What the dashboard measures",
    rules: [
      {
        name: "Passes the tests",
        body: "The software does what it is meant to do, and there are tests that prove it. Everything else rests on this rule, because without tests nobody can safely change the code in order to improve it.",
        measured:
          "Test ratio, the share of pull requests that include tests, whether CI runs the tests and whether a coverage floor is set.",
      },
      {
        name: "Reveals intention",
        body: "A reader can see what the code is for without tracing every path through it. Clear names and small, focused functions let the next person change the code with confidence.",
        measured: "Cyclomatic complexity per function, and the share of code that sits in heavily branching functions.",
      },
      {
        name: "No duplication",
        body: "Each piece of knowledge lives in one place, so a change is made once rather than hunted down in several. Removing duplication often reveals the abstraction that the design was missing.",
        measured:
          "Not measured directly. Duplication tends to surface as larger pull requests and recurring hotspots, and is best caught in review.",
      },
      {
        name: "Fewest elements",
        body: "Anything that does not serve the first three rules is removed. Speculative abstractions, unused options and layers added for a future that never arrives all make the code harder to read.",
        measured: "Long functions and functions with many parameters, which usually signal a function doing more than one job.",
      },
    ],

    loopTitle: "Why code quality shows up in the four keys",
    loopLede:
      "Code health and delivery performance are two views of the same system. The same forces that make code hard to read also make changes large, reviews slow and deploys risky, and each circle below tends to reinforce itself.",
    loops: {
      vicious: {
        title: "The vicious circle",
        steps: [
          "Complex, untested code",
          "Larger and riskier changes",
          "Slower reviews and more failed deploys",
          "Pressure to cut corners",
        ],
      },
      virtuous: {
        title: "The virtuous circle",
        steps: [
          "Simple, tested code",
          "Small and safe changes",
          "Quick reviews and quiet deploys",
          "Time to keep improving the code",
        ],
      },
    },

    practiceTitle: "Using these numbers well",
    practices: [
      {
        title: "Measure the system, not the person",
        body: "The figures describe how a team's way of working performs. Per-person views are off by default, because ranking people by throughput rewards work that looks small and safe and overlooks those who review, mentor and fix.",
      },
      {
        title: "Follow the trend, not the target",
        body: "When a measure becomes a target it stops being a good measure. Look for the direction of travel over several weeks, and ask what changed whenever a line moves.",
      },
      {
        title: "Read the four together",
        body: "Deploying more often while failures climb is not progress. A healthy improvement moves throughput and stability in the same direction.",
      },
      {
        title: "Compare like with like",
        body: "Teams differ in size, age and domain, so use the fairness options on the comparison view before drawing conclusions across repositories.",
      },
    ],

    readingTitle: "Further reading",
    reading: [
      {
        href: "https://martinfowler.com/bliki/BeckDesignRules.html",
        title: "Beck Design Rules",
        by: "Martin Fowler, on the four rules of simple design and why their order matters.",
      },
      {
        href: "https://martinfowler.com/articles/is-quality-worth-cost.html",
        title: "Is High Quality Software Worth the Cost?",
        by: "Martin Fowler, on why internal quality makes software cheaper to build, not dearer.",
      },
      {
        href: "https://dora.dev/",
        title: "DORA",
        by: "The research programme behind the four keys, with its reports, guides and quick check.",
      },
      {
        href: "https://itrevolution.com/product/accelerate/",
        title: "Accelerate",
        by: "Nicole Forsgren, Jez Humble and Gene Kim, on the science behind high-performing technology organisations.",
      },
    ],

    jira: {
      eyebrow: "Delivery from Jira",
      title: "Seeing the whole journey, from idea to production",
      lede: "Pull requests show how code moves, but they do not show how work moves. Measuring delivery from the tracker as well shows how work flows from idea to production, where it waits on the way, and whether the board tells the truth about what is happening. Each figure describes the team's system of work, and the dashboard hides people by default.",
      measures: [
        {
          name: "Issue cycle time",
          reveals:
            "How long finished work took from the day it was started to the day it was done, which shows how quickly a team can complete what it begins.",
        },
        {
          name: "Issue lead time",
          reveals:
            "How long a request waited from the day it was raised to the day it was done, which includes the time it sat before anyone began.",
        },
        {
          name: "Throughput",
          reveals:
            "How many items finish each week and of which type, which shows the steady rhythm of the team and any shift towards bugs or tasks.",
        },
        {
          name: "Work in progress and ageing work",
          reveals:
            "How much is under way at once and which items have been open longest, because work that is started but not finished is the usual place for delay to build up.",
        },
        {
          name: "Time per column",
          reveals:
            "Where finished items spent their time on the board, so a queue such as waiting for review can be seen and shortened by agreement.",
        },
        {
          name: "Flow efficiency",
          reveals:
            "How much of the time between started and done was spent actively worked rather than waiting, which is often lower than a team expects.",
        },
        {
          name: "Issue to first pull request and to production",
          reveals:
            "How long it takes for an idea to become code and then to reach users, measured only for items linked to a pull request.",
        },
        {
          name: "Hygiene checks",
          reveals:
            "Whether the board matches reality, for example whether pull requests name their issue and whether cards move when work starts. They make the other figures trustworthy, and they are prompts to tidy rather than a score.",
        },
      ],
      people:
        "People are hidden by default. A Show people switch on the page groups the hygiene lists by assignee name, and names never appear in charts or tiles.",
    },

    ctaTitle: "Put it into practice",
    ctaBody:
      "Add a repository to see its four keys, its flow and its code health side by side, then choose one small change to try this week.",

    pdfSubject: "Delivery metrics",
    pdfLabel: "why it matters",
    linksTitle: "Links in this document",
    linksLede: "Each link in the text above with its full address, so a printed copy can be followed too.",
  },

  reviewQueue: {
    title: "Review queue",
    lede: "Open pull requests across your repositories, grouped by who has to act next. Waiting time counts weekdays only.",
    updated: (time: string) => `Updated ${time}`,
    refresh: "Refresh",
    refreshing: "Refreshing",
    refreshFailed: "The queue could not be refreshed. The figures shown are the last ones received.",
    copySummary: "Copy summary",
    /** Joins the title in the suggested PDF file name, as in review-queue-report-2026-09-30. */
    pdfLabel: "report",
    copied: "Summary copied to the clipboard",
    copyFailed: "The summary could not be copied",
    loading: "Loading the review queue",
    empty: "No open pull requests",
    emptyBody: "Nothing is waiting for review in the repositories being tracked.",
    noMatches: "No pull requests match these filters",
    readErrorTitle: (repo: string) => `Could not read ${repo}`,
    partialTitle: (repo: string) => `Only part of ${repo} was read`,
    readErrorBody: "Its pull requests are missing from this page. The other repositories are complete.",

    controls: {
      label: "Filters",
      repos: "Repositories",
      waitingOn: "Waiting on",
      anyone: "Anyone",
      search: "Search",
      searchPlaceholder: "Title, repository, number or ticket",
      drafts: "Show drafts and on hold",
      draftsHint: "Adds a column for pull requests that are not ready for review.",
      bots: "Show bot pull requests",
      botsHint: "Dependency updates and other automated changes.",
      names: "Show names",
      namesHint: "Names are hidden by default. Turn this on to see authors and requested reviewers.",
    },

    tiles: {
      waiting: "Waiting for review",
      waitingHint: (repos: number, held: number) =>
        `Across ${repos} ${repos === 1 ? "repository" : "repositories"}, with ${held} held back by failing checks`,
      pastDay: "Waiting over 24h",
      pastDayHint: (longest: string) => `Longest wait ${longest}`,
      noReviewer: "No reviewer requested",
      noReviewerHint: (oldest: string) => `Oldest has waited ${oldest}`,
      stale: "Stale, 5 weekdays or more",
      staleHint: (longest: string) => `Longest wait ${longest}`,
      fastLane: "Fast lane",
      fastLaneHint: "Waiting and under 400 changed lines across fewer than 10 files",
      idle: "Idle for 14 days or more",
      idleHint: "Open pull requests nobody has touched for two weeks",
      none: "None waiting",
    },

    attention: {
      title: "Needs attention",
      subtitle: "Stale pull requests and overdue pull requests with no reviewer, most urgent first.",
      empty: "Nothing needs urgent attention",
    },

    flag: {
      stale: "Stale",
      overdue: "Over 24h",
      noReviewer: "no reviewer",
      awaitingReview: "awaiting review",
    },

    wait: {
      underHour: "under 1h",
      hours: (n: number) => `${n}h`,
      weekdays: (n: number) => (n === 1 ? "1 weekday" : `${n} weekdays`),
    },

    features: {
      title: "Work split across pull requests",
      subtitle: "Pull requests that appear to belong to one piece of work, joined by a shared ticket, branch or stack.",
      evidence: {
        ticket: "Shared ticket",
        related: "Related line",
        branch: "Shared branch",
        stack: "Stacked",
      },
      members: (n: number) => `${n} pull requests`,
      longest: (wait: string) => `Longest wait ${wait}`,
    },

    repos: {
      title: "Waiting time by repository",
      subtitle: "How long each repository's waiting pull requests have been open, split into bands.",
      legendLabel: "Waiting time bands",
      weekendNote: "Waiting time leaves out weekends",
      cardSubtitle: (open: number) => `${open} open`,
      noWaiting: "Nothing waiting for review",
      segmentTitle: (band: string, count: number) => `${band}, ${count}`,
      barLabel: (repo: string) => `Waiting pull requests in ${repo} by waiting time`,
      tableBand: "Band",
      tableCount: "Waiting pull requests",
      lanesLine: (parts: string) => `Open now, ${parts}`,
    },

    bands: {
      stale: "Stale, 5 weekdays or more",
      overdue: "Over 24h",
      ageing: "4 to 24h",
      fresh: "Under 4h",
    },

    lanes: {
      no_reviewer: { title: "No reviewer", hint: "Nobody has been asked to review yet." },
      awaiting_review: { title: "Awaiting review", hint: "A reviewer has been asked and has not finished." },
      with_author: { title: "With the author", hint: "Failing checks or changes requested. The author acts next." },
      approved: { title: "Approved", hint: "Ready to merge." },
      held: { title: "Drafts and on hold", hint: "Not ready for review." },
      empty: "Nothing here",
      boardLabel: "Review queue lanes",
    },

    card: {
      opensInNewTab: "opens in a new tab",
      by: (author: string) => `by ${author}`,
      waitingSince: (wait: string) => `Waiting ${wait}`,
      waitingOn: (names: string) => `Waiting on ${names}`,
      reviewersRequested: (n: number) => `${n} ${n === 1 ? "reviewer" : "reviewers"} requested`,
      lines: (additions: number, deletions: number) => `+${additions} -${deletions}`,
      files: (files: number) => `${files} ${files === 1 ? "file" : "files"}`,
      checks: {
        passing: "Checks passing",
        failing: "Checks failing",
        pending: "Checks running",
        none: "No checks",
      },
      draft: "Draft",
      onHold: "On hold",
      idle: (days: number) => `Idle ${days} days`,
      authorAvatar: (login: string) => login,
    },

    summary: {
      heading: (count: number, repos: number) =>
        `Review queue, ${count} waiting across ${repos} ${repos === 1 ? "repository" : "repositories"}`,
      stale: (count: number) => `${count} stale`,
      pastDay: (count: number) => `${count} over 24h`,
      noReviewer: (count: number) => `${count} with no reviewer`,
      attention: "Needs attention",
      none: "Nothing needs urgent attention.",
      waitingOn: (names: string) => `waiting on ${names}`,
      by: (author: string) => `by ${author}`,
      footer: "Waiting time counts weekdays only.",
    },
  },

  security: {
    severity: { critical: "Critical", high: "High", medium: "Medium", low: "Low", unknown: "Not rated" },
    severityTile: {
      critical: "Critical alerts",
      high: "High severity alerts",
      medium: "Medium severity alerts",
      low: "Low severity alerts",
      unknown: "Alerts without a rating",
    },
    severityExplain: {
      critical: (days: number) =>
        `Critical means someone could take over the system or read private data with little effort. Fix within ${days} days.`,
      high: (days: number) =>
        `High means an attacker would need some conditions to be right, but the damage could be serious. Fix within ${days} days.`,
      medium: (days: number) =>
        `Medium means the problem is real but harder to use or limited in what it can do. Fix within ${days} days.`,
      low: (days: number) =>
        `Low means little can go wrong on its own, although it can help an attacker who has found something else. Fix within ${days} days.`,
      unknown: (days: number) =>
        `Not rated means the source published no severity, so it is treated like medium. Fix within ${days} days.`,
    },
    effort: { minutes: "A few minutes", hour: "Under an hour", code: "Needs a code change" },
    tags: {
      likelyExploited: "Likely to be exploited soon",
      pastFix: "Past its fix-by date",
      withinFix: "Within its fix-by date",
      setsGrade: "Sets the grade",
      setsPartGrade: "Limits its part only",
      holdsGrade: (band: string) => `Holds the grade at ${band}`,
      advice: "Advice only",
      countsTowardsGrade: "Counts towards the grade",
      selfMerged: "Merged by its own author",
    },
    likelyExploitedWhy: (share: string) =>
      `The exploit prediction score (EPSS) estimates how likely it is that a flaw will be used in real attacks within the next month. At ${share} or more we say it is likely to be exploited soon, which puts it ahead of other alerts of the same severity but never changes its severity or your grade.`,
    likelyExploitedTitle:
      "Its exploit prediction score (EPSS) says this flaw is likely to be used in real attacks soon. It never changes the severity or the grade.",
    cvss: (score: number) => `Score ${score.toFixed(1)} out of 10`,
    fixed: "Fixed",
    sourceNames: {
      dependabot: "Dependabot alerts",
      code_scanning: "Code scanning",
      secret_scanning: "Secret scanning",
      osv: "OSV.dev lookup",
    },
    parts: {
      vulnerabilities: "Known vulnerabilities and secrets",
      supplyChain: "Workflows and supply chain",
      changeControl: "Branch protection",
    },
    partDefinitions: {
      vulnerabilities: "Open alerts for your dependencies, your code and exposed secrets, judged by how long each has waited.",
      supplyChain: "How safely your automated workflows, actions and files are set up.",
      changeControl: "Whether the deploy branch is protected from direct pushes, history rewrites and deletion.",
    },
    notMeasured: "Not measured",
    unmeasured: {
      dependencies: "Dependency alerts could not be read, so known vulnerabilities in your packages are not part of the grade.",
      code: "Code scanning alerts could not be read, so they are not part of the grade.",
      secrets: "Secret scanning alerts could not be read, so exposed secrets are not part of the grade.",
      supplyChain: "Workflow and dependency files have not been read, so the supply chain checks are not part of the grade.",
      changeControl: "The branch settings could not be read, so branch protection is not part of the grade.",
    },

    list: {
      title: "Security",
      lede: "A grade and a short list of things to fix for every repository, worst first, from GitHub's own alerts, the workflow files in each repository and how the deploy branch is protected. Choose a repository to see what is wrong, why it matters and how to fix it.",
      reportLabel: "security summary",
      reportSubject: "all repositories",
      loading: "Loading security summaries",
      emptyTitle: "No repository has been added yet",
      emptyBody: "Add a repository and let its first crawl finish, and its security grade will appear here.",
      toRepos: "Go to repositories",
      tiles: {
        critical: "Critical alerts",
        criticalHint: "Open critical alerts across the repositories that have been read.",
        readFrom: (read: number, total: number) =>
          `From ${read} of ${total} ${total === 1 ? "repository" : "repositories"} read.`,
        pastFix: "Past their fix-by date",
        pastFixHint: (count: number) =>
          count > 0
            ? "Open alerts that have waited longer than their fix-by date allows, so these are the ones to look at first."
            : "No open alert has waited longer than its fix-by date allows in the repositories that have been read.",
        notGraded: "Not graded yet",
        notGradedHint: "Repositories where nothing could be measured so far.",
      },
      gradedTitle: "Graded, worst first",
      gradedLede: "The repositories with a grade, with the ones that need the most attention at the top.",
      notGradedTitle: "Not graded yet",
      notGradedLede: "These repositories have no grade yet, and each one says why.",
      noneGraded: "No repository has a grade yet.",
      open: (name: string) => `Open the security report for ${name}`,
      facts: {
        grade: "Grade",
        notGraded: "Not graded",
        open: "Open alerts",
        pastFix: "Past fix-by date",
        actions: "Things that move the grade",
        read: "Last read",
        neverRead: "Not read yet",
        scorecard: "OpenSSF Scorecard",
        scorecardValue: (score: number) => `${score.toFixed(1)} out of 10`,
      },
      noOpen: "No open alerts",
      notReadRow: "Not read yet",
      notUsedRow: "Not measured",
      startWith: "Start with",
      gradeMissing: {
        not_crawled: "This repository has not been crawled yet, so there is nothing to grade.",
        nothing_measured: "Nothing could be measured yet. Open the report to see which sources could not be read.",
      },
      failedTitle: "Some alerts could not be read",
      failedBody: (names: string) =>
        `The last attempt to read alerts failed for ${names}. The figures below use the earlier read, which may be out of date.`,
      osvOff:
        "Dependencies are not being looked up in OSV.dev, which is an optional extra that covers repositories where Dependabot alerts are off. Set OSV_LOOKUP=on in the environment file of the dashboard to switch it on.",
      coverage: {
        none: "Nothing has been read yet.",
        noneUsable: "No alert source could be used, so open the repository to see why.",
        read: (read: string) => `Read ${read}.`,
        readAndMissing: (read: string, missing: string) => `Read ${read}. Not read ${missing}.`,
        sources: {
          dependabot: "Dependabot alerts",
          code_scanning: "code scanning",
          secret_scanning: "secret scanning",
          osv: "the OSV.dev lookup",
        },
        supplyChain: "workflow and dependency files",
      },
    },

    page: {
      title: "Security",
      lede: "What is wrong, why it matters and how to fix it, written for people who do not think about security every day. The grade and the open alerts describe the repository as it is now, and the date range only changes the charts, the time to fix and the dependency update counts. The PDF report shows the page as it is on screen, so open the explanations you want in it, and use the buttons to show the longer lists, before you download it.",
      backToRepo: "Back to the repository",
      reportLabel: "security report",
      loading: "Loading the security report",
      notFoundTitle: "That repository could not be found",
      notFoundBody: "Check the address, or choose a repository from the list.",
      toList: "Back to security",
      invalidAddress: "This address does not name a repository.",
      alertsRead: (when: string) => `Alerts read on ${when}`,
      alertsNotRead: "Alerts have not been read yet",
      alertsStale: (when: string) => `Some alerts are older than this, and the oldest was read on ${when}`,
      gradeLine: "Security grade",
      gradeNone: "No security grade yet",
      rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
      crawlInProgress: "A crawl is in progress, so these figures may still change.",
      partlyRead: {
        title: "Part of this page could not be read",
        body: (names: string) =>
          `The dashboard could not read ${names}, so the grade leaves them out and the page may look better than the whole picture.`,
        link: "See how each source is read",
      },
    },

    start: {
      title: "Start here",
      lede: "The quickest way to a safer repository.",
      gradeIs: "Your security grade is",
      raise: (count: number, from: string, to: string) =>
        count === 1
          ? `Do this one thing to move from ${from} to ${to}.`
          : `Do these ${count} things to move from ${from} to ${to}.`,
      nothingToRaise: (band: string) => `Nothing found so far stops this repository from holding the ${band} band.`,
      good: "Nothing that needs fixing was found in what the dashboard could read, and that is a good place to be. Keep Dependabot and your branch rules switched on so that it stays that way.",
      more: (count: number) => `and ${count} more.`,
      seeAll: "See everything to fix",
      missing: {
        not_crawled: "This repository has not been crawled yet. Crawl it and the first grade will appear here.",
        nothing_measured:
          "Nothing could be measured yet. The sources section at the end of this page explains what was not read and how to switch each source on.",
      },
      advice: (count: number) =>
        count === 1
          ? "There is also one piece of advice that does not change the grade."
          : `There are also ${count} pieces of advice that do not change the grade.`,
    },

    grade: {
      title: "Security grade",
      definition: "Security is graded in four bands, the lowest of the three parts below.",
      lowestPart: (part: string, limit: string) => `The lowest part is ${part}, which is held back because ${limit}`,
      allPass: "Nothing found so far holds the grade back.",
      partsTitle: "The three parts",
      limitedBy: (limit: string) => `Held back because ${limit}`,
      nothingLimits: "Nothing holds this part back.",
      goodTitle: "What is going well",
      goodEmpty: "Nothing was measured as good yet.",
      improveTitle: "What to improve",
      improveHint:
        "Starting with the check that sets the grade. A check that only limits its own part, not the overall grade, is marked as such.",
      improveEmpty: "Nothing needs improving in what was measured.",
      unmeasuredTitle: "What the grade does not cover",
    },

    checks: {
      secretExposed: {
        good: "No secrets were found that are active or have been made public.",
        bad: (count: number) =>
          `${count} exposed ${count === 1 ? "secret is" : "secrets are"} still active or has been made public.`,
      },
      criticalPastFix: {
        good: (days: number) => `No critical alert has waited longer than its ${days} day fix-by date.`,
        bad: (count: number, days: number, oldest: number | null) =>
          `${count} critical ${count === 1 ? "alert has" : "alerts have"} waited longer than the ${days} day fix-by date${oldest === null ? "" : `, the oldest for ${oldest} days`}.`,
      },
      criticalOpen: {
        good: "No critical alerts are open.",
        bad: (count: number, days: number) =>
          `${count} critical ${count === 1 ? "alert is" : "alerts are"} open, still inside the ${days} day fix-by date.`,
      },
      highPastFix: {
        good: (days: number) => `No high severity alert has waited longer than its ${days} day fix-by date.`,
        bad: (count: number, days: number, oldest: number | null) =>
          `${count} high severity ${count === 1 ? "alert has" : "alerts have"} waited longer than the ${days} day fix-by date${oldest === null ? "" : `, the oldest for ${oldest} days`}.`,
      },
      dependenciesUnwatched: {
        good: "Something is watching your dependencies for known vulnerabilities.",
        bad: "Nothing is watching your dependencies for known vulnerabilities, because Dependabot alerts are switched off.",
      },
      highOpen: {
        good: "No high severity alerts are open.",
        bad: (count: number, days: number) =>
          `${count} high severity ${count === 1 ? "alert is" : "alerts are"} open, still inside the ${days} day fix-by date.`,
      },
      mediumPastFix: {
        good: (days: number) => `No medium or unrated alert has waited longer than its ${days} day fix-by date.`,
        bad: (count: number, days: number, oldest: number | null) =>
          `${count} medium or unrated ${count === 1 ? "alert has" : "alerts have"} waited longer than the ${days} day fix-by date${oldest === null ? "" : `, the oldest for ${oldest} days`}.`,
      },
      prHeadCheckout: {
        good: "No workflow runs a pull request's own code while holding secrets.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "workflow runs" : "workflows run"} a pull request's own code while holding secrets.`,
      },
      scriptInjection: {
        good: "No workflow pastes text written by outsiders into a shell command.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "workflow pastes" : "workflows paste"} text written by outsiders into a shell command.`,
      },
      selfHostedPublic: {
        good: "No public repository runs pull requests on a self hosted machine.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "workflow runs" : "workflows run"} pull requests from a public repository on a self hosted machine.`,
      },
      unpinnedActions: {
        good: "Every action from another organisation is pinned to a commit.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "action from another organisation is" : "actions from other organisations are"} not pinned to a commit.`,
      },
      workflowPermissions: {
        good: "Every workflow limits what its automatic token can do.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "workflow does" : "workflows do"} not limit what ${count === 1 ? "its" : "their"} automatic token can do.`,
      },
      unsecureCommands: {
        good: "No workflow switches back on the deprecated unsecure commands.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "workflow switches" : "workflows switch"} back on the deprecated unsecure commands.`,
      },
      keyFiles: {
        good: "No private key or environment file is stored in the repository.",
        bad: (count: number) =>
          `${count} ${count === 1 ? "file that looks like a private key or an environment file is" : "files that look like private keys or environment files are"} stored in the repository.`,
      },
      branchUnprotected: {
        good: "The deploy branch is protected by rules.",
        bad: "The deploy branch has no protection rules.",
      },
      forcePushAllowed: {
        good: "Force pushes to the deploy branch are blocked.",
        bad: "Force pushes to the deploy branch are allowed.",
      },
    },

    fix: FIX,
    dependabotAlerts: {
      what: (file: string) =>
        `${updater(file).subject} set up in ${file} and ${updater(file).keeps} your packages current, but Dependabot alerts, which warn you when a package you use has a known vulnerability, are switched off.`,
      source: (file: string) =>
        `${updater(file).subject} set up in ${file} and ${updater(file).keeps} packages current, but Dependabot alerts, which warn you when a package you use has a known vulnerability, are switched off. Switch them on under the repository's Settings, then Advanced Security.`,
      why: "Version updates raise pull requests so that packages stay recent, but they do not tell you when a package you use has a published flaw. Alerts do, and they work on the versions you have today, so the two features complement each other.",
      steps: [
        "Open the repository's Settings and choose Advanced Security in the Security section of the sidebar.",
        "Switch on Dependabot alerts, and Dependabot security updates as well if you want fixes raised as pull requests straight away.",
        "Keep your existing configuration file, because it carries on raising the regular version updates.",
      ],
    },
    securityUpdates: {
      /** Says what is already on, so the sentence never seems to contradict GitHub's Security tab. */
      what: ({ file, alertsOn }: { file: string | null; alertsOn: boolean }) => {
        const on = [
          alertsOn ? "Dependabot alerts are on" : null,
          file ? `${updater(file).subject} set up in ${file}` : null,
        ].filter((part): part is string => part !== null);
        const lead = on.length > 0 ? `${on.join(" and ")}, but ` : "";
        return `${lead}Dependabot security updates are a separate switch and are off, so nobody raises the fix when an alert appears.`;
      },
      why: "Dependabot has three separate switches. Alerts tell you that a package you use has a known flaw, version updates keep your packages recent on a schedule, and security updates raise a pull request with the fix as soon as an alert appears. GitHub's Security tab lists only the alerts, so it can say Enabled while security updates are still off.",
      steps: [
        "Open the repository's Settings and choose Advanced Security in the Security section of the sidebar. The Security tab does not show this switch.",
        "In the Dependabot part of that page, find Dependabot security updates and select Enable. No file in the repository can switch it on, so a configuration file does not change it.",
        "Crawl again so that this page sees the change, then review and merge the pull requests that Dependabot opens.",
      ],
    },
    notRead: {
      title: "Security has not been read for this repository yet",
      body: "Security alerts are read during a crawl, and this repository has not been crawled since security was added. The figures that would normally appear here are left out, because zeros would look like an all clear when nothing has been measured yet.",
      crawl: "Crawl now",
      crawling: "Crawling now, this page updates when it finishes",
      failed: "The crawl could not be started. Try again in a moment.",
      refused: {
        title: "No alerts could be used for this repository",
        body: "The dashboard asked GitHub, but none of the alert sources could be used, so the figures that would normally appear here are left out, because zeros would look like an all clear when nothing has been measured. Each source says below what happened and what to do.",
        retry: "Where a source failed, crawling again tries it once more.",
      },
    },
    fixTitle: "How to fix",
    why: "Why it matters",
    steps: "What to do",
    learnMore: "Learn more on GitHub",
    affected: "Where to look",
    printMore: (count: number) => `and ${count} more, listed on the security page`,

    actions: {
      title: "What to fix first",
      lede: "The things to do, with the ones that lift the grade first. Each one explains what is wrong, why it matters and how to fix it, and you can open the explanation with the button beside it.",
      none: "Nothing needs fixing in what the dashboard could read.",
      counting: (count: number) => (count === 1 ? "One thing to fix" : `${count} things to fix`),
    },

    snippetNotes: {
      semgrep:
        "Semgrep Community Edition runs inside your own pipeline, so it needs no GitHub Code Security plan. The auto setting fetches its rules from the Semgrep registry and shares usage figures with Semgrep, so check that this suits a private repository, or choose a rule set of your own. Findings fail the run, and they appear in the job log, not on GitHub's Security tab.",
      codeql:
        "CodeQL uploads its results to GitHub code scanning. That is free on a public repository, but on a private repository it needs GitHub Code Security.",
      dependencyReview:
        "Dependency review is free on public repositories. On a private repository it needs GitHub Code Security, and the action fails without it.",
    },

    snippets: {
      upgrade: "Upgrade command",
      upgradeInPlace: "Try updating it in place first",
      npmOverrides: "Force the fixed version with an override in package.json, then run npm install",
      yarnResolutions: "Force the fixed version with a resolution in package.json, then run yarn install",
      pnpmOverrides: "Force the fixed version with an override in package.json, then run pnpm install",
      permissions: "Limit the token to reading",
      pinnedUses: "Pin an action to a commit",
      shaLookup: "Look up the commit for a version",
      scriptInjection: "Pass the value through a variable",
      pullRequestTrigger: "Run on pull_request, which is safe for code from forks",
      pullRequestTarget: "If you really need pull_request_target, never run the pull request's code in it",
      dependabot: "Dependabot configuration for this repository",
      securityPolicy: "A starting SECURITY.md",
      gitignore: "Lines for .gitignore",
      untrack: "Stop tracking the file, which stays in the history",
      persistCredentials: "Do not keep the token on disk",
      nonRoot: "Run as an ordinary user",
      digest: "Pin a base image to a digest",
      remoteAdd: "Download and check, instead of ADD",
      curlPipe: "Download, check, then run",
      secretsInherit: "Pass only the secrets that are needed",
      dependencyReview: "A dependency review workflow",
      secretScanner: "A secret scanning workflow",
      codeql: "A CodeQL workflow that uploads its results to GitHub code scanning",
      semgrep: "A Semgrep workflow that uploads nothing to GitHub",
      selfHosted: "Run on a GitHub hosted machine",
      analysisOn: "Switch code analysis on",
    },
    upgradeText: {
      folder: (name: string, version: string) =>
        `Upgrade ${name} to ${version} with your package manager, in the folder that holds the file named in the table.`,
      yarn: (name: string, version: string) =>
        `Change ${name} to ${version} in package.json, then run yarn install. The command differs between Yarn versions, so this works for both.`,
      requirements: (name: string, version: string, file: string) =>
        `Set ${name}==${version} in ${file}, then install the requirements again.`,
      build: (name: string, version: string) =>
        `Raise ${name} to ${version} in your build file, which is pom.xml for Maven or build.gradle for Gradle, then build again.`,
      pip: (name: string, version: string) =>
        `${name} comes in through another package. Update the package that depends on it, or add ${name}==${version} to your requirements so that the fixed version is installed.`,
      transitive: (name: string, version: string, mechanism: string) =>
        `${name} comes in through another package, so installing it yourself would add a dependency you do not otherwise use. Update the package that depends on it, and if that is not enough, force version ${version} with ${mechanism}.`,
      mixed: (name: string, version: string, mechanism: string) =>
        `${name} is a direct dependency in some places and comes in through other packages in others. Use version ${version} where you depend on it directly, and force the same version everywhere else with ${mechanism}.`,
      mechanism: {
        npm: "an override in package.json",
        yarn: "a resolution in package.json",
        pnpm: "an override under pnpm in package.json",
      },
      notes: {
        poetryDev: "If it is a development dependency, add --group dev to the command.",
        poetryUpdate:
          "This stays within the version ranges that the packages depending on it allow. If it will not reach the fixed version, update the package that depends on it.",
        pipenvDev: "If it is a development dependency, add --dev to the command.",
        cargo: "If Cargo.toml asks for an older range, raise it there first, because the command cannot go outside it.",
        bundler: "If the Gemfile pins an older version, raise that constraint first, because the command cannot go outside it.",
        composer: "If composer.json does not allow that version, raise the constraint there first.",
        nugetTransitive:
          "This adds a direct reference to the fixed version, which takes the place of the version that the other package brings.",
      },
    },
    copyButton: "Copy",
    copyLabel: (label: string) => `Copy ${label}`,
    copied: "Copied",
    copyFailed: "The text could not be copied. Select it above and copy it yourself.",
    copyUnavailable: "This browser does not let the page copy text. Select it above and copy it yourself.",
    insteadOf: "Instead of this",
    settingsLink: "Open the repository's Advanced Security settings",
    branchSettingsLink: "Open the repository's branch settings",

    open: {
      title: "Open alerts",
      lede: "Alerts that are still open now, from every source that was read, with how long each severity is allowed to wait.",
      pastFix: (count: number) => `${count} past the fix-by date`,
      withinFix: "None past the fix-by date",
      none: "No open alerts in the sources that were read. Well done.",
      noneButUnread: "No open alerts were found, although some sources could not be read.",
      likelyTitle: "Likely to be exploited soon",
      likelyHint: (share: string) => `Open alerts whose exploit prediction score is ${share} or more.`,
      total: (count: number, sources: string) =>
        sources ? `${count} open in all, made up of ${sources}.` : `${count} open in all.`,
      fromSource: (count: number, name: string) => `${count} from ${name}`,
    },

    weekly: {
      title: "Open alerts by week",
      chartTitle: "Open alerts at the end of each week",
      subtitle: "How many alerts were open at the end of each week, by severity.",
      table: "Open at the end of the week",
      total: "Total",
      partWeek: {
        current: (week: string) =>
          `The week starting ${week} is not over yet, so its figures are marked so far. Its bars are drawn lighter inside an outline, because the week has not finished.`,
        cut: (week: string, day: string) =>
          `The range ends on ${day}, part way through the week starting ${week}, so that week's figures stop there. Its bars are drawn lighter inside an outline.`,
      },
      activity: "Opened, fixed and dismissed",
    },

    weaknesses: {
      title: "What kind of problems",
      chartTitle: "Weaknesses behind your alerts",
      subtitle: "The kinds of weakness behind your alerts, by how many are open and how many were fixed in the date range.",
      lede: "Knowing the kind of problem tells you what habit to change, because a few kinds cause most alerts.",
      open: "Open",
      fixed: "Fixed in range",
      kind: "Kind of problem",
      id: "Weakness id",
      meaning: "What it means",
      none: "No alerts carry a weakness type yet.",
      unnamed: "No plain name yet",
    },
    cwe: {
      "CWE-79": {
        name: "Cross-site scripting",
        meaning:
          "A page shows text from a visitor as if it were part of the page, so that it can run scripts in other people's browsers.",
      },
      "CWE-89": {
        name: "SQL injection",
        meaning: "Text typed by a visitor ends up inside a database query and changes what the query does.",
      },
      "CWE-22": {
        name: "Path traversal",
        meaning: "A file name chosen by a visitor reaches outside the folder it should stay in and reads or writes other files.",
      },
      "CWE-78": {
        name: "Operating system command injection",
        meaning: "Text from outside is placed in a command that the server runs and changes what the command does.",
      },
      "CWE-94": { name: "Code injection", meaning: "Text from outside is run as code by the program." },
      "CWE-77": {
        name: "Command injection",
        meaning: "Text from outside is placed in a command and changes what the command does.",
      },
      "CWE-352": {
        name: "Cross-site request forgery",
        meaning: "Another website tricks a signed in person's browser into sending a request they did not mean to make.",
      },
      "CWE-798": {
        name: "Hard-coded credentials",
        meaning: "A password or key is written into the code, so everyone who can read the code has it.",
      },
      "CWE-400": {
        name: "Uncontrolled resource use",
        meaning: "A request can make the program use so much time or memory that it stops serving anyone else.",
      },
      "CWE-770": {
        name: "No limit on resources",
        meaning: "The program lets one caller take as much as they like of something that is limited.",
      },
      "CWE-1321": {
        name: "Prototype pollution",
        meaning:
          "An attacker changes the shared base object of a JavaScript program and so changes how all of its objects behave.",
      },
      "CWE-918": {
        name: "Server-side request forgery",
        meaning: "An attacker makes your server send requests to places that only the server can reach.",
      },
      "CWE-502": {
        name: "Unsafe deserialisation",
        meaning: "The program rebuilds objects from data that an attacker controls, which can run the attacker's code.",
      },
      "CWE-611": {
        name: "External entity expansion",
        meaning: "An XML file makes the parser read local files or contact other servers.",
      },
      "CWE-601": {
        name: "Open redirect",
        meaning: "A link on your site can be made to send visitors on to a site chosen by an attacker.",
      },
      "CWE-327": {
        name: "Weak cryptography",
        meaning: "An outdated or broken method is used to protect data, so the protection can be undone.",
      },
      "CWE-20": {
        name: "Improper input checking",
        meaning:
          "The program does not check that what it receives is what it expects, which opens the door to many other problems.",
      },
      "CWE-200": {
        name: "Exposure of sensitive information",
        meaning: "Information is shown to someone who should not be able to see it.",
      },
      "CWE-287": { name: "Improper authentication", meaning: "The program can be convinced that someone is who they are not." },
      "CWE-862": {
        name: "Missing authorisation",
        meaning: "The program does not check whether a signed in person is allowed to do what they ask.",
      },
      "CWE-863": {
        name: "Incorrect authorisation",
        meaning: "The program checks whether a person is allowed, but the check is wrong.",
      },
      "CWE-307": {
        name: "Too many sign in attempts allowed",
        meaning: "Nothing stops an attacker from guessing passwords again and again.",
      },
      "CWE-1333": {
        name: "Slow regular expression",
        meaning: "A pattern can be made to take a very long time on certain text, which stops the program serving others.",
      },
      "CWE-116": {
        name: "Improper escaping of output",
        meaning: "Text is not made safe before it is placed in another format, so it can change that format's meaning.",
      },
      "CWE-312": {
        name: "Sensitive data stored in plain text",
        meaning: "Passwords or personal data are stored without protection, so anyone who reaches the storage can read them.",
      },
      "CWE-319": {
        name: "Sensitive data sent in plain text",
        meaning: "Data travels without encryption, so anyone on the route can read it.",
      },
      "CWE-434": {
        name: "Unrestricted file upload",
        meaning: "People can upload files of a dangerous kind, which may then be run by the server.",
      },
      "CWE-532": {
        name: "Sensitive data in logs",
        meaning: "Passwords or personal data are written to log files that many people can read.",
      },
      "CWE-59": {
        name: "Unsafe link following",
        meaning: "The program follows a shortcut to a file that an attacker placed to reach something else.",
      },
      "CWE-285": {
        name: "Improper authorisation",
        meaning: "The program does not properly check what a person is allowed to do.",
      },
      "CWE-74": {
        name: "Injection",
        meaning:
          "Text from outside is placed into something the program builds for another system, such as a query or a command, and changes what that system does.",
      },
      "CWE-113": {
        name: "Header injection",
        meaning:
          "Text from outside is placed in a web response header with a line break, so an attacker can add headers or even a second response.",
      },
      "CWE-125": {
        name: "Read past the end of a buffer",
        meaning: "The program reads memory beyond the space it was given, which can leak other data or crash the program.",
      },
      "CWE-190": {
        name: "Integer overflow",
        meaning:
          "A number grows past the largest value its type can hold and wraps round, so later size or length checks give the wrong answer.",
      },
      "CWE-248": {
        name: "Uncaught exception",
        meaning: "A failure is not handled anywhere, so one bad input can stop the whole program.",
      },
      "CWE-295": {
        name: "Improper certificate validation",
        meaning:
          "The program does not properly check who it is talking to over a secure connection, so someone in the middle could pose as the other side.",
      },
      "CWE-311": {
        name: "Missing encryption of sensitive data",
        meaning: "Sensitive data is stored or sent without being encrypted, so anyone who reaches it can read it.",
      },
      "CWE-326": {
        name: "Inadequate encryption strength",
        meaning: "The encryption used is too weak, for example keys that are too short, so it can be broken with enough effort.",
      },
      "CWE-330": {
        name: "Predictable random values",
        meaning:
          "Values that should be unguessable, such as tokens or session ids, come from a source that an attacker can predict.",
      },
      "CWE-345": {
        name: "Data origin not verified",
        meaning: "The program trusts data without checking that it really came from where it claims to have come from.",
      },
      "CWE-346": {
        name: "Origin validation error",
        meaning: "The program accepts a request or message without properly checking which site or system sent it.",
      },
      "CWE-347": {
        name: "Signature not verified",
        meaning: "A signature on data is not checked or is checked wrongly, so forged data is accepted as genuine.",
      },
      "CWE-362": {
        name: "Race condition",
        meaning:
          "Two things happening at nearly the same time can interfere with each other and leave the program in a state nobody intended.",
      },
      "CWE-384": {
        name: "Session fixation",
        meaning: "An attacker can choose the session id a person will use, and so take over their session once they sign in.",
      },
      "CWE-401": {
        name: "Memory not released",
        meaning: "The program keeps taking memory and never gives it back, so it slows down and eventually stops.",
      },
      "CWE-407": {
        name: "Inefficient algorithm (slow on crafted input)",
        meaning:
          "The program uses a method that is fast on normal input but becomes very slow on input crafted to make it struggle.",
      },
      "CWE-444": {
        name: "HTTP request smuggling",
        meaning:
          "Two servers read the boundaries of the same web request differently, so an attacker can slip a hidden request past the first one.",
      },
      "CWE-476": {
        name: "Null pointer dereference",
        meaning: "The program uses a value that is missing as though it were there, which usually crashes it.",
      },
      "CWE-613": {
        name: "Sessions last too long",
        meaning:
          "A sign in stays valid for too long or after sign out, so a stolen session can be used for far longer than it should.",
      },
      "CWE-639": {
        name: "Access by changing an identifier",
        meaning:
          "A person can reach someone else's data just by changing an id in the request, because the program does not check who owns it.",
      },
      "CWE-668": {
        name: "Resource exposed to the wrong people",
        meaning:
          "Something that should be private, such as a file, a port or a service, can be reached by people who should not reach it.",
      },
      "CWE-674": {
        name: "Uncontrolled recursion",
        meaning:
          "A function can be made to call itself again and again without a limit, which uses up memory and crashes the program.",
      },
      "CWE-693": {
        name: "Protection mechanism failure",
        meaning: "A safeguard that should have protected the program is missing or does not work as intended.",
      },
      "CWE-732": {
        name: "Wrong permissions on a resource",
        meaning:
          "A file or other resource is open to more people than it should be, so it can be read or changed by those who should not.",
      },
      "CWE-754": {
        name: "Improper check for unusual conditions",
        meaning:
          "The program does not handle rare situations such as empty, missing or oversized input, so they cause crashes or odd behaviour.",
      },
      "CWE-776": {
        name: "Entity expansion attack",
        meaning:
          "A small piece of XML is built to expand into a huge amount of data, which uses up memory and stops the program.",
      },
      "CWE-787": {
        name: "Write past the end of a buffer",
        meaning:
          "The program writes memory beyond the space it was given, which can corrupt data or let an attacker run their own code.",
      },
      "CWE-829": {
        name: "Code included from an untrusted source",
        meaning:
          "The program loads and runs code from a place that is not under its own control, so whoever controls that place controls the program.",
      },
      "CWE-835": {
        name: "Infinite loop",
        meaning:
          "The program can be sent into a loop that never ends, so it uses all the processor time and stops serving anyone.",
      },
      "CWE-915": {
        name: "Unsafe update of object fields",
        meaning:
          "Input from outside is allowed to set fields on an object that it should not be able to set, such as an admin flag.",
      },
      "CWE-1035": {
        name: "Known vulnerable component",
        meaning: "The code relies on a package or library that has a published flaw, so the flaw comes along with it.",
      },
      "CWE-1236": {
        name: "Spreadsheet formula injection",
        meaning:
          "Text from outside is placed in a spreadsheet file and begins like a formula, so opening it can run commands on someone's computer.",
      },
      "CWE-1284": {
        name: "Improper validation of a quantity",
        meaning:
          "A number such as a length, a count or a quantity is accepted without checking that it is within a sensible range.",
      },
    },

    fixTime: {
      title: "Time to fix",
      lede: "How long alerts took to fix in the date range, and what was dismissed instead.",
      fixed: "Fixed in this range",
      fixedHint: "Alerts that were fixed, counted from the day each was raised.",
      median: "Typical time to fix",
      medianHint: (slowest: string, count: number) =>
        count === 0
          ? "No alert was fixed in this range."
          : `Half of the alerts were fixed faster than this, and three quarters within ${slowest}.`,
      slowest: "Slowest quarter",
      slowestHint: "Three quarters of alerts were fixed within this time.",
      dismissed: "Dismissed",
      dismissedHint: (reasons: string) => (reasons ? `Closed without a fix, ${reasons}.` : "Closed without a fix."),
      dismissedNone: "None were dismissed in this range.",
      bySeverity: {
        title: "Time to fix by severity",
        severity: "Severity",
        fixed: "Fixed",
        median: "Typical",
        slowest: "Slowest quarter",
        allowed: "Allowed",
        days: (count: number) => `${count} days`,
      },
      reasons: {
        fixed: "fixed",
        not_found: "no longer found",
        unspecified: "no reason given",
        fix_started: "a fix has been started",
        inaccurate: "judged inaccurate",
        no_bandwidth: "no time to fix",
        not_used: "the code is not used",
        tolerable_risk: "risk accepted",
        false_positive: "a false alarm",
        used_in_tests: "used in tests only",
        wont_fix: "will not be fixed",
        revoked: "revoked",
        auto_dismissed: "closed automatically by GitHub",
        pattern_deleted: "the pattern was deleted",
        pattern_edited: "the pattern was edited",
      } satisfies Record<CloseReason | "unspecified", string>,
      pushProtection: (count: number) =>
        `${count} ${count === 1 ? "secret was" : "secrets were"} pushed in this range after the person pushing chose to bypass push protection.`,
    },

    alerts: {
      title: "Every open alert",
      subtitle: "Every open alert, worst first, with where it is and how long it has been open.",
      filterLabel: "Show alerts from",
      filterAll: "Every source",
      filterOption: (name: string, count: number) => `${name} (${count})`,
      filterNote: (name: string) => `Only alerts from ${name} are listed here.`,
      capped: (shown: number, total: number) => `Showing the ${shown} worst of ${total} open alerts.`,
      noneInWorst: (name: string, shown: number) =>
        `None of the ${shown} worst open alerts come from ${name}, though it has others further down the list.`,
      none: "No open alerts match.",
      severity: "Severity",
      problem: "Problem",
      where: "Where",
      source: "Source",
      age: "Open for",
      fixBy: "Fix-by date",
      weakness: "Kind of problem",
      whereText: {
        package: (name: string | null, version: string | null, manifest: string | null) =>
          `${name ?? "A package GitHub did not name"}${version ? ` ${version}` : ""}${manifest ? ` in ${manifest}` : ""}`,
        code: (path: string | null, line: number | null) =>
          path ? (line === null ? path : `${path} line ${line}`) : "A location GitHub did not report",
        secret: (type: string) => `A secret of the kind ${type}`,
      },
    },

    upgrades: {
      title: "Dependency upgrades",
      lede: "The packages with open alerts, worst first, and the version that fixes each one.",
      subtitle: "Packages with open alerts and the upgrade that fixes them.",
      none: "No package has an open alert.",
      package: "Package",
      files: "Found in",
      lockedAt: (versions: string) => `Locked at ${versions}`,
      relationship: {
        direct: "Direct dependency",
        transitive: "Comes in through another package",
        mixed: "Direct, and through other packages",
      },
      alerts: "Alerts",
      worst: "Worst severity",
      upgradeTo: "Upgrade to",
      noFix: "No fixed version has been published yet",
      several: (versions: string) => `Different fixes for different alerts, ${versions}`,
      command: "Command",
      noCommand: "No command is known for this package manager",
      unnamed: "A package GitHub did not name",
      noCommandUnnamed: "No command, because GitHub did not name the package",
      noManifest: "Not reported",
      nothingToInstall: "Nothing to install until a fix is published",
      chooseVersion: "Choose one of the fixed versions first",
      pastFix: "Past fix-by date",
      pastFixCount: (count: number) => `${count} past`,
      noneText: "None",
    },

    updates: {
      title: "Keeping dependencies up to date",
      lede: "Small regular updates are the cheapest protection there is, because the fix for a flaw then arrives as a pull request that is easy to review.",
      opened: "Update pull requests opened",
      merged: "Merged",
      mergedHint: "Update pull requests that were merged in this range.",
      closed: "Closed without merging",
      openNow: "Open now",
      timeToMerge: "Typical time to merge",
      timeToMergeHint: (count: number) =>
        count === 0
          ? "No update pull request was merged in this range."
          : `Across ${count} merged update ${count === 1 ? "pull request" : "pull requests"}.`,
      oldest: "Oldest still open",
      oldestNone: "None are open.",
      openedHint: "Pull requests opened by Dependabot or Renovate in this range.",
      good: "Updates are being raised and merged, which is exactly what keeps dependencies safe.",
      noneYet: "No pull requests from Dependabot or Renovate were found in this range.",
      filesTitle: "Setup",
    },

    chain: {
      workflows: {
        title: "Workflows and supply chain",
        lede: "Your automated workflows run with access to your code and your secrets, so how they are set up matters as much as the code itself.",
      },
      tools: {
        title: "Security tools in CI",
        lede: "Scanners that run in your own pipeline catch problems before they are merged, and matter most where GitHub's own scanning is not available to you.",
      },
      images: {
        title: "Container images",
        lede: "The Dockerfiles in the repository, checked for the habits that most often cause trouble.",
      },
      files: { title: "Files that help", lede: "Small files that make security easier to look after." },
      updates: {
        title: "Dependency setup",
        lede: "Whether dependency updates are scheduled and whether lockfiles pin what you install.",
      },
      none: {
        analysis_off: "Workflow and dependency files are not read because code analysis is switched off on this dashboard.",
        not_read: "Workflow and dependency files have not been read yet. They are read during the next crawl.",
      },
      readOn: (sha: string, when: string, count: number) =>
        `Read from commit ${sha} on ${when}, covering ${count} ${count === 1 ? "workflow file" : "workflow files"}.`,
      unread: (count: number) =>
        `${count} workflow ${count === 1 ? "file was" : "files were"} not read, so ${count === 1 ? "it is" : "they are"} left out of the checks.`,
      dockerfilesUnread: (count: number) =>
        `${count} ${count === 1 ? "Dockerfile was" : "Dockerfiles were"} not read, so ${count === 1 ? "it is" : "they are"} left out of the checks.`,
      nothingFound: "There is nothing to check in this section.",
      totalNote: (shown: number, total: number) => `Showing ${shown} of ${total}.`,
      table: { check: "Check", result: "Result", detail: "What was found" },
      line: (path: string, line: number | null) => (line === null ? path : `${path} line ${line}`),
    },
    supplyChain: {
      prHeadCheckout: {
        title: "Workflows that run a pull request's own code with secrets",
        ok: "No workflow does this.",
        found: (n: number) => `${n} ${n === 1 ? "place does" : "places do"} this.`,
      },
      scriptInjection: {
        title: "Workflows that paste outsiders' text into a command",
        ok: "No workflow does this.",
        found: (n: number) => `${n} ${n === 1 ? "place does" : "places do"} this.`,
      },
      selfHostedPublic: {
        title: "Pull requests on self hosted machines",
        ok: "No public repository workflow does this.",
        found: (n: number) => `${n} ${n === 1 ? "place does" : "places do"} this.`,
      },
      unpinnedActions: {
        title: "Actions from other organisations pinned to a commit",
        ok: "Every one is pinned.",
        found: (n: number) => `${n} ${n === 1 ? "use of an action is" : "uses of actions are"} not pinned to a commit.`,
      },
      ownActionsUnpinned: {
        title: "Your own organisation's actions pinned to a commit",
        ok: "Every one is pinned.",
        found: (n: number) => `${n} ${n === 1 ? "use of an action is" : "uses of actions are"} not pinned to a commit.`,
      },
      workflowPermissions: {
        title: "Workflows that limit their token",
        ok: "Every workflow sets limits.",
        found: (n: number) => `${n} ${n === 1 ? "place sets" : "places set"} no limit on the token or allows everything.`,
      },
      unsecureCommands: {
        title: "Deprecated unsecure commands",
        ok: "No workflow switches them on.",
        found: (n: number) => `${n} ${n === 1 ? "workflow switches" : "workflows switch"} them on.`,
      },
      keyFiles: {
        title: "Private keys and environment files",
        ok: "None are stored in the repository.",
        found: (n: number) => `${n} ${n === 1 ? "file looks" : "files look"} like ${n === 1 ? "one" : "them"}.`,
      },
      weakKeyFiles: {
        title: "Files that may be keys",
        ok: "None found.",
        found: (n: number) => `${n} ${n === 1 ? "file needs" : "files need"} a look.`,
      },
      curlPipeShell: {
        title: "Downloads that are run without a check",
        ok: "None found.",
        found: (n: number) => `${n} ${n === 1 ? "place runs" : "places run"} a download straight away.`,
      },
      secretsInherit: {
        title: "Workflows that pass on every secret",
        ok: "None found.",
        found: (n: number) => `${n} ${n === 1 ? "call passes" : "calls pass"} on every secret.`,
      },
      persistCredentials: {
        title: "Checkouts that keep the token on disk",
        ok: "None found.",
        found: (n: number) => `${n} ${n === 1 ? "checkout keeps" : "checkouts keep"} it.`,
      },
      updateConfig: {
        title: "Scheduled dependency updates",
        ok: "Dependabot or Renovate is configured.",
        found: () => "No configuration was found.",
      },
      lockfiles: {
        title: "Lockfiles beside manifests",
        ok: "Every manifest has a lockfile.",
        found: (n: number) => `${n} ${n === 1 ? "manifest has" : "manifests have"} no lockfile.`,
      },
      securityPolicy: {
        title: "A security policy",
        ok: "A security policy is in place.",
        found: () => "No security policy was found.",
      },
      dependencyReview: {
        title: "Dependency review on pull requests",
        ok: "A dependency review runs in your pipeline.",
        found: () => "No dependency review was found.",
      },
      secretScanInCi: {
        title: "A secret scanner in your pipeline",
        ok: "A secret scanner runs in your pipeline.",
        found: () => "No secret scanner was found.",
      },
      staticAnalysis: {
        title: "A code scanner in your pipeline",
        ok: "A code scanner runs in your pipeline.",
        found: () => "No code scanner was found.",
      },
      baseImagesPinned: {
        title: "Base images pinned to a digest",
        ok: "Every base image is pinned.",
        found: (n: number) =>
          `${n} ${n === 1 ? "Dockerfile uses an image that is" : "Dockerfiles use images that are"} not pinned to a digest.`,
      },
      latestImages: {
        title: "Base images on a fixed version",
        ok: "No image uses the latest tag.",
        found: (n: number) => `${n} ${n === 1 ? "Dockerfile uses" : "Dockerfiles use"} the latest tag or none.`,
      },
      nonRootImages: {
        title: "Images that run as an ordinary user",
        ok: "Every image runs as an ordinary user.",
        found: (n: number) => `${n} ${n === 1 ? "Dockerfile runs its image" : "Dockerfiles run their images"} as the root user.`,
      },
      remoteAdd: {
        title: "Files fetched with ADD",
        ok: "No image fetches a file with ADD.",
        found: (n: number) => `${n} ${n === 1 ? "Dockerfile fetches" : "Dockerfiles fetch"} a file with ADD.`,
      },
    },

    failedSources: {
      title: "Some sources failed the last time they were read",
      body: (sources: string) =>
        `The last attempt failed for ${sources}. The figures use the earlier read where there is one, so they may be out of date.`,
      since: (name: string, when: string) => `${name}, last read on ${when}`,
      never: (name: string) => `${name}, never read`,
      link: "See how each source is read",
    },

    passFail: { met: "Met", unmet: "Not met", unseen: "Not visible" },

    branch: {
      title: "Branch protection and settings",
      lede: "Rules on your deploy branch decide whether a mistake or a stolen account can push straight to production, and a few repository settings decide whether GitHub helps you.",
      notRead: "Branch rules and settings have not been read yet. They are read during the next crawl.",
      readOn: (when: string) => `Read on ${when}`,
      failedKept: (message: string) =>
        `The latest attempt to read the branch rules and settings failed${withMessage(message)}, so the facts below are from an earlier read.`,
      failedNone: (message: string) =>
        `The latest attempt to read the branch rules and settings failed${withMessage(message)}, so nothing has been read yet. It is tried again at the next crawl.`,
      about: (branch: string, visibility: string | null, admin: boolean | null) =>
        `The deploy branch is ${branch}${visibility ? ` in a ${visibility} repository` : ""}. ${admin === true ? "The account the dashboard uses is an administrator, so it can read the branch rules and settings." : admin === false ? "The account the dashboard uses is not an administrator, so some settings are not visible." : "It is not known whether the account the dashboard uses is an administrator."}`,
      visibility: { public: "public", private: "private", internal: "internal" },
      detail: {
        full: "Both rulesets and classic branch protection could be read.",
        rulesets_only: "Only rulesets could be read, because classic branch protection needs an administrator.",
        none: "Neither rulesets nor branch protection could be read.",
      },
      notVisibleTitle: "Why some rules say not visible",
      notVisible:
        "Not visible means that the account the dashboard uses cannot see that setting, and most settings need a repository administrator. It does not mean the setting is off.",
      rulesTitle: "Rules on the deploy branch",
      settingsTitle: "Repository settings",
      advisoriesTitle: "Security advisories",
      advisories: (draft: number, triage: number, published: number, closed: number) =>
        `${draft} in draft, ${triage} in triage, ${published} published and ${closed} closed.`,
      advisoriesHidden: "Not visible, because advisories need administrator access.",
      publicOnly: "Only for public repositories",
      protectedLine: {
        yes: "The branch is protected.",
        no: "The branch is not protected.",
        unseen: "Whether the branch is protected could not be seen.",
      },
      rules: {
        requirePullRequest: "Changes need a pull request",
        requireStatusChecks: "Checks must pass before merging",
        blockForcePushes: "Force pushes are blocked",
        blockDeletion: "The branch cannot be deleted",
        requireSignedCommits: "Commits must be signed",
      },
      ruleHints: {
        requirePullRequest: "Nobody can push straight to the branch.",
        requireStatusChecks: "A red build blocks the merge.",
        blockForcePushes: "History cannot be rewritten.",
        blockDeletion: "The branch cannot be removed by accident.",
        requireSignedCommits: "Each commit is proved to come from its author. This is advice only.",
      },
      settings: {
        dependabotSecurityUpdates: "Dependabot security updates",
        secretScanning: "Secret scanning",
        pushProtection: "Push protection",
        validityChecks: "Checks that a leaked secret still works",
        privateVulnerabilityReporting: "Private vulnerability reporting",
      },
      settingHints: {
        dependabotSecurityUpdates:
          "Dependabot opens a pull request with the fix when an alert appears. This is a separate switch from Dependabot alerts, found under Settings, then Advanced Security.",
        secretScanning: "GitHub looks for passwords and keys in the code.",
        pushProtection: "A push that contains a secret is stopped before it lands.",
        validityChecks: "GitHub tells you whether a leaked secret is still active.",
        privateVulnerabilityReporting: "People can tell you about a flaw in private.",
      },
    },

    issues: {
      title: "Security issues",
      lede: "Issues that your team has labelled as security problems, which are a good sign that people raise them and a prompt to close them.",
      none: "This repository has no stored GitHub Issues, so security issues are not counted.",
      open: "Open security issues",
      openHint: "Issues classed as security problems that are still open.",
      oldest: "Oldest still open",
      oldestNone: "None are open.",
      closed: "Closed in this range",
      timeToClose: "Typical time to close",
      timeToCloseHint: (count: number) =>
        count === 0
          ? "No security issue was closed in this range."
          : `Across ${count} closed ${count === 1 ? "issue" : "issues"}.`,
      link: "Open the GitHub Issues page for this repository",
    },

    scorecard: {
      title: "OpenSSF Scorecard",
      lede: "A public rating of how well an open source project follows security habits. It is shown for information and never changes the grade.",
      only: "Only public projects in Scorecard's weekly scan have a score.",
      score: "Scorecard",
      scoreValue: (score: number) => `${score.toFixed(1)} out of 10`,
      scoreHint: (date: string) => `Scanned on ${date}.`,
      status: {
        off: "The Scorecard lookup is switched off. Set SCORECARD_LOOKUP=on in the environment file of the dashboard to switch it on.",
        not_public: "This repository is not public, so its name is never sent to Scorecard and it has no score.",
        not_scanned: "Scorecard has not scanned this repository. Only public projects in its weekly scan have a score.",
        not_read:
          "Scorecard has not been asked about this repository yet. It is asked at the next crawl, once the lookup is switched on.",
        error:
          "The Scorecard lookup failed the last time it ran. Any earlier score is kept, and the lookup is tried again at a crawl once the last good read is more than a day old, and at every full crawl.",
      },
      failedWith: (message: string, when: string) => `The lookup failed on ${when}${withMessage(message)}.`,
      earlierScore: "The score and checks below are from the last lookup that worked.",
      noEarlierScore: "No earlier score is held.",
      check: "Check",
      checkScore: "Score",
      reason: "What it found",
      notApplicable: "Not applicable",
      checkValue: (score: number) => `${score} out of 10`,
    },

    sources: {
      title: "How each source is read",
      lede: "The grade is only as complete as what could be read. This section says what was read, what was not, and how to switch each one on.",
      source: "Source",
      state: "State",
      howTo: "How to switch it on.",
      readOn: (when: string) => `Read on ${when}`,
      notYet: "Not read yet",
      truncated: "More alerts exist than the dashboard reads in one go, so the oldest are not shown.",
      skipped: (count: number) => `${count} ${count === 1 ? "alert" : "alerts"} could not be read.`,
      failed: (message: string) => `The last attempt failed${withMessage(message)}. Earlier results are kept.`,
      failedNoEarlier: (message: string) =>
        `The last attempt failed${withMessage(message)}. There is no earlier read to fall back on.`,
      lastGoodOn: (when: string) => `Last read successfully on ${when}`,
      status: {
        ok: "Read",
        off: "Switched off",
        no_access: "No access",
        not_used: "Not used",
        error: "Failed",
        not_read: "Not read yet",
      },
      notUsedLabel: {
        lookup_off: "Switched off",
        dependabot_ok: "Not needed",
        no_inventory: "Nothing to look up",
      } satisfies Record<NotUsedReason, string>,
      reasons: {
        disabled: "It is switched off for this repository.",
        not_set_up: "It has not been set up for this repository.",
        needs_advanced_security:
          "GitHub offers it on private repositories only with GitHub Code Security or GitHub Secret Protection.",
        forbidden: "GitHub refused the dashboard's sign in access to it.",
        admin_only_or_off: "Either it is switched off, or only a repository administrator can read it.",
        lookup_off: "The lookup is switched off on this dashboard.",
        dependabot_ok: "It is not needed while Dependabot alerts can be used.",
        dependabot_failed:
          "Dependabot's last read failed, so its earlier alerts are still graded and this lookup is not used in their place.",
        no_inventory: "There were no lockfiles that prove where packages came from, so there was nothing to look up.",
      },
      enable: {
        dependabot:
          "Open the repository's Settings, choose Advanced Security in the Security section of the sidebar, and switch on Dependabot alerts and Dependabot security updates.",
        code_scanning:
          "Open the repository's Settings, choose Advanced Security, and set up code scanning. On a private repository it needs GitHub Code Security.",
        secret_scanning:
          "Secret scanning alerts can only be read by a repository administrator. Open Settings, then Advanced Security, to switch it on, and note that on a private repository it needs GitHub Secret Protection.",
        osv: "Set OSV_LOOKUP=on in the environment file of the dashboard and keep CODE_ANALYSIS on. Only package names and versions that a lockfile proves came from a public registry are sent, and never your repository name, a path or a token.",
      },
      names: {
        supplyChain: "Workflow and dependency files",
        posture: "Branch rules and settings",
      },
      supplyChain: {
        ok: (sha: string, when: string) => `Read from commit ${sha} on ${when}.`,
        analysis_off: "Code analysis is switched off on this dashboard.",
        not_read: "These files have not been read yet.",
        failed: (message: string) => `The last inspection failed${withMessage(message)}. Earlier results are kept.`,
        failedNoEarlier: (message: string) =>
          `The last inspection failed${withMessage(message)}. There is no earlier read to fall back on.`,
        enable:
          "Set CODE_ANALYSIS=on in the environment file of the dashboard and crawl again, so that the workflow files can be read.",
      },
      posture: {
        ok: (when: string) => `Read on ${when}.`,
        notRead: "They have not been read yet.",
        failed: (message: string) => `The last attempt failed${withMessage(message)}. Earlier results are kept.`,
        failedNoEarlier: (message: string) =>
          `The last attempt failed${withMessage(message)}. There is no earlier read to fall back on.`,
        enable: "Branch rules can be read with read access. Most repository settings need a repository administrator.",
      },
    },

    glossary: {
      title: "What these words mean",
      summary: "Show the explanations",
      lede: "Plain explanations of the terms used on this page.",
      terms: [
        {
          term: "Dependabot",
          meaning:
            "A GitHub service with two separate parts. Dependabot alerts warn you when a package you use has a known vulnerability, and Dependabot version updates open pull requests that keep your packages current. Each is switched on on its own.",
        },
        {
          term: "Code scanning",
          meaning: "A GitHub feature that reads your own code for patterns that usually lead to security flaws.",
        },
        {
          term: "Secret scanning",
          meaning: "A GitHub feature that looks for passwords, keys and tokens that were committed by mistake.",
        },
        {
          term: "Advisory",
          meaning: "A public notice that a package has a flaw, saying which versions are affected and which version fixes it.",
        },
        {
          term: "CVE",
          meaning: "A catalogue number that identifies one published flaw, so that everyone can talk about the same one.",
        },
        {
          term: "GHSA",
          meaning: "The number GitHub gives an advisory in its own database, such as GHSA followed by letters and digits.",
        },
        {
          term: "CWE",
          meaning: "A catalogue of kinds of weakness, such as cross-site scripting, so that similar flaws can be grouped.",
        },
        {
          term: "EPSS",
          meaning:
            "The exploit prediction scoring system, a figure from 0 to 100 percent for how likely a flaw is to be used in real attacks soon.",
        },
        {
          term: "CVSS",
          meaning:
            "A score from 0 to 10 for how serious a flaw is in itself, which is higher when it is easier to use and does more damage.",
        },
        {
          term: "Lockfile",
          meaning: "A file that records the exact version of every package you install, so that everyone installs the same code.",
        },
        {
          term: "Pinning to a commit SHA",
          meaning: "Naming the exact commit of an action or image that you use, instead of a tag that its owner could move.",
        },
        {
          term: "GITHUB_TOKEN permissions",
          meaning: "What the automatic token given to each workflow run is allowed to do, which should be as little as possible.",
        },
        {
          term: "pull_request_target",
          meaning:
            "A workflow trigger that runs with secrets and write access even for pull requests from strangers, so it must never run their code. The plainer pull_request trigger is safer, because pull requests from forks get no secrets and only a read-only token.",
        },
        {
          term: "Branch protection",
          meaning: "Rules on a branch, such as requiring a pull request and passing checks, that nobody can skip.",
        },
        {
          term: "Push protection",
          meaning: "A feature that stops a push containing a recognised secret before it reaches the repository.",
        },
      ],
    },

    section: {
      title: "Security",
      lede: "A short summary of this repository's security grade and what to do next.",
      loading: "Loading security",
      tiles: {
        critical: "Critical alerts",
        high: "High severity alerts",
        pastFix: "Past their fix-by date",
        actions: "Things to fix",
      },
      more: (count: number) => `and ${count} more.`,
      partial: (names: string) => `The dashboard could not read ${names}, so these counts may be lower than the real ones.`,
      topTitle: "Start with these",
      none: "Nothing needs fixing in what the dashboard could read.",
      link: "Security for this repository",
      detail: "See the full security report",
    },

    verdict: {
      grade: (band: string) => `Security grade ${band}`,
    },
  },

  states: {
    emptyTitle: "Nothing to show yet",
  },
} as const;

export type Copy = typeof copy;
