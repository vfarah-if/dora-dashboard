# 33. Grade security in four bands from alerts, workflows and change control

Date: 2026-10-11

## Status

Accepted

## Context

A list of alerts leaves the reader to decide whether a repository is in good shape, which is the problem ADR 0013 solved for code health. Security also has an extra difficulty, because many signals are missing for reasons that are not the team's fault, such as a private repository without a paid GitHub product or a token that cannot see settings. The grade has to reward outcomes, stay fair to those repositories, and give developers a clear list of what to do next.

## Decision

**Four bands and three parts.** The grade uses the same bands as the DORA measures and code health (`Band`), so the existing tile and label render it. The overall band is the lowest of three parts, and a tie names vulnerabilities, then supply chain, then change control. The checks and their order are in `SECURITY_CHECKS` in `packages/core/src/securityTypes.ts`, the functions are in `securityGrade.ts`, and `docs/metrics.md` carries the thresholds.

| Part            | Counts                                                                                                                                                                                                                                                          | Worst band it allows |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Vulnerabilities | Open alerts by severity and age, an exposed secret, and Dependabot switched off by choice                                                                                                                                                                       | low                  |
| Supply chain    | A pull request head checkout or script injection under a privileged trigger, a self-hosted runner reached by pull requests in a public repository, unpinned third-party actions, broad workflow permissions, unsecure commands switched on, committed key files | low                  |
| Change control  | An unprotected deploy branch, force pushes allowed                                                                                                                                                                                                              | high                 |

**Fix-by days are this project's convention.** Critical 7, high 30, medium 90 and low 180 days (`FIX_WITHIN_DAYS`), with unrated alerts treated as medium, so when two alerts are compared an unrated one ranks just below a real medium. The limits the grade and the advice use are carried in the report as `thresholds`, so the page never repeats a number of its own. No standard publishes them, and a later ADR can change them as ADR 0013 allows for its limits.

**Outcomes are graded, practices only where no outcome shows the risk.** An open alert is an outcome. A missing update configuration, lockfile or security policy file, and code or secret scanning being unavailable, are advice only, so a private repository without a paid product is not penalised.

**Missing data is left out.** Following code health, a source that could not be read does not fail the grade and is listed as unmeasured. The one exception is Dependabot switched off by choice with no other result, which caps vulnerabilities at medium, because that is a real gap the team controls.

**Change control.** An unprotected branch or one that allows force pushes is graded high, and the part is measured when the branch was read. The page calls it Branch protection. Merges and approvals are not counted (see the revision of 2026-10-12). A branch is unprotected only when GitHub said it is not protected, the rulesets were read and no rule of any kind is in force, so a branch whose rulesets could not be read is not read, and change control is listed as unmeasured.

**The grade describes now.** Open alerts and facts exist only for the latest crawl, so the list, the detail page and the PDF agree. The chosen date range scopes trends, time to fix and dismissals, and never the grade.

**EPSS orders, it never grades.** A high exploit prediction moves an alert up within its severity and shows as a tag, so a published score from outside cannot change a band.

**People.** No person is named anywhere (ADR 0008).

**Ranked actions.** Each check yields structured actions, ordered with those on the path to the next band first, then by band, severity, likely exploitation, number of findings, kind and target. The band the repository would reach is worked out by clearing alerts and not checks, so an alert that feeds two checks is cleared from both, and every alert behind an action on the path counts as cleared. Core carries kinds, counts and targets only, and the plain-language why and how, with copyable snippets, are written in the web.

**Later changes.** When a newly read source lowers a grade, ADR 0026's rule applies, so the bands stay and the lower grade stands.

## Consequences

### Positive

- Every repository gets a verdict with a named cause, and unmeasured areas are stated and not rewarded.
- Because the grade, the fix-by dates and the severities of code scanning and secret scanning alerts are worked out on request, changing a threshold changes every report without a crawl. A change to how Dependabot or OSV severities are mapped applies as each alert is next read (ADR 0031).

### Negative

- The bands are our own convention, so grades compare across repositories here and not with other tools.
- A grade shows what GitHub and the files report, so an alert nobody has triaged weighs as heavily as one that is a known false positive.
- A repository whose only gap is unreadable data can reach elite on what was measured, which the unmeasured list has to make plain.
- Teams will see a lower grade after a source starts being read, for example once a token gains access.
- Small repositories fall near cliff edges, because one critical alert past seven days moves the whole band.

## Revision History

- 2026-10-12: Recorded that unknown severity ranks below medium, that thresholds travel in the report, that the path to the next band clears by alert, and the exact rule for an unprotected branch.
- 2026-10-12: Removed the review check from change control. A review can happen outside GitHub, or be posted under the pull request author's own account, where GitHub holds it exactly as it holds a self-comment, so merges without another person's approval could not be told from merges that were reviewed. On one repository 139 of 151 merges counted against the grade, and most of them were syncs of code reviewed elsewhere or reviews posted under the author's account, so the check produced false positives and presented review habits as a security problem. The `unapprovedMerges` check, the `require_review` action, the `review` and `reviewInRange` fields, the review fields of `thresholds` and `REVIEW_WINDOW_DAYS`, `REVIEW_MIN_MERGED` and `UNAPPROVED_LIMITS` are gone, and change control keeps `branchUnprotected` and `forcePushAllowed`, so its worst band is now high. The same reasoning removed the advice to require approvals, dismiss stale approvals, require code owner review and add a `CODEOWNERS` file, which presuppose review recorded on GitHub, and the branch card no longer shows the approval, stale approval, code owner and linear history rules. The security policy line and advice now appear only for public repositories, which are the ones with outside reporters. The web calls the part Branch protection. Review habits are now a delivery figure, described in ADR 0036.
- 2026-10-12: An unprotected branch needs its rulesets read as well as its protected flag. A source's alerts count only while it is in use: Dependabot first and OSV only when Dependabot cannot be used, and an `error` source counts only through its last good read. CODEOWNERS files are not read, so they are no longer named as advice.
- 2026-10-12: The alerts of one package that have no fix form a `replace_dependency` action beside the `upgrade_dependency` action for those that have one, so raising the grade never counts an alert an upgrade cannot fix. `selfHostedPublic` is unmeasured, rather than passed, when pull requests run on a self-hosted runner and the repository's visibility could not be read. Composite actions and reusable workflows are checked with the triggers of the workflows that call them (ADR 0032).
- 2026-10-12: The supply chain row of the table now names the self-hosted runner and unsecure commands checks, and the consequence about severity no longer says that every severity is worked out on request, because Dependabot and OSV severities are stored when the alert is read.
- 2026-10-19: `prHeadCheckout`, `scriptInjection` and `selfHostedPublic` no longer count lines whose conditions provably keep an outsider's event out, so guarded lines are not counted (ADR 0039).
- 2026-10-19: Findings of the clone that a person has accepted leave the grade and the band, and the report states the band before acceptance whenever an acceptance matched (ADR 0040). This partly answers the negative about untriaged findings, for findings of the clone only, since alerts are still dismissed on GitHub.
