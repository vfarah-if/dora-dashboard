# 38. Run every quality gate before each push

Date: 2026-10-12

## Status

Accepted

## Context

CI runs `make quality` on every pull request, but nothing ran it before a push, so a gate that failed on the developer's own machine was only found on CI some minutes later. On 2026-10-12 the web coverage run failed on CI after a push to the security branch, and it had already failed on the developer's machine before that push.

## Decision

- **Husky 9 as a root devDependency.** Its `prepare` script runs on `npm install`, so `make install` points `core.hooksPath` at `.husky/_` in each clone. Husky has no dependencies and no install scripts of its own.
- **`.husky/pre-push` runs `make quality`**, the gates CI runs apart from the production build. Formatting and lint take about ten seconds, and Turbo replays the typecheck and the tests of any workspace that has not changed, so a push with nothing new to test is quick. A workspace that has changed costs its full coverage run, about a minute for the web app.
- **Before a push, not before a commit**, because commits are frequent and the coverage run is too slow to sit in front of each one.
- **The hook only reads.** It never stages, stashes, restores or commits anything (CLAUDE.md rule 2). The gates check the working tree rather than the commits being pushed, so the hook says so when the working tree has changes that are not committed.
- `git push --no-verify` skips it for one push, and `HUSKY=0` turns it off for a shell.

## Consequences

### Positive

- A push with a failing gate stops on the developer's machine, with the failing test in front of them, rather than on CI.
- Each clone gets the hook from `make install`, with no step to remember.

### Negative

- The gates see uncommitted work as well as the commits being pushed, so a change not yet committed can stop a push that would pass, or let through one that would not. The hook warns when this is so, but does not set the work aside, because the working tree belongs to the developer.
- It cannot catch a failure that only a slower machine causes, such as a test near its time limit on CI's shared runner. The raised test timeouts in `packages/core/vitest.config.ts` and `apps/web/vite.config.ts` answer that case.
- Every push waits for the gates, from about ten seconds to a minute or more.
- A clone made before this change gets the hook only once `make install` runs again.
- CI's `npm ci` also runs `prepare`, which points `core.hooksPath` at the hook in the runner's checkout, where nothing pushes.
