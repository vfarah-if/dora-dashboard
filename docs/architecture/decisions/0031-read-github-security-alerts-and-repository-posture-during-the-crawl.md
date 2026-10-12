# 31. Read GitHub security alerts and repository posture during the crawl

Date: 2026-10-11

## Status

Accepted

## Context

The dashboard shows delivery flow, DORA, code health and issues, but says nothing about security, although GitHub already holds Dependabot, code scanning and secret scanning alerts, and the rules that protect the deploy branch. The crawl holds a token (ADR 0004) and has already shown that a further GitHub read can be added behind its own port without a new credential (ADR 0028, ADR 0030). Reading the alerts during the crawl, and storing them, gives trends, time to fix and a comparison across repositories that a live read would not. The shapes are in `packages/core/src/securityTypes.ts`.

## Decision

**A port of its own.** `SecurityAlertSource` has one adapter for GitHub, wired only in `main.ts` and `cli.ts` (ADR 0003). It returns alerts in core's shape, so no service sees a GitHub field name, and a second code host would be a second adapter.

**What is read.** The three alert endpoints (`dependabot/alerts`, `code-scanning/alerts` and `secret-scanning/alerts`) and, for the deploy branch only, branch protection, the rules that rulesets apply to the branch, the repository's security settings (security updates, push protection, validity checks and private vulnerability reporting) and its own security advisories, counted by state.

**Credentials.** The existing `repo` scope suffices, because `X-Accepted-OAuth-Scopes` lists `repo` for all three alert endpoints, which was checked against a live repository. A fine-grained token needs read permission for each of Dependabot alerts, code scanning alerts, secret scanning alerts and repository security advisories. Dependabot and code scanning alerts also need the person behind the token to have at least the Write role. Secret scanning alerts need a repository or organisation administrator, as do classic protection detail and the `security_and_analysis` settings, which an organisation owner or a security manager can see as well, and automated security fixes need administrator read access. Ruleset rules, the branch's protected flag and private vulnerability reporting need only Metadata, which every fine-grained token has.

**Each source on its own.** Every source is read independently and stored with a status of `ok`, `off`, `no_access`, `error` or `not_read`, plus a reason where one applies. Only a 401 fails the crawl, as in ADR 0028. Any other failure is stored with the failure's own message, such as a rate limit with the time it lifts, or a neutral message when it was unexpected, and the previous alerts and read time are kept, so one bad read hides nothing that is still true. No stored message carries the token, and any query string in an address is removed. A rate limit is recognised before a 403 is taken to mean that a feature is switched off. Code scanning answers 404 for a repository with no analysis and for a token that cannot see the list, so only the message "no analysis found" means that it is off. A source that is `off` has its stored alerts cleared, whereas `no_access` keeps what a more privileged token stored and records only the state, so a less privileged crawl wipes nothing. The kept alerts are not counted while the source says `no_access`.

**Paging and transport.** The adapter asks for 100 alerts a page, follows the `Link` header only to an https address on the API's own origin, and reads at most 10 pages per source. A source that holds more is marked truncated. Stored alerts are pruned only after a complete read, which is one that was not truncated and that mapped every alert, so an alert that could not be mapped never causes an earlier copy to be dropped. Redirects are followed by hand, at most three and only to https on the origin of the request, so the token cannot leave GitHub's API host. A reply is read to a cap of 16 MiB and a body that is not JSON is an upstream error. A deploy branch name with a `.` or `..` segment is refused before any request.

**Privacy.** Secret scanning is always requested with `hide_secret=true`, and the secret value is never mapped, stored or returned, and no stored field is called `secret`. People fields (who dismissed, resolved or bypassed, and assignees) and free text (comments, rule help, advisory descriptions and instance messages) are never mapped either, in keeping with ADR 0008. An alert's title is the advisory summary or the rule description, which is published text and not a person's. No login appears in any security response.

**Posture failures.** A failed posture read is stored beside the earlier posture, which is kept, with its message and time, and the report carries the message as `postureError` so the page can say that the branch facts are from an earlier read.

**Storage.** Alerts, source states and the repository posture go in new SQLite tables (ADR 0005) that cascade when a repository is removed. An alert row that cannot be read back is left out and logged, and does not fail the report. Severity is not stored. It is worked out at report time from the raw facts, as ADR 0028 does for issue kinds, so changing the mapping needs no crawl.

## Consequences

### Positive

- Trends, time to fix and cross-repository comparison need no live calls, and the page loads from stored data.
- A repository without a paid GitHub product, or a token with fewer rights, still gets a report for the sources that could be read, with the reason for each gap stated.
- No new credential, consent step or external system is needed.

### Negative

- Each crawl makes more GitHub calls, up to ten pages for each of three alert sources plus the posture reads, which counts against the rate limit on large estates.
- GitHub gives no reopen history, so an alert reopened after a fix reads as open from its creation, and a read stopped at ten pages shows only the most recently updated alerts.
- Alerts are as fresh as the last crawl, so a new alert or a fix does not show until the next one.
- Settings and classic protection detail that need an administrator show as not visible for most tokens, which is not the same as switched off, and the page has to say so.
- Alerts are read with the token of whoever crawled and are then shown to everyone signed in to the dashboard, although GitHub limits secret scanning alerts to administrators. An operator who crawls with an administrator's token shares what that token can see.

## Revision History

- 2026-10-12: Recorded the permissions in full, the failure messages and their scrubbing, that `no_access` keeps stored alerts and only `off` clears them, the stricter reading of code scanning's 404, the manual redirect rule, the reply cap, stored posture failures and the shared token as a negative consequence.
- 2026-10-12: An unprotected branch is now fully known. When the branch read says `protected: false`, or classic protection answers 404 "Branch not protected", the classic part is reported as read and `detail` is `full` when rulesets were also read; other 404 and 403 answers still mean not visible. Private vulnerability reporting and repository security advisories are requested only when the visibility is `public`, because GitHub answers 404 for a private repository even to an administrator. Weakness ids are normalised to `CWE-<number>`.
