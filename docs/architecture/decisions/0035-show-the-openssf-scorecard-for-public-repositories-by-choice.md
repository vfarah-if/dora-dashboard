# 35. Show the OpenSSF Scorecard for public repositories by choice

Date: 2026-10-11

## Status

Accepted

## Context

The OpenSSF Scorecard rates open source projects on practices such as pinned dependencies, review and token permissions, and publishes the results for projects it scans each week. A reader of a public repository may want that independent view beside this page's own findings. It is a new external system, and asking it names the repository, so it must not be asked about a private one.

## Decision

**Off by default.** `SCORECARD_LOOKUP=on` switches it on, and `/api/health` reports it.

**Public repositories only.** The lookup runs only when the posture read of the same crawl (ADR 0031) succeeded and says the repository's visibility is `public`, so no private name leaves the host. A stored posture is not enough, because the repository may have been made private since. When visibility could not be read it is treated as not public, and the page shows `not_public` and no stored score unless the stored posture says `public`.

**A port of its own.** `ScorecardSource` has one adapter, wired only in `main.ts` and `cli.ts` (ADR 0003). It uses the fixed host `api.securityscorecards.dev`, sends no token, refuses redirects, has a timeout and a body cap, and keeps only the score, its date and each check's name, score and reason, never the details. A reply whose score is missing or whose date is not a valid ISO date or date-time is refused as an error.

**Not scanned.** A 404 means the project is not in Scorecard's weekly scan, which is shown as such and is not an error. A public repository with nothing held yet, such as just after the lookup was switched on, is `not_read`, not `not_scanned`.

**Read at most daily.** The result is stored with its read time. An ordinary crawl reads it again only when the last good read is more than a day old, and every full crawl reads it again, as Scorecard itself updates weekly. A failed read keeps the last good result and read time, so the next ordinary crawl does not ask again until that read is a day old. The report shows `error` with the failure's own message, scrubbed of the token and any query string, and the time of the attempt, with the last good result beside it. The state is one union, so a result and a status cannot disagree.

**Display only.** The score never enters the grade, as ADR 0030 keeps measured coverage out of code health. The score reflects a scan on a schedule outside this dashboard, and a grade that moved because the scan ran would break the rule in ADR 0026 that bands change with the repository or a more complete measurement.

## Consequences

### Positive

- Public projects get an independent second opinion with no setup beyond one setting.
- Private repositories are never named to an outside service.

### Negative

- The lookup shows the repository's name to a third party, and needs egress to `api.securityscorecards.dev`.
- The score can be up to a week old and may describe a different commit than the one graded here.
- Only projects in Scorecard's weekly scan have a score, so many public repositories show none.
- Scorecard's checks overlap with this page's own, so a reader can see two verdicts that differ, which the page explains and does not reconcile.

## Revision History

- 2026-10-12: Corrected the daily rule to say when an ordinary and a full crawl read again and what a failed read keeps, required a successful posture read in the same crawl, and recorded that unreadable visibility shows as not public with no stored score.
- 2026-10-12: Added the `not_read` state, stored the failure's message and attempt time instead of one neutral text, and showed the last good result beside an error.
