---
name: metric-change
description: >
  Procedure for adding a new metric or changing how an existing one is measured. Use when touching
  packages/core/src, docs/metrics.md, or when a figure on screen looks wrong.
---

# Changing a metric

A metric change alters what every chart says, so it is proved, documented and recorded together.

1. **State the rule in one sentence** before writing code: start event, end event, which items count, what happens at the edges (draft, unmerged, bot, rebased, missing data).
2. **Write the test first** in `packages/core/test/`, with hand-computed values and at least one edge case per clause of the rule.
3. **Implement in core as a pure function.** Inputs in, numbers out. No clock, no I/O.
4. **Check it against real data.** Crawl a repository you know (`make crawl repo=...`), then spot-check three items against the host's own view, for example `gh pr view <n> --json createdAt,mergedAt,reviews`.
5. **Look for artefacts.** An implausible median (weeks where you expect hours) usually means a window mismatch, not a slow team. ADR 0007 is the worked example.
6. **Document** the rule in `docs/metrics.md` and, if a definition changed, add an ADR or a revision entry to ADR 0006.
7. **Surface it** in the web app with a subtitle saying what it measures.
