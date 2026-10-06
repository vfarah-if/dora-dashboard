// Rules for `make upgrade` and `make upgrade-check`, mirroring .github/dependabot.yml so a hand-run upgrade
// is held to the same standard as a Dependabot pull request (ADR 0024). Change one, change the other.

const VITEST_GROUP = "Vitest (take all of these or none)";

export default {
  // A release must be a week old before it is offered, so a compromised publish is usually caught first.
  // Dependabot waits fourteen days for a major; ncu cannot tell the two apart, so majors are never pre-selected.
  // Keep it a whole number of days: the Makefile passes it to npm install as --min-release-age.
  cooldown: 7,

  // Offer only versions that every installed package's peer ranges accept.
  peer: true,

  // The root pins TypeScript 5.9 for typescript-eslint, which does not support 7 yet; the workspaces build with 7.
  filterResults: (name, { currentVersionSemver, upgradedVersionSemver }) =>
    name !== "typescript" || !(Number(upgradedVersionSemver?.major) > Number(currentVersionSemver[0]?.major)),

  // Vitest and its plugins require each other at the exact same version, majors included (ADR 0018). A custom
  // group keeps them together on screen and unticked, so they are taken as a set or left as a set.
  groupFunction: (name, defaultGroup) => (name === "vitest" || name.startsWith("@vitest/") ? VITEST_GROUP : defaultGroup),
};
