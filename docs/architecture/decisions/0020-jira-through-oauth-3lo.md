# 20. Jira through OAuth 2.0 (3LO)

Date: 2026-10-06

## Status

Accepted

## Context

ADR 0010 proposed a `WorkItemProvider` port for Jira as its second step. To see what developers deliver against the work they were asked to do, issues must be read from Jira and joined to pull requests. People reach several Jira sites with one account, so the dashboard should list every site the person grants access to at consent without anyone configuring each one, and it must not store credentials on disk (ADR 0004).

## Decision

**Authentication.** Jira Cloud is read through OAuth 2.0 (3LO). The person consents at `auth.atlassian.com` with `prompt=consent`, and the code is exchanged for an access token that lasts about an hour and a rotating refresh token, issued because `offline_access` is requested. Sites come from `oauth/token/accessible-resources`, and API calls go to `api.atlassian.com/ex/jira/{cloudId}`. The scopes are `read:jira-work`, `read:jira-user`, `offline_access` and three granular ones for the board endpoints, `read:board-scope:jira-software`, `read:board-scope.admin:jira-software` and `read:project:jira` (`ATLASSIAN_SCOPES` in `atlassian-oauth.ts`). SETUP.md tells the reader to enable them on the Atlassian app, because a scope the app does not hold cannot be added by connecting again.

**Configuration.** Each deployment registers its own Atlassian app. `Config.jira` holds `{ clientId, clientSecret, redirectUri }`, or null when Jira is off, and `main.ts` prints `jira on` or `jira off` from it. `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` are set together, and one alone stops the API at start-up so that a half-finished configuration is not mistaken for Jira being off. The redirect defaults to `WEB_ORIGIN` followed by `/api/auth/jira/callback`. With Jira off the routes are not registered and answer 404.

**Consent routes.** `/api/auth/jira/start` and `/api/auth/jira/callback` are browser navigations, so each has a route-level error handler and nothing on them answers raw JSON. A signed-out person goes to the dashboard root, and a rate limit (ADR 0023) or a validation failure goes to `/repos` with an outcome. The callback returns to the page with a `jira` outcome of `denied` (consent declined), `expired`, `misconfigured`, `rate_limited` or `error` (everything else). SETUP.md maps each outcome to its cause and fix. Each redirect logs its reason at info, and an exchange failure logs at warn when it is an expected error and at error when it is not, never with the code, the state or any token.

- **State.** The state is random and used once, and a used state is refused while its cookie could still be replayed. The cookie signs the state together with its issue time, so a captured cookie older than 10 minutes is refused even if unused. A missing or lapsed cookie, or a state that differs because consent was started again in another tab, gives `expired`. That also covers slow consent, an API restart and a browser host that differs from `WEB_ORIGIN`.
- **Misconfigured.** `misconfigured` means Atlassian refused the dashboard's own app credentials at the sign-in exchange, which is a 401, an error of `invalid_client`, `access_denied` or `unauthorized_client`, or a description naming `redirect_uri`. It is logged at error level with Atlassian's `error_description` (which holds no secret), because only the operator can fix it.
- **Not found.** A not-found handler answers 404 `{ error: "Not found" }` and never logs or echoes the URL, so an unregistered callback's code never reaches the log.

**Why refresh is classified differently.** A refresh answered 401 or 403 is a refusal and drops the grant. A 400 is a refusal only when its error is `invalid_grant`, because any other 400 means this dashboard's own request is wrong and dropping every grant would hide the bug. Only the sign-in exchange classifies configuration errors, and a refused refresh is logged at warn. Atlassian documents only `403 invalid_grant` ("Unknown or invalid refresh token") for refresh (https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), and a revoked grant is reported as `401 unauthorized_client` ("Token was globally revoked", https://community.developer.atlassian.com/t/token-was-globally-revoked-when-trying-to-get-auth-token/78751). Classifying refresh errors by code would therefore keep dead grants. At sign-in no grant exists yet, so a misclassification only changes the message. A refresh that fails for another reason (any other 400, a 5xx, a 429 or the network) keeps the grant and reaches the caller as a 502 or 429.

**Grants.** Grants are held in process memory only, keyed by the signed-in GitHub login (ADR 0004), and an access token is refreshed when under a minute is left. Any read of a grant counts as use, including a background crawl and the connection check the repositories page makes, because that check lists sites live through the token. A grant unused for more than the 8 hour session lifetime is dropped. Signing out, disconnecting and restarting also remove it, and `make crawl` cannot read Jira because it has no browser grant.

When a grant goes without the person asking, its reason is remembered for a day and `GET /api/jira` reports `lapsed` as `idle` (unused for 8 hours), `refused` (Jira or Atlassian turned it down) or `expired` (the access token ran out and there is no refresh token). Connecting again, disconnecting or signing out clears it, and every drop is logged at info with the reason and never the login.

**Jira's refusals.** A Jira 401 during a read or a crawl drops the grant, but only if it still holds the token Jira refused, so a reconnect made during the request is kept. The crawl stores a neutral message on the space ("Jira refused the connection used for this crawl. Crawl again with a working connection."), because everyone who views the space reads it. Atlassian answers a token that lacks a scope with `401 {"code":401,"message":"Unauthorized; scope does not match"}` (https://community.developer.atlassian.com/t/how-to-solve-unauthorized-scope-does-not-match/81389, https://community.developer.atlassian.com/t/oauth-2-0-3lo-granular-jira-software-scopes-present-in-token-but-rest-agile-1-0-returns-401-scope-does-not-match/100456). The adapter reads the body and raises `AccessRefusedError` for that, so it is treated as a 403 below, and any other 401 stays a rejected credential with Atlassian's reason in the log. A Jira 403 raises `AccessRefusedError`, answered as 403 with a message that the account may lack permission or the app a scope, and the grant is kept. A 403 or 502 response is logged at warn. A 404 is not found. A malformed JSON body answers 400 and an oversized one 413.

**Port and adapter.** `WorkItemProvider` is the port and `JiraCloudProvider` the adapter, which takes `fetch` and an API base, so Data Center becomes another adapter or a configuration change. Issues are read with `POST /rest/api/3/search/jql`, and status history with `POST /rest/api/3/changelog/bulkfetch` because inline changelogs are truncated.

**Board access.** `board` is null until the board has been read (a newly linked or never crawled space), then `read`, `none` or `forbidden`. `forbidden` means Jira refused the board, usually for want of a board scope, and the page then says why time per column uses statuses (ADR 0021). The store migration runs in one transaction and marks existing rows `read` when they hold columns, keeps an earlier `forbidden`, marks the rest `none` when a crawl has finished and leaves null otherwise.

**Status rule and joins.** The first transition into an in-progress category starts work and the last transition into done ends it, which every space has by default. Spaces link to repositories many to many, and issues join pull requests by issue key in the title or head branch, so the crawl records `headRef` and needs one full re-crawl to back-fill.

**What is stored.** Site URLs, space keys, issue summaries, assignee account ids and per-space display names live only in SQLite under the gitignored `data/` directory (ADR 0009). Email addresses are never read (ADR 0008).

### Alternatives considered

- **API token plus email.** It needs a per-site, per-person secret in the environment and does not discover sites.
- **Personal Access Tokens.** They exist for Jira Data Center only.
- **Storing refresh tokens on disk.** It would remove the reconnect after a restart but reopens ADR 0004.

## Consequences

### Positive

- One consent lists every site the person granted, with no per-site setup.
- No Jira credential is written to disk, and the browser never sees one.
- A failed consent always lands on a page that says what happened, and an operator's mistake is told apart from a person's.
- Data Center or another tracker is a new adapter behind the same port.

### Negative

- Every deployment must register its own Atlassian app and keep a client secret in `.env`.
- A restart, 8 idle hours or signing out drops every affected grant, and the terminal crawl cannot read Jira.
- The category default will not match every team's columns until per-space overrides exist, and only the first board of a space is read.
- Pull requests crawled before `headRef` was recorded need one full re-crawl for branch joins.
- Crawled issues, including summaries, for a linked space are visible to every signed-in dashboard user, even one whose Jira account cannot see that space, so that matters when choosing spaces to link.
- A full crawl removes stored issues the space no longer holds, and a failed full crawl removes nothing. The incremental cursor is the newest update time less five minutes, which costs a few idempotent repeat upserts.
- Saving the spaces of one site replaces only the repository's links on that site.
