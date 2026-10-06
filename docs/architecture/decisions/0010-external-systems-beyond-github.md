# 10. External systems beyond github.com

Date: 2026-09-29

## Status

Proposed

## Context

The dashboard reads github.com only. Teams using it also work in client-hosted git, client-owned Jira instances, and deliver to live client sites whose own availability is the truest signal of deployment and recovery. Results also need to reach the places those teams read, such as Confluence.

## Decision

Each system arrives as an adapter behind a port (ADR 0003), in this order:

1. **Client-hosted git.** `GitHubProvider` takes a base URL, so GitHub Enterprise Server is configuration; a `GitLabProvider` implements `SourceProvider` for GitLab merge requests and pipelines. `repos` gains `provider` and `base_url` columns, and credentials are per repository.
2. **Jira, ours and clients'.** A new `WorkItemProvider` port and a `WorkItem` type in core. Items join to pull requests by issue key in the title or branch. Opens idea-to-PR and idea-to-production time. Jira Cloud authenticates with an API token or OAuth 2.0 (3LO), never a password.
3. **Deployed sites.** A `DeploymentSignalProvider` port that reads release events from a site itself (a version endpoint or a status page), so deployment frequency and time to restore can reflect production rather than the pipeline.
4. **Publishing to Confluence.** A `ReportPublisher` port that renders a comparison as a page. It writes only when a person asks.

Every adapter follows the `source-provider` skill, and every real hostname or project key stays in local, gitignored configuration (ADR 0009).

## Consequences

### Positive

- Each system is independently useful and independently testable, and none changes the services already built.

### Negative

- Credentials per repository and per instance need somewhere to live that is not process memory, which reopens ADR 0004's decision for shared deployments.
- Jira status names differ per project, so "in progress" needs a mapping each team configures; there is no default that is right for everyone.

## Revision History

- 2026-10-06: Step 2 (Jira) is decided by [ADR 0020](0020-jira-through-oauth-3lo.md), which chooses OAuth 2.0 (3LO) and holds grants in memory only, with the measures in [ADR 0021](0021-delivery-measures-from-jira.md). Jira's three status categories are the default rule, so a team's own mapping is an override. The other steps remain proposed.
