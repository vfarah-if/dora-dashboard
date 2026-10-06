# 18. CI gates, Dependabot and a 90 percent coverage floor

Date: 2026-10-02

## Status

Accepted

## Context

CI ran formatting, lint, typecheck and coverage on a single Node version, never built the apps, and nothing proposed dependency updates. The coverage floors differed by workspace (core 90%, API 85%, web 80%, with web checking lines only), although every workspace already measured above 90% on lines, branches, functions and statements. A floor that sits well below the real figure lets coverage fall a long way before anyone is told.

## Decision

- **One floor of 90%** for lines, branches, functions and statements in `packages/core/vitest.config.ts`, `apps/api/vitest.config.ts` and `apps/web/vite.config.ts`. The existing exclusions (composition root, CLI, ports, type-only files) are unchanged.
- **CI in `.github/workflows/ci.yml`** runs each gate as its own named step: the private-name guard's self-test, `make fmt-check`, `make lint`, `make typecheck`, `make test-coverage` and `make build`. It runs on Node 22.13, the lowest version `engines` allows, and on Node 24. Superseded runs on a pull request are cancelled, the checkout does not keep its token, and the workflow can only read the repository.
- **Dependabot in `.github/dependabot.yml`** proposes npm and GitHub Actions updates every Monday. Minor and patch updates are grouped into one pull request for development and one for production dependencies, and major updates arrive one at a time. The exception is `vitest` and `@vitest/*`, which always share one pull request, majors included, because each requires the others at the exact same version. A release must be seven days old (fourteen for a major) before it is proposed. Commit subjects follow the conventional `chore(deps)` and `ci` prefixes.

## Consequences

### Positive

- A drop in coverage of a few points now fails the build in every workspace, rather than only after a large fall.
- A build that typechecks but fails to bundle, or code that relies on a newer Node than `engines` admits, is caught before merge.
- Dependencies, including the actions CI itself runs, stay current without anyone having to remember, and the cooldown keeps freshly published releases out for a week.

### Negative

- Branch coverage in web is the closest to the floor, so small untested branches in a component will fail CI and need a test before merge.
- Two Node versions double the CI minutes.
- Dependabot pull requests arrive weekly and still need a human to review and merge them. A bump to a package listed in `allowScripts` in `package.json` also needs that entry updated by hand, or its install script will not run.
- The private-name list is gitignored, so in CI the guard can only prove that its matcher works, not that the tree is clean. That check stays local, through `make check-names`.

## Revision History

- 2026-10-06: Added a `vitest` group to `.github/dependabot.yml` covering `vitest` and `@vitest/*` for every update type. Dependabot raised the Vitest 5 major on its own and left `@vitest/coverage-v8` on 3.x, whose exact peer on `vitest@3` stopped npm hoisting Vitest to the root. Each workspace then held its own copy, the `@testing-library/jest-dom` type augmentation at the root no longer reached the copy in `apps/web`, and the web typecheck failed on every DOM matcher.
- 2026-10-06: The npm rules above now also govern dependency updates taken by hand through `make upgrade`, which reads them from `.ncurc.mjs` (ADR 0024).
