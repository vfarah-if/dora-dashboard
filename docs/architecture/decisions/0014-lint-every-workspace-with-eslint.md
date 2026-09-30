# 14. Lint every workspace with ESLint

Date: 2026-09-30

## Status

Accepted

## Context

The repository had Prettier for layout and `tsc` for types, but no linter. The code health grade of ADR 0013 rightly reported this about the dashboard itself, since a formatter and a compiler do not catch unused variables, misuse of React hooks, or errors rethrown without their cause. The quality gate and CI therefore had no check between formatting and types.

## Decision

- **ESLint 10 with a single flat config** in `eslint.config.js` at the root, covering core, API, web and scripts. It uses `@eslint/js` recommended rules, `typescript-eslint` recommended rules (without type information, to keep it fast), `eslint-plugin-react-hooks` for `apps/web`, and `globals` for Node and browser environments.
- **Prettier stays in charge of layout.** `eslint-config-prettier` is applied last and turns off every stylistic rule, so the two tools never disagree.
- **Unused names may start with an underscore.** This keeps deliberately ignored arguments legible without disabling the rule.
- **One gate, run from the root.** `make lint` runs `eslint . --max-warnings 0` and is part of `make quality` and the CI workflow, in the same way as `make fmt-check`. It is not a turbo task, because a single config over the whole tree is quicker than one process per workspace.
- **Claude Code lints as it edits.** A `PostToolUse` hook in `.claude/settings.json` runs `.claude/hooks/lint-edited-file.sh` on each file Claude writes or edits and hands any findings back so they are fixed in the same turn.
- **Inline suppressions carry a reason**, written after `--` in the directive, as in the control character pattern in `repo-ref.ts`.

## Consequences

### Positive

- The dashboard now passes all four hygiene checks of its own code health grade.
- Mistakes such as stale React hook dependencies and dropped error causes fail the build rather than reaching review.
- Code written through Claude Code is linted file by file, so problems surface before `make quality` runs.

### Negative

- Six new development dependencies to keep up to date.
- Rules that need type information, such as floating promise checks, are left out for speed. Turning them on later means a `parserOptions.projectService` block and a slower run.
- The hook only covers edits made through Claude Code. Edits made by hand are caught by `make lint` and CI, not as they are typed, unless the editor's own ESLint extension is installed.
