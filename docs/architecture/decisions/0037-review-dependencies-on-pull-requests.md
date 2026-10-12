# 37. Review dependencies on pull requests

Date: 2026-10-12

## Status

Accepted

## Context

Dependabot alerts and the OSV.dev lookup (ADR 0034) report a vulnerable dependency once it is on the default branch. The security page's own advice, `add_dependency_review`, points out that the cheapest moment to refuse a vulnerable package is the pull request that adds it, and this repository did not check for one there.

## Decision

`.github/workflows/dependency-review.yml` runs `actions/dependency-review-action` on every pull request, pinned to the commit of v5.0.0 like any other action, with a read-only token and the action's defaults, so a pull request that adds a dependency with a known vulnerability of any severity fails the check. The job checks nothing out: the action compares the base and head dependency graphs through GitHub's API and reads a local file only when given a `config-file`, which this workflow does not use.

The check is not required on `main`, because `main` has no branch protection by the owner's choice. It shows in the pull request as a failed check, posts no comment, and does not stop a merge.

## Consequences

### Positive

- A vulnerable addition is named in the pull request that adds it, before it reaches the default branch.
- The security page's "Dependency review on pull requests" check is met by the repository's own example.
- One more action, owned by GitHub, pinned to a commit and kept current by the `actions` group of the `github-actions` entry in `.github/dependabot.yml`.

### Negative

- A failing check can still be merged while `main` is unprotected, so the review warns rather than blocks.
- It fails on a low severity advisory as readily as a critical one, including one that has no fixed version yet, which may need a reviewer to merge past it.
- It needs the dependency graph, which public repositories have; a private fork without GitHub Code Security sees the job fail.
