# 8. Comparisons are designed to be fair

Date: 2026-09-29

## Status

Accepted

## Context

The compare page exists to put two repositories side by side, often to argue that one way of working beats another. A comparison that ignores team size, project age or review practice is easy to dismiss, and one that names individuals turns a conversation about process into one about people.

## Decision

The compare page:

- offers **Align to project start**, putting week N of each project on the same axis and clipping to the shorter history;
- offers **Per contributor**, dividing throughput by the people active that week;
- splits time to merge into **reviewed** and **unreviewed** pull requests, because a solo author waits for nobody;
- normalises the time-to-merge distribution to shares, so repositories of different sizes compare;
- keeps a **Reading this fairly** panel on screen stating these caveats;
- hides per-person figures behind a **Show people** toggle that is off by default.

## Consequences

### Positive

- The comparison survives the first sceptical question from the audience it is shown to.
- The default view discusses process, not individuals.

### Negative

- More controls, and a reader who switches every normalisation off can still build an unfair chart. The panel says what each control is for; it does not enforce anything.
