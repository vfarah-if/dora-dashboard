---
name: doc-standards
description: >
  How documentation is written here: README, CLAUDE.md, docs/metrics.md, code comments and ADRs.
  Use when adding or changing any documentation, or deciding what to document after a change.
---

# Documentation standards

## Voice

- UK English: behaviour, colour, organisation, licence (noun), artefact.
- No em or en dashes. No consultancy speak. No AI filler ("it's worth noting", "comprehensive").
- Write for a developer who has the code open. Say what is true now; history belongs in git and ADR revision entries.

## Where things go

| Content                            | Home                            |
| ---------------------------------- | ------------------------------- |
| How to run, set up and contribute  | `README.md`                     |
| Rules and pointers for Claude Code | `CLAUDE.md`, kept to one screen |
| How a task is done (a playbook)    | a skill in `.claude/skills/`    |
| Why something is the way it is     | an ADR                          |
| What each figure on screen means   | `docs/metrics.md`               |
| Why this one line is surprising    | a code comment                  |

## CLAUDE.md discipline

`CLAUDE.md` is loaded into every session, so every line costs attention. Add a line only when Claude would otherwise get something wrong. When a rule needs more than two sentences, move it to a skill or ADR and leave a pointer. Never paste history, incident narratives or figures that go stale.

## Comments

Explain why, not what. A comment that restates the code is deleted. A comment that says "do not change this because" names the ADR or the test that proves it.

## Never write

- A private repository, company, client or person's name (ADR 0009).
- A credential, token or real email address, even as an example.
- A figure you did not just measure. Test counts and coverage come from `make test-coverage-force`, never from memory or a cached run.

## Verify

Every command in a doc was run. Every path exists. Every ADR number referenced exists.
