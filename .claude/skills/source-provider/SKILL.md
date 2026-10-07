---
name: source-provider
description: >
  Playbook for adding or changing an adapter to an external system: a code host (GitLab, Bitbucket,
  a self-hosted GitHub Enterprise or client instance) or an issue tracker (Jira, Linear). Use when
  touching apps/api/src/interfaces or apps/api/src/infrastructure, or when asked to "point it at"
  something other than github.com.
---

# Adding a source provider

The API reaches every external system through a port in `apps/api/src/interfaces/` (ADR 0003). A new system is a new adapter, never a branch inside a service.

## A code host

1. **Read the contract** in `interfaces/source-provider.ts`. The non-negotiables:
   - pages ordered by `updatedAt` descending (the incremental crawl stops on the first stale page);
   - an invisible repository raises `NotFoundError`, never returns an empty page;
   - a rejected credential raises `UnauthorisedError`; any other upstream failure raises `UpstreamError`.
2. **Map onto the domain**, not the other way round. A GitLab merge request is a `PullRequest`; a pipeline is a `DeployRun` whose `workflow` is the pipeline or job name. If a concept has no equivalent, leave the field null and document it rather than inventing a value.
3. **Inject `fetch`** through the constructor, as `GitHubProvider` does, so tests pass a fake without a mocking library.
4. **Test the adapter** with recorded response shapes in `apps/api/test/`, covering: mapping, pagination to the end, the cursor on the last page, each error status, and a record with optional fields missing.
5. **Wire it** in `main.ts` only. If more than one host is live at once, add a `provider` column to `repos` and pick the adapter per repository in a small registry; services still take the port.
6. **Record it** in an ADR: the host, how its auth works, which fields have no equivalent.

Self-hosted instances (a client's GitHub Enterprise or GitLab) are usually the same adapter with a different base URL. Make the base URL a constructor argument and a per-repository setting before writing a second adapter.

## An issue tracker (Jira and similar)

A tracker is a **different port**, not a `SourceProvider`: it yields work items, not pull requests.

1. Add `interfaces/work-item-provider.ts` with a `WorkItem` type in `packages/core` (key, type, status history with timestamps, created, resolved, linked PR references).
2. The join to pull requests is the useful part: a PR whose title or branch carries an issue key (`ABC-123`) links to that item. Put the key-matching rule in core as a pure function with tests.
3. Metrics that open up: idea-to-PR time (item created to first linked PR opened), and idea-to-production (item created to the deploy that shipped its last PR).
4. Jira Cloud authenticates with an API token and email, or OAuth 2.0 (3LO). Never a password. Store nothing on disk; follow the session pattern in ADR 0004.
5. Write an ADR before starting; the status-history mapping (which statuses mean "in progress") differs per project and needs a stated rule.

## An issue tracker on the code host (GitHub Issues)

An issue tracker that lives on the code host is not a `WorkItemProvider` either. It has its own port, `IssueProvider` in `interfaces/issue-provider.ts`, because it has no site, space or per-person grant. It is read during the repository crawl with the code host's own token, through `IssueCrawlService`, and a failure there is stored as the repository's issue error and never fails the crawl. Read its contract before writing an adapter, and see ADR 0028. Keep external trackers such as Jira on `WorkItemProvider`, with their own credentials, as above.

## Deployed sites and publishing

ADR 0010 sets the order and names two further ports: `DeploymentSignalProvider` (release and outage events read from a live site) and `ReportPublisher` (a comparison rendered into Confluence or similar, written only on request). Treat each like a code host: a port, an adapter taking `fetch` and a base URL, recorded-response tests and an ADR.

## Checks

- `make test` green, API coverage at or above 90% on every measure.
- No real hostnames, project keys or organisation names in fixtures (ADR 0009).
