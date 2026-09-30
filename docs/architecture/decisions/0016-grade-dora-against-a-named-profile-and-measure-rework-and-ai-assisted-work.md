# 16. Grade DORA against a named profile and measure rework and AI-assisted work

Date: 2026-09-30

## Status

Accepted

## Context

AI assistance makes throughput cheap, so deployment frequency and lead time can reach the elite band without more value being delivered. DORA's own 2024 research reported that AI adoption tended to raise throughput while delivery stability fell. Our bands also had no cited source, because ADR 0006 said only that they came from the DORA clusters, and a reader could not tell which standard produced a grade.

## Decision

1. **Grade against a named, versioned threshold profile.** The thresholds move from inline literals in `packages/core/src/dora.ts` into data in `packages/core/src/doraProfiles.ts`. One profile ships, with id `dora-2023` and name "DORA 2023", citing the 2023 Accelerate State of DevOps Report (https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf). The verified values are as follows.

   | Band   | Lead time     | Deploy frequency  | Change failure | Recovery      |
   | ------ | ------------- | ----------------- | -------------- | ------------- |
   | Elite  | under a day   | on demand         | 5%             | under an hour |
   | High   | under a week  | daily to weekly   | 10%            | under a day   |
   | Medium | under a month | weekly to monthly | 15%            | under a week  |

   We simplify in three ways. "On demand" becomes 7 or more deploys a week, a range becomes its upper or lower edge, and a cluster's failure rate becomes "or less". The band functions take a profile and default to `dora-2023`. Every report returns the profile id, name and source, and the API accepts a `profile` query parameter on both report and compare, so a comparison always grades every repository against the same profile (ADR 0008). A new profile is added only with a published citation, and there is no selector in the interface until a second profile exists.

   We rejected grading on a bell curve across repositories, because it ranks rather than measures, always forces someone into low, rests on too few repositories to form a distribution, and conflicts with ADR 0008. We also rejected a boolean feature flag that shifts thresholds, because it hides which standard produced a grade and makes two reports look comparable when they are not.

2. **Rework rate is shown beside change failure rate.** It is the share of successful deploys in the range that shipped at least one PR whose title starts with `revert` or `hotfix`, over all successful deploys in the range. A PR ships with the first successful deploy run created at or after its merge, which is the mapping lead time already uses. It has no band, because DORA publishes none for it. It approximates DORA's 2024 rework rate, which counts unplanned deployments made to fix a user-facing problem. It counts the deploy that shipped the fix rather than the one that caused the problem, and it pairs only PRs merged inside the range.

3. **Pull requests are split into AI-assisted cohorts.** A PR is AI-assisted when it carries the default label `ai-assisted`, when any of its commits carries a `Co-Authored-By` trailer whose whole name is one an assistant signs with (such as Claude, Claude Opus, GitHub Copilot, Cursor Agent, Codex, Devin AI or Gemini Code Assist), or when its bot author matches one. Names are matched in full and case-insensitively, so a person called Claude Martin is not counted, and a bare `ai` label is left out because it often names a product area. A PR crawled before labels and trailers were recorded is "unknown" until a full crawl. The report splits the PR measures (count, median and p75 cycle time from first commit to merge, median size, reviewed share and revert share) into assisted and unassisted. Deploy measures are not split, because a deploy mixes both kinds of work.

   The crawl now fetches PR labels and the messages of the last 100 commits of each PR. Only the name part of each trailer is stored, and the email and the message are discarded. This is the same class of data as the logins already cached.

## Consequences

### Positive

- Every grade names the published standard that produced it, and a second standard can be added as data without touching the band logic.
- Comparisons stay fair, because one profile grades every repository in a report.
- Rework rate and the assisted split show whether faster delivery is coming with more unplanned fixes, which throughput figures alone cannot reveal.

### Negative

- Unmarked AI use counts as unassisted, so the assisted cohort is a floor and not a total.
- Labels depend on team discipline, and a PR with more than 100 commits may miss trailers.
- The default patterns are a convention, so an assistant that signs with another name is missed until they are extended.
- The crawl query is heavier, because it now requests labels and commit messages, so pages drop from 50 to 25 PRs (10 on retry) and a crawl makes more requests.
- The band table copy on the home page is still maintained by hand beside the profile data, so the two can drift apart.
- Cached PRs show as unknown until a full crawl is run.
