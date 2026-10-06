# 20. Jira through OAuth 2.0 (3LO)

Date: 2026-10-06

## Status

Accepted

## Context

ADR 0010 proposed a `WorkItemProvider` port for Jira as its second step. To see what developers deliver against the work they were asked to do, issues must be read from Jira and joined to pull requests. People reach several Jira sites with one account, so the dashboard should list every site that account can see without anyone configuring each one, and it must not store credentials on disk (ADR 0004).

## Decision

**Authentication.** Jira Cloud is read through OAuth 2.0 (3LO). The person consents at `auth.atlassian.com` with the audience `api.atlassian.com` and `prompt=consent`. The code is exchanged at `auth.atlassian.com/oauth/token` for an access token that lasts about one hour and a rotating refresh token, issued because the `offline_access` scope is requested. Sites are discovered through `oauth/token/accessible-resources`, so every site the account can reach is listed without configuration. API calls go to `api.atlassian.com/ex/jira/{cloudId}`.

**Scopes.** `read:jira-work`, `read:jira-user` and `offline_access`, plus the granular scopes needed to read boards (`read:board-scope:jira-software`, `read:board-scope.admin:jira-software` for board configuration, and `read:project:jira`). SETUP.md lists the exact set to tick.

**Registration.** Each deployment registers its own Atlassian OAuth 2.0 app and supplies `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` and `ATLASSIAN_REDIRECT_URI`, which defaults to `http://localhost:5181/api/auth/jira/callback`. When these are absent the Jira routes return 404 and the feature is off.

**Grants.** Grants are held in process memory only, keyed by the signed-in GitHub login, in line with ADR 0004. A restart means reconnecting Jira, and `make crawl` (the command line) cannot crawl Jira in this slice because it has no browser grant.

**Port and adapter.** The port is `WorkItemProvider` and the adapter is `JiraCloudProvider`, which takes `fetch` and an API base, so Jira Data Center becomes another adapter or a configuration change later. Issues are read with `POST /rest/api/3/search/jql`, because the legacy `/search` endpoint is deprecated. Status history is read with `POST /rest/api/3/changelog/bulkfetch`, because inline changelogs are truncated.

**Default status rule.** The first transition into an in-progress category starts work and the last transition into done ends it. Jira's three status categories (to do, in progress, done) give a default that every space has. Per-space overrides come later. Board columns are stored so that a later slice can measure time per column.

**Joining to code.** Spaces are linked to repositories, many to many. Issues join to pull requests by issue key in the pull request title or head branch. The crawl now records `headRef` on pull requests, which needs one full re-crawl to back-fill.

**What is stored.** Site URLs, space keys and issue summaries live only in SQLite under the gitignored `data/` directory (ADR 0009). Only the opaque assignee account id is stored, never a name or email address (ADR 0008).

**Metrics.** Metrics are deliberately out of scope until real data has been spot-checked. When they arrive, issue-level timings will carry names that cannot be confused with DORA lead time.

### Alternatives considered

- **API token plus email.** It needs a per-site, per-person secret in the environment and does not discover sites, so every new site would need editing by hand.
- **Personal Access Tokens.** They exist for Jira Data Center only, so they do not serve Jira Cloud.
- **Storing refresh tokens on disk.** It would remove the reconnect after a restart but reopens the decision in ADR 0004 that no credential is written to disk.

## Consequences

### Positive

- One consent lists every reachable site and space, with no per-site setup.
- No Jira credential is written to disk, and the browser never sees one.
- Data Center or another tracker is a new adapter behind the same port.

### Negative

- Every deployment must register its own Atlassian app and keep a client secret in `.env`.
- A restart drops every Jira grant, so people reconnect, and the terminal crawl cannot read Jira.
- The category default will not match every team's columns until per-space overrides exist.
- Pull requests crawled before this change lack `headRef`, so branch-name joins need one full re-crawl.
- Crawled issues, including their summaries, for a linked space are visible to every signed-in dashboard user, even those whose Jira account cannot see that space. That is acceptable for a self-hosted team tool, but it must be known when choosing which spaces to link.
- Only the first board of a space is read for its columns.
- Grants are removed when a person signs out, as well as on an explicit disconnect and on a restart.
- A full crawl removes stored issues that the space no longer holds, so deleted or moved issues disappear once it completes. A failed full crawl removes nothing.
- The incremental cursor is the newest update time less five minutes, so late-indexed and same-millisecond issues are read again; this costs a few repeated upserts, which are idempotent.
- Saving the spaces of one site replaces only the repository's links on that site.
