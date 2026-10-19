# 31. Read GitHub security alerts and repository posture during the crawl

Date: 2026-10-11

## Status

Accepted

## Context

The dashboard shows delivery flow, DORA, code health and issues, but says nothing about security, although GitHub already holds Dependabot, code scanning and secret scanning alerts, and the rules that protect the deploy branch. The crawl holds a token (ADR 0004) and has already shown that a further GitHub read can be added behind its own port without a new credential (ADR 0028, ADR 0030). Reading the alerts during the crawl, and storing them, gives trends, time to fix and a comparison across repositories that a live read would not. The shapes are in `packages/core/src/securityTypes.ts`.

## Decision

**A port of its own.** `SecurityAlertSource` has one adapter for GitHub, wired only in `main.ts` and `cli.ts` (ADR 0003). It returns alerts in core's shape, so no service sees a GitHub field name, and a second code host would be a second adapter. The port also gives the page where features are switched on (`settingsUrl`), so no service names a host.

**What is read.** The three alert endpoints (Dependabot, code scanning and secret scanning) and, for the deploy branch only, branch protection, the rules that rulesets apply, the repository's security settings and its own security advisories, counted by state. The statuses, messages, paging and limits are in `docs/metrics.md` under Security.

**Credentials.** The existing `repo` scope suffices, which was checked against a live repository, so no new credential or consent step is needed. A fine-grained token needs read permission for each source. Some reads also need the person behind the token to have the Write or administrator role, and a token without it sees those parts as not visible. `SETUP.md` lists the rights.

**Each source on its own.** Every source is read independently and stored with a status of `ok`, `off`, `no_access`, `not_used` (OSV only, ADR 0034), `error` or `not_read`. Only a 401 fails the crawl, as in ADR 0028, and any other failure is recorded against the stage that raised it while the later stages still run. An `error` keeps its last good read only when the state before it was `ok` or an `error` that had one, so one bad read hides nothing that is still true and a failure cannot bring back alerts that were not in use. A source that is `off` has its stored alerts cleared, whereas `no_access` keeps what a more privileged token stored and counts none of it, so a less privileged crawl wipes nothing. Only exact messages mean off, and any other refusal, such as a single sign-on block, is an error, so an alert is never cleared on a guess.

**Stored messages.** A failure is stored with its status, and GitHub's own text only when it contains a known phrase about permissions, rate limits or a missing resource, because any other text from upstream is free text (rule 9). No stored message carries the token or an address.

**Paging and transport.** Stored alerts are pruned only after a complete read, and a source that holds more than the page cap, or whose next link was refused, is marked truncated. The token never leaves GitHub's API host.

**Privacy.** Secret scanning is always requested with `hide_secret=true`, and the secret value is never mapped, stored or returned. People fields and free text are never mapped either, in keeping with ADR 0008, and no login appears in any security response.

**Posture failures.** A failed posture read is stored beside the earlier posture, which is kept, and the report carries both as `postureFailure`. The repository's security advisories are counted only for an administrator, because GitHub answers 200 without the draft and triage ones to anyone else. A permission refusal leaves one part unknown, whereas a rate limit, any other 403 or a 404 for the repository or branch fails the read, so no posture made of unknowns is saved. An unprotected branch is fully known when GitHub says it is not protected.

**Storage.** Alerts, source states and the repository posture go in new SQLite tables (ADR 0005) that cascade when a repository is removed. A stored row that cannot be read back is left out, logged and counted in its source's `skipped`, so the page never presents the figures as complete when rows are missing. One damaged row, including a pull request or issue row, never fails the list or the report of another repository. Dependabot and OSV alerts store the severity mapped when they were read, while code scanning and secret scanning severities are worked out at report time, as ADR 0028 does for issue kinds.

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
- 2026-10-12: Statuses became a union with each reason tied to its status, `not_used` was added for OSV, and an error keeps its last good read only from `ok` or an earlier error. Rate limits without headers, exact switched-off messages, refused next links as truncation, paged rulesets and advisories, GitHub's own error texts, posture failure classification (`postureFailure`) and the adapter's settings URL are recorded. Severity is stored for Dependabot and OSV alerts and worked out at report time for the other two, and a damaged stored row costs only its own repository.
- 2026-10-12: GitHub's own text is kept in a stored message only when it is a known phrase, and otherwise the message says only the status (rule 9). A ruleset list cut at the page cap or a refused next link gives `detail` `none` when nothing seen is enforced and `rulesets_only` when something is, so `full` means the rulesets were read in full. A one-time migration clears the read time of `error` source rows written by the earlier build, which therefore have no last good read, and a posture table without its attempt time is rebuilt.
- 2026-10-12: Trimmed the Decision to what was decided and why, because the statuses, stored messages, paging and limits, permissions and posture rules are kept in `docs/metrics.md` and `SETUP.md`, and the copies here had drifted. The stored message now has two forms, a refusal that cannot be classified ("GitHub refused to list code scanning alerts") and any other failed status ("GitHub answered 502"), and a whole GitHub message of up to 300 characters is kept when it contains a known phrase. `detail` is `full` whenever classic protection was read, and the cut ruleset rule applies to a branch known to be unprotected.
- 2026-10-12: Advisory counts are read only for an administrator, and stored alerts that cannot be read back count in their source's `skipped`.
- 2026-10-19: The alert source port also builds a link to a file at a commit (`fileUrl`), as it builds the settings page. It makes no request and reads nothing, and it gives nothing for a commit that is not hexadecimal, an empty path or a path with a `.` or `..` segment. Core receives the link as a function and never learns the host. No new data is read.
- 2026-10-19: Findings of the clone can be accepted with a reason and a note (ADR 0040). The note, written in the dashboard and at most 280 characters, is the only free text stored in security data. It is never alert text, and no person is stored with it, so no login, session value or token is stored or returned for an acceptance.
