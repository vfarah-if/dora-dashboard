---
name: frontend-standards
description: >
  House rules for apps/web: React, charts, copy, tokens, accessibility. Use when creating or editing
  any .tsx or .ts file in apps/web, adding a chart, or changing styles.
---

# Frontend standards

## Structure

- Pages in `src/pages`, components in `src/components`, data hooks in `src/api/hooks.ts`, pure transforms in `src/lib`.
- Anything that reshapes report data for a chart (aligning, clipping, normalising, cumulating) is a pure function in `src/lib` with a unit test. Components render; they do not compute.
- Types come from `@dora-dashboard/core` with `import type`. Never redefine a payload shape in the web app.

## Copy

- Every user-facing string lives in `src/copy.ts`. UK English, no em or en dashes, sentence case.
- Say what a figure means next to it. Every chart has a title and a one-sentence subtitle.

## Colour and theme

- Colours are custom properties in `src/styles/tokens.css` only, with separate light and dark values. A hex value anywhere else is a defect.
- Series colours (`--series-1` to `--series-4`) follow the repository, never its rank; a filter must not repaint the survivors.
- Band colours (elite, high, medium, low) are status tokens, never reused as a series, and always shown with a text label so band is never colour alone.

## Charts

- One y-axis per chart. Two measures on different scales are two charts.
- A legend whenever there are two or more series, plus direct labels where there are four or fewer.
- Every chart has a hover tooltip and a "View as table" disclosure with the same data.
- Durations go through the one formatter in `src/lib/format.ts`.
- Comparisons follow ADR 0008: per-person views are off by default; the fairness panel stays on screen.

## Accessibility

- Visible keyboard focus everywhere; every control reachable by keyboard.
- Text contrast at least 4.5:1 in both themes.
- Works at 375px wide with no horizontal page scroll.

## Checks

`npm run typecheck -w @dora-dashboard/web`, `npm run test:coverage -w @dora-dashboard/web` (80% lines), then look at it in both themes.
