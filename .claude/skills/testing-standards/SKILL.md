---
name: testing-standards
description: >
  How tests are written here, across core, API and web. Use when writing or reviewing tests,
  raising coverage, or when a change needs proving.
---

# Testing standards

## Principles

- **Test behaviour through the public surface.** Core through its exported functions, the API through `app.inject` or a service, the web app through what a user sees and presses.
- **Hand-compute expectations.** A metric test states the answer a person worked out, with the arithmetic in a comment when it is not obvious. Never assert against the output of the code under test.
- **No network, ever.** The API tests use `FakeProvider`, `FakeCli` and `SqliteRepoStore(":memory:")` from `apps/api/test/fakes.ts`. The web tests stub `fetch`.
- **Name the behaviour**, not the method: "stops at the first page holding nothing newer", not "test crawl 2".
- **One reason to fail per test** where practical; `it.each` for tables of inputs.

## Where tests live

| Workspace       | Folder                          |
| --------------- | ------------------------------- |
| `packages/core` | `test/`                         |
| `apps/api`      | `test/`                         |
| `apps/web`      | beside the code, `*.test.ts(x)` |

Every workspace has the same floor: 90% lines, branches, functions and statements (ADR 0018).

## Traps

- `toHaveBeenCalledWith` ignores keys whose value is `undefined`, so it cannot prove a key is absent. Use an `in` check.
- A background crawl started by a route finishes after the response. Use `settled()` from the fakes before asserting on stored data.
- Turbo replays a cached run's output, including its test counts. Quote figures only from `make test-coverage-force`.
- Mutation-test a new assertion once: break the code, watch the test fail, restore it.

## Tests about how work grows

A test about how work grows must never hold a run to a wall-clock budget, such as finishing within two seconds. It compares two sizes of input with `growth` and `PROPORTIONAL` from `packages/core/test/growth.ts`. `growth(work, small, large)` returns how many times the CPU time of the small input the large one took, using the least of five alternating runs of each, and `PROPORTIONAL` is the most it may return for an input four times the size when the work grows in proportion to it. Work that reads again what it has already read grows with the square of the input, takes about sixteen times as long for that input and fails.

CI runs every workspace's suite at once on a 4 vCPU runner under coverage, where a run took about ten times as long as it does locally, so a fixed budget passed locally and failed there (PR 27). A ratio cancels out the speed of the machine, CPU time leaves out the time a process spends waiting for a core while other suites run, and the least of five runs leaves out a pause that happens to land on one of them.

Mutation-test the check against the fault it guards, by putting the slow code back (a queue drained with `shift()` is an example) and watching the test fail before restoring it, because a growth test that cannot fail proves nothing. Choose sizes so that the linear code runs for at least about a millisecond of CPU time, since CPU time is counted in microseconds and a run shorter than that is mostly noise, while a quadratic regression still fails within seconds and does not hang CI, because vitest cannot interrupt synchronous work. When a single input long enough to time would leave the slow version too slow to watch fail, repeat it instead, such as 1,000 ids in one input or 4,000 Makefile lines of 200 and 800 spaces, and grow only the length the fault depends on. Where even that is too slow, hold the total length fixed and change only the length of each run, as the API's `parseRepoRef` test does with 8,000 runs of 250 slashes against 2,000 runs of 1,000. Work in proportion to the total then takes about as long for both, giving a ratio near 1, and work that grows with the square of each run takes about four times as long, so that test asserts a ratio below 2.5 and not `PROPORTIONAL`, which assumes an input four times the size.
