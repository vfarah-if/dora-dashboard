# 1. Record architecture decisions

Date: 2026-09-29

## Status

Accepted

## Context

This project is meant to be extended by people who were not in the room when it was built. A reader should be able to find out why the code is the way it is without asking.

## Decision

We record every significant decision as an Architecture Decision Record in `docs/architecture/decisions/`, in the Nygard format described by the `adr-format` skill. Records are numbered in sequence and never renumbered. A decision that changes gains a dated `## Revision History` entry; a decision that is reversed is superseded by a new record that says so.

## Consequences

### Positive

- The reasoning behind a surprising choice is one search away.
- Claude Code and human contributors read the same record, so an agent does not undo a decision it cannot see.

### Negative

- Writing a record costs a few minutes on every significant change, and a stale record misleads. The `documentation` agent exists to keep them current.
