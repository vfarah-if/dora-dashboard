# 34. Look up locked dependencies in OSV.dev by choice

Date: 2026-10-11

## Status

Accepted

## Context

Dependabot alerts are the best source of vulnerable dependencies, but a repository may have Dependabot switched off, or a token that cannot read its alerts. The lockfiles in the clone (ADR 0032) list exactly what is installed, and OSV.dev is a public database that answers which of those versions are known to be vulnerable. Asking it is a new external system and sends data off the host, which is a decision an operator should make and not one the dashboard makes quietly.

## Decision

**Off by default.** `OSV_LOOKUP=on` switches it on, and `/api/health` reports it. It needs `CODE_ANALYSIS`, because the packages come from the clone, and the API refuses to start with the lookup on and code analysis off.

**Used only when Dependabot is not usable.** When Dependabot has read alerts, OSV is not asked, so the two never disagree about one repository. When OSV is not used its source is stored as `not_used`, with the reason `lookup_off`, `dependabot_ok` or `no_inventory`, and its stored alerts are cleared, so Dependabot becoming usable clears the OSV history. `no_inventory` is used only when a supply chain record exists and lists no lockfile that could hold a public package. With no record, an unreadable one, or a lockfile that exists but could not be read, nothing is known about the packages, so the stored alerts are left as they are, and a `not_used` state that would then be untrue is recorded as `not_read`.

**A port of its own.** `VulnerabilityDatabase` has one adapter, wired only in `main.ts` and `cli.ts` (ADR 0003). It uses the fixed host `api.osv.dev`, sends no token or other credential, refuses redirects, and has a timeout, body caps, batches of 1,000 and a small cache. At most 20,000 distinct packages are sent for one repository and at most 1,000 records are fetched in one lookup. The answer is given for each package, and a package that a cap left incomplete is answered as such (`null`) and the others are unaffected. When one record cannot be fetched the lookup fails and makes no further requests, and the earlier alerts are kept, and so they are when a result is not in the documented shape, since reading it as clean would close alerts.

**What leaves the host.** Only ecosystem, package name and version, never a repository name, an owner, a path or a token.

**Public registry rule.** A package is sent only when its lockfile proves a public registry. That is `resolved` on the public npm registry for `package-lock.json`, `npm-shrinkwrap.json` and Yarn v1, crates.io for `Cargo.lock`, packages that name no source in any form (a `[package.source]` table, an inline `source = {...}` or dotted `source.` keys, in any quoted spelling) for `poetry.lock`, the public index for `uv.lock` and `Pipfile.lock`, and the `rubygems.org` remote for `Gemfile.lock`. The rules are in `packages/core/src/lockfiles.ts`. pnpm, Bun, Go, Composer and Yarn Berry are excluded because their lockfiles cannot prove the registry. `requirements.txt` is a list of requirements and not a lockfile, so a Python project that has only that has nothing to read.

**Private npm scopes.** npm also hosts private packages, so scopes equal to the repository owner and any listed in `OSV_PRIVATE_NPM_SCOPES` are withheld before any request. The residual risk is that a private package published under some other scope, and resolved from the public registry's address, would be sent. The operator closes that gap by listing the scope. A package withheld this way is never asked about, so its stored alerts are left as they were and not closed as fixed.

**Alias grouping.** An advisory and its aliases form one finding, named by its GHSA id when present, with the worst severity of the group, so one problem is not counted two or three times.

**Synthetic alert lifecycle.** OSV has no alert history, so an alert is created at the crawl that first finds it, keeps that date, and closes at the crawl that no longer finds it, but only when its lockfile was read in full that time (parsed and not capped) and the package was answered, or when its lockfile has been deleted from the repository, which is concluded only from a complete listing of the clone (ADR 0032). A lockfile that exists but could not be read in full, such as one with more than 20,000 public packages, leaves its alerts unchanged, and so does a package that was withheld, past the cap or not answered in full. A finding that was fixed and then returns opens afresh, with its creation time reset, so its fix-by clock starts again and the weekly rows do not show it open while it was fixed.

## Consequences

### Positive

- Repositories without Dependabot get dependency findings, and the grade no longer caps at medium for it when OSV answers.
- Nothing leaves the host unless the operator opts in, and what does leave is public package identity.

### Negative

- The set of dependencies can fingerprint an organisation, and the host needs egress to `api.osv.dev`.
- Trends are only as fine as crawl frequency, because first seen and closed times are crawl times.
- Records outside the GitHub advisory database often carry no severity, so they show as unrated and grade as medium.
- A private npm package under an unlisted scope would be sent, which relies on the operator setting `OSV_PRIVATE_NPM_SCOPES` correctly.
- pnpm, Bun, Go, Composer and Yarn Berry repositories, and Python repositories with only a `requirements.txt`, get no OSV coverage.

## Revision History

- 2026-10-12: Recorded the 20,000 package cap, the failed record fetch, that every reason for not using OSV clears its alerts, that a deleted lockfile closes its alerts, and that a returning finding restarts its creation time.
- 2026-10-12: An OSV source that is not used is stored as `not_used` and not `off`, and `no_inventory` needs a supply chain record without a lockfile that could hold public packages. Results are per package, so one incomplete package no longer stops every closure, and withheld, capped or incomplete packages keep their alerts. Poetry packages with an inline or dotted `source` are private, and a malformed OSV result fails the lookup.
- 2026-10-12: Deletion of a lockfile is concluded only from a complete clone listing, any quoted spelling of Poetry's source marks a package private, and a missing or unreadable record turns `not_used` into `not_read`.
