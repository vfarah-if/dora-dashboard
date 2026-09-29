# 7. Measure lead time only inside the observed deploy window

Date: 2026-09-29

## Status

Accepted

## Context

The first crawl of a two-year-old repository reported a median lead time of 77 days. Its deploy workflow had only existed for the last year, so every pull request merged before then was matched to the first recorded deploy, months after it actually shipped by some earlier route. A younger repository showed the same effect on the handful of pull requests merged before its pipeline ran for the first time.

## Decision

`leadTimes` ignores any pull request merged before the earliest deploy run it has observed on the deploy branch. A pull request merged even minutes before that first run is excluded too, because nothing proves an earlier, unrecorded deploy did not ship it.

## Consequences

### Positive

- Lead time reflects the pipeline that exists, rather than the moment a workflow file happened to be added.

### Negative

- Lead time covers fewer pull requests than the other measures, and the count beside it says how many. A repository whose history of runs is truncated by the host's retention period loses lead time for the older part of its history.
