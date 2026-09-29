---
name: adr-format
description: >
  Architecture Decision Record format for this repository. Use when a significant decision has
  been made (a new dependency, a changed metric definition, a new external system, an auth or
  storage change, any trade-off a future reader will question) or when writing or editing a file
  in docs/architecture/decisions/.
---

# ADR format

An ADR says why the code is the way it is, so nobody has to guess. Short, specific, honest.

## When one is warranted

- A new runtime dependency or tool.
- A metric's definition changes, or a new metric is added.
- A new external system: code host, issue tracker, identity provider, store.
- Anything touching authentication, credentials or what the repository may publish.
- A trade-off with non-obvious reasoning.

Not for: a bug fix, a refactor that changes no behaviour, a copy change.

## Format

```markdown
# N. Title in sentence case

Date: YYYY-MM-DD

## Status

Accepted

## Context

The situation and the problem. Two or three sentences.

## Decision

What we decided, specifically. Name the library, the rule, the file.

## Consequences

### Positive

- What we gain

### Negative

- What we give up or accept
```

- File name `NNNN-title-in-kebab-case.md`, next number in sequence, never renumber.
- `Date:` plain text. Status is a section, not frontmatter.
- A Mermaid diagram when it explains structure better than prose (see ADR 0002).
- Honest negatives. An ADR with no real negative is usually hiding one.

## Changing a decision

- It evolves: append `## Revision History` with a dated entry saying what changed and why.
- It is reversed: write a new ADR, set the old one's status to `Superseded by NNNN`.

## Style

UK English. No em or en dashes. No "leverage", "holistic", "robust", "seamless". Active voice. One screen at most.

## After writing

1. `ls docs/architecture/decisions` to confirm the number is next and unique.
2. Link the ADR from the code it governs (a one-line comment naming `ADR NNNN`) where a reader would otherwise undo it.
3. If it changes a command, layout or rule, update `CLAUDE.md` in the same change.
