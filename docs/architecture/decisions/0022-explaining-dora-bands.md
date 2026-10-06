# 22. Explaining DORA bands

Date: 2026-10-06

## Status

Accepted

## Context

The repository page grades each DORA measure as elite, high, medium or low against the DORA 2023 profile (ADR 0016), but it does not say what a band means, how far the team is from the next one, why the figure is what it is, or what might move it. A team that wants to use the figures to improve needs those answers, and it will only trust them if each one can be checked. Advice that reads as opinion, or that points at a person, would undo the fairness that ADR 0008 sets out to protect.

## Decision

1. **Every statement is computed or cited, never opinion.** Each DORA tile gains a disclosure, "Why this band, and how to move up", with four parts. What the band means is cited from the 2023 Accelerate State of DevOps Report. The gap to the next band is computed from the profile. Why the figure is what it is comes from the team's own data. Practices to try are DORA capabilities, each linked to its page on dora.dev. The figures come from `doraDrivers` and `doraBandPosition` in `packages/core/src/doraDrivers.ts`, built in `buildReport` over the same range and filters as `doraSummary`, so an explanation always agrees with its tile. The sentences and the mapping below live in `apps/web/src/lib/doraExplain.ts`, and the wording, band meanings and practice links live in `apps/web/src/copy.ts` under `dora.explain`.

2. **The gap follows the same comparisons as the grade.** `doraBandPosition` returns the band, the next band up, its threshold and the gap, all in the measure's unit, and null for the last three at elite.

   | Measure              | In a band when       | Gap to the next band | Unit           |
   | -------------------- | -------------------- | -------------------- | -------------- |
   | Deployment frequency | `value >= threshold` | `threshold - value`  | deploys a week |
   | Change failure rate  | `value <= threshold` | `value - threshold`  | rate, 0 to 1   |
   | Lead time            | `value < threshold`  | `value - threshold`  | hours          |
   | Time to restore      | `value < threshold`  | `value - threshold`  | hours          |

   Frequency and failure rate include their limit, so reaching the threshold is enough. The durations are strict, so the value must fall below the threshold, and a gap of zero means the value sits exactly on it. At elite the explanation says how far inside the elite threshold the value is.

3. **Drivers are found by fixed rules.** Every measured figure states its drivers, the largest first, at every band, so an elite figure says why it holds. Practices and the review quote are offered only below elite.
   - **Lead time.** The mean lead time is split into coding, waiting for review, in review, approval to merge, and merge to deploy. These are means, so they add up (ADR 0006). Draft time, from opening the pull request to marking it ready for review, counts as coding, so waiting for review starts where time to first review does and a long draft does not make review the driver. The cycle time stage chart keeps its own split. The largest part names the driver: any of the three review parts is "waiting for review", coding is "coding time", and merge to deploy is "merge to deploy". On a tie the earlier part in the flow comes first. The 75th percentile and the median size of the shipped pull requests are given beside it.
   - **Deployment frequency.** The driver is "few deploys", stated first as the tile's own deploys and weeks (every week the range touches, partial ones included), so the tile can be reproduced, then as the complete weeks with none. A week is complete only when it lies wholly inside the range at both ends. When the median number of pull requests shipped per deploy is above one, "large batches per deploy" is added.
   - **Change failure rate.** The driver is "high change failure rate", stated as failed and total runs, the workflow with the most failures, and the share of deploys that shipped a revert or hotfix.
   - **Time to restore.** The driver is "slow restore", stated as the number of recovered failure streaks, the median failed runs per streak, and the longest restore. A failure streak with no success after it yet is reported first, because the median only sees streaks that recovered. When nothing has recovered the tile is not measured, and its reason gives the date the open streak began and its failed runs.

4. **Each driver maps to DORA capabilities.** At most three practices are shown, in this order, with repeats removed. DORA has no capability page for code review, so the review driver also quotes the 2023 report's finding that teams with faster code reviews have 50% higher software delivery performance.

   | Driver                          | Practices to try                                                                    |
   | ------------------------------- | ----------------------------------------------------------------------------------- |
   | Waiting for review              | Streamlining change approval; working in small batches; trunk-based development     |
   | Coding time                     | Working in small batches; trunk-based development                                   |
   | Merge to deploy, or few deploys | Deployment automation; continuous delivery                                          |
   | Large batches per deploy        | Working in small batches; continuous integration                                    |
   | High change failure rate        | Test automation; continuous integration; code maintainability                       |
   | Slow restore                    | Monitoring and observability; proactive failure notification; deployment automation |

5. **Explanations describe the system of work, never people.** No explanation names an author, reviewer or approver, and a driver is a stage, a batch or a workflow. This follows ADR 0008 and DORA's own position that "software delivery performance is not an individual measure" (https://dora.dev/guides/how-to-empower-software-delivery-teams/). Authors left out of a report (ADR 0012) stay out of its explanation.

6. **We keep the measure's label.** DORA's 2023 report renamed the restore measure "failed deployment recovery time". The tile keeps the label "Time to restore", and its explanation gives the DORA name once so a reader can find it in the report.

7. **Rejected alternatives.** Generic advice without data was rejected because it gives every team the same text and cannot say which constraint matters, while DORA's 2023 report warns that faster reviews will not help a team constrained elsewhere. An AI-written narrative was rejected because it cannot be reproduced or tested with hand-computed expectations, it can invent a figure or a cause, and it would send private repository data to a new external system. Per-person coaching was rejected because it breaks ADR 0008 and measures something DORA says cannot be measured for an individual.

## Consequences

### Positive

- Every sentence can be traced to a computed figure or a cited page, so the explanation survives a sceptical reader.
- Explanations agree with their tiles, and each rule has a test with hand-computed expectations.
- The disclosure prints in the PDF, so a shared report carries its reasoning.

### Negative

- The lead time parts are means while the tile shows a median, so the parts add up to a figure that differs from the tile; the explanation has to say so.
- The driver rules and the mapping are our reading of DORA's pages, not a DORA algorithm, and the links depend on dora.dev keeping its addresses. They were checked on the date above.
- Deployment frequency below elite always counts as "few deploys", so a high band team still sees practices for it.
- Band meanings and practice summaries are copied into `copy.ts` by hand and can drift from the sources, as the bands table already can (ADR 0016).
- Change failure and restore come from deploy workflow runs, which are proxies for DORA's failures that need immediate intervention, so a failed run that never reached users still counts.
