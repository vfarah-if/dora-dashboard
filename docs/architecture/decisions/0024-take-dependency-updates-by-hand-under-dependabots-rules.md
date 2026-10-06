# 24. Take dependency updates by hand under Dependabot's rules

Date: 2026-10-06

## Status

Accepted

## Context

Dependabot proposes updates once a week under three rules (ADR 0018). A release must be seven days old before it is proposed, or fourteen for a major, TypeScript is not offered a new major while the root pins 5.9 for typescript-eslint, and `vitest` moves with `@vitest/*` or not at all. Taking an update between those runs, or taking a major on purpose, meant editing manifests by hand or running npm-check-updates without any of those rules. A machine whose npm config sets `legacy-peer-deps` will also install a mismatched pair without complaint, which is how the Vitest split recorded in ADR 0018 went unnoticed until the web typecheck failed.

## Decision

- **`make upgrade`** lets a developer choose updates for the root and every workspace from a grouped, interactive list in the manner of `yarn upgrade-interactive`. `make upgrade-root`, `upgrade-core`, `upgrade-api` and `upgrade-web` do the same for one manifest, and `make upgrade-check` lists what is available without changing anything. `target=minor` or `target=patch` narrows the choice, and `cooldown=<days>` shortens the wait when an urgent fix cannot wait a week.
- **npm-check-updates 23.1.0, pinned exactly and run through `npx`.** It is not a devDependency because it requires Node 22.22.2 or later, above the 22.13 floor that `engines` admits and CI installs on, so every CI install would warn about it.
- **`.ncurc.mjs` holds the rules** and mirrors `.github/dependabot.yml`. It sets a seven-day cooldown, offers only versions that the installed packages' peer ranges accept, drops TypeScript majors, and puts `vitest` and `@vitest/*` in a group of their own that is never pre-selected. Patch and minor updates are pre-selected and majors are not.
- **A choice is proved before it is kept.** `npm install` runs with `--min-release-age` set to the same cooldown, because npm-check-updates only writes the range and npm would otherwise fill it with the newest release. `npm ls --all --legacy-peer-deps=false` then fails on any unmet or mismatched peer whatever the developer's npm config says, and `make quality build` runs every gate CI runs. The target finishes by printing the diff of the manifests and lockfile, and any install scripts not yet covered by `allowScripts`, through `npm approve-scripts --allow-scripts-pending`.
- If nothing is chosen, nothing is installed. When a gate fails, the target prints how to put the manifests back, and it never stages, commits or restores anything itself.

## Consequences

### Positive

- An update taken by hand meets the same cooldown, TypeScript and Vitest rules as a Dependabot pull request, and passes the same gates before anyone commits it.
- The lockfile cannot quietly take a release younger than the cooldown.
- A Vitest pair bumped apart now fails straight after the install, with npm naming both packages, rather than later as a typecheck error in `apps/web`.

### Negative

- The rules live in two files, `.github/dependabot.yml` and `.ncurc.mjs`, which must be changed together. Each file says so.
- npm-check-updates applies one cooldown to every update, so a major waits seven days here against fourteen under Dependabot. Majors are never pre-selected, so taking one is always a deliberate choice.
- The pinned npm-check-updates version is bumped by hand in the `Makefile`, because Dependabot does not read it, and `npx` needs the network the first time it runs.
- The Vitest group only places the pair together and leaves it unticked; it does not stop someone ticking one of them. The `npm ls` check after the install is what enforces the pairing.
- The targets are interactive and need a terminal, so they cannot run in CI.
- Every upgrade that changes a manifest ends with the full quality gate and a production build, even for a single patch.
