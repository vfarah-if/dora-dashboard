# 33. Grade security in four bands from alerts, workflows and change control

Date: 2026-10-11

## Status

Accepted

## Context

A list of alerts leaves the reader to decide whether a repository is in good shape, which is the problem ADR 0013 solved for code health. Security also has an extra difficulty, because many signals are missing for reasons that are not the team's fault, such as a private repository without a paid GitHub product or a token that cannot see settings. The grade has to reward outcomes, stay fair to those repositories, and give developers a clear list of what to do next.

## Decision

**Four bands and three parts.** The grade uses the same bands as the DORA measures and code health (`Band`), so the existing tile and label render it. The overall band is the lowest of three parts, and a tie names vulnerabilities, then supply chain, then change control. The checks and their order are in `SECURITY_CHECKS` in `packages/core/src/securityTypes.ts`, the functions are in `securityGrade.ts`, and `docs/metrics.md` carries the thresholds.

| Part            | Counts                                                                                                                                                     | Worst band it allows |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Vulnerabilities | Open alerts by severity and age, an exposed secret, and Dependabot switched off by choice                                                                  | low                  |
| Supply chain    | A pull request head checkout or script injection under a privileged trigger, unpinned third-party actions, broad workflow permissions, committed key files | low                  |
| Change control  | Merges without independent approval, an unprotected deploy branch, force pushes allowed                                                                    | medium               |

**Fix-by days are this project's convention.** Critical 7, high 30, medium 90 and low 180 days (`FIX_WITHIN_DAYS`), with unrated alerts treated as medium, so when two alerts are compared an unrated one ranks just below a real medium. The limits the grade and the advice use are carried in the report as `thresholds`, so the page never repeats a number of its own. No standard publishes them, and a later ADR can change them as ADR 0013 allows for its limits.

**Outcomes are graded, practices only where no outcome shows the risk.** An open alert is an outcome. A missing update configuration, lockfile, security policy or CODEOWNERS file, and code or secret scanning being unavailable, are advice only, so a private repository without a paid product is not penalised.

**Missing data is left out.** Following code health, a source that could not be read does not fail the grade and is listed as unmeasured. The one exception is Dependabot switched off by choice with no other result, which caps vulnerabilities at medium, because that is a real gap the team controls.

**Change control.** Merged human pull requests into the deploy branch with no approval by another person before the merge, over a fixed 90 day window. The part is graded only with at least 10 merges (`REVIEW_MIN_MERGED`) from more than one author, so a solo project is exempt. An unprotected branch or one that allows force pushes is graded high. A branch is unprotected only when GitHub said it is not protected and no rule of any kind is in force.

**The grade describes now.** Open alerts and facts exist only for the latest crawl, so the list, the detail page and the PDF agree. The chosen date range scopes trends, time to fix, dismissals and a second review figure, and never the grade.

**EPSS orders, it never grades.** A high exploit prediction moves an alert up within its severity and shows as a tag, so a published score from outside cannot change a band.

**Bots and people.** Review authors are read with `__typename` so a bot's approval does not count as independent. No person is named anywhere (ADR 0008).

**Ranked actions.** Each check yields structured actions, ordered with those on the path to the next band first, then by band, severity, likely exploitation, number of findings, kind and target. The band the repository would reach is worked out by clearing alerts and not checks, so an alert that feeds two checks is cleared from both, and every alert behind an action on the path counts as cleared. Core carries kinds, counts and targets only, and the plain-language why and how, with copyable snippets, are written in the web.

**Later changes.** When a newly read source lowers a grade, ADR 0026's rule applies, so the bands stay and the lower grade stands.

## Consequences

### Positive

- Every repository gets a verdict with a named cause, and unmeasured areas are stated and not rewarded.
- Because severity and the grade are computed on request, changing a threshold changes every past report without a crawl.

### Negative

- The bands are our own convention, so grades compare across repositories here and not with other tools.
- A grade shows what GitHub and the files report, so an alert nobody has triaged weighs as heavily as one that is a known false positive.
- A repository whose only gap is unreadable data can reach elite on what was measured, which the unmeasured list has to make plain.
- Teams will see a lower grade after a source starts being read, for example once a token gains access.
- Small repositories fall near cliff edges, because one critical alert past seven days moves the whole band.

## Revision History

- 2026-10-12: Recorded that unknown severity ranks below medium, that thresholds travel in the report, that the path to the next band clears by alert, and the exact rule for an unprotected branch.
