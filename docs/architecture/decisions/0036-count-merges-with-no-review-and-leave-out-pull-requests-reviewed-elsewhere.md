# 36. Count merges with no review and leave out pull requests reviewed elsewhere

Date: 2026-10-12

## Status

Accepted

## Context

ADR 0033 graded change control partly on the share of merged pull requests with no approval from another person. On a real repository the security page graded medium because 139 of 151 merges lacked such an approval, and the team regarded this as a false positive. Their teams review with Claude, which either leaves no trace on GitHub or posts its review under the pull request author's own account, where it appears as a `COMMENTED` review by the author and cannot be told from the author commenting on their own work. Some pull requests are syncs that copy code which was already reviewed in another repository, and these need no second review.

Measured on that repository, the 139 merges without another person's approval were made up of 20 syncs, 56 pull requests with a review posted under the author's account, 4 with another person's review that was not an approval, and 59 with no review of any kind. Only the last group says anything about review habits, and even that group may include reviews done outside GitHub. A security grade built on the whole 139 therefore described review habits that GitHub's data cannot show, and it presented them as a security problem.

## Decision

**Review leaves the security report.** The `unapprovedMerges` check, the `require_review` action, the review fields of the report and of its thresholds, and the grade's review input are removed (ADR 0033, revision of 2026-10-12). Change control is measured when the branch was read, and it keeps the unprotected branch and force push checks. For the same reason the security advice no longer offers to require approvals, dismiss stale approvals, require code owner review or add a `CODEOWNERS` file, and the branch card no longer shows those rules.

**A refined figure beside the other delivery figures.** The repository page shows **Merged with no review** with the Flow tiles. A merged pull request, in the scope the delivery report already uses, counts when no account that is not a bot, its own author included, submitted a review on it (any state but pending, at or before the merge) and it is not exempt. `RepoReport.totals` carries `unreviewedCount`, `unreviewedShare` (over merged pull requests that are not exempt) and `exemptCount`. The existing `reviewedShare` and `selfMergedShare` keep their definitions. The rules are pure functions in `packages/core/src/reviewExemptions.ts`.

**Reviewed elsewhere, by title word and by label.** A pull request is exempt when its title holds one of the repository's title words as a whole word, compared without regard to letter case and with punctuation treated as a break between words, or when it carries one of the repository's labels, compared without regard to letter case. The defaults are `sync`, `synced`, `syncing`, `synchronise`, `synchronised`, `synchronize`, `synchronized`, `syncronise` and `syncronize` as title words, and `reviewed-elsewhere` as a label. No word or label supplied by a user is ever run as a pattern, as ADR 0028 requires of issue labels, and each list holds at most 30 entries of at most 100 characters. A title word must hold a letter or a digit, because titles are matched as whole words, so an entry such as `---` is refused with a 400 and not saved as an exemption that could never match.

**Editable for each repository.** The override is a nullable JSON column on the repository row, added by an idempotent migration in the store's `migrate()`, and it is exposed on `RepoListing` as `reviewExemptions`, which is `defaults`, an `override` with its rules, or `unreadable` when a saved value cannot be used (in which case the defaults apply until it is saved again). `PUT /api/repos/:id/review-exemptions` saves `{ exemptions: { titleWords, labels } | null }`, requires the same origin, refuses unknown fields and starts no crawl, and `null` restores the defaults. `GET /api/review-exemptions/defaults` gives the web the defaults and the limits. The report service passes the repository's rules into the delivery report, so the figure follows a change at once. A saved override replaces both lists, so a list left empty leaves nothing out of that kind, which differs from the issue label override and lets a team switch exemptions off.

## Consequences

### Positive

- The security grade no longer carries a figure that GitHub's data cannot support, so a team that reviews with Claude is not marked down for it.
- Review habits remain visible as a delivery figure, with the counts behind it and the number left out, so nothing is hidden.
- A team can say what reviewed elsewhere means for its own repository, and the figure changes at once without a crawl.
- On the repository that prompted this, the figure would count 59 of the 131 merges that were not syncs, about 45%, which is a more honest description of review habits than 139 of 151.

### Negative

- A sync word in a title can exempt a pull request that was not reviewed anywhere, because the dashboard cannot check the claim.
- A review posted by a tool under the author's account counts as a review, as does any self-comment, so the figure can understate how many pull requests had no human review.
- A review done entirely outside GitHub leaves no trace, so the figure still overstates the pull requests that were never looked at.
- The security page no longer warns about weak review habits, so a team that wants that signal has to read the Flow figure.
- An override with empty lists exempts nothing, so a person who clears both boxes by mistake sees the figure rise until they reset it.

## Revision History

- 2026-10-12: The listing carries one `reviewExemptions` state (`defaults`, `override` or `unreadable`) in place of a nullable value and an unreadable flag, and a title word with no letter or digit is refused.
