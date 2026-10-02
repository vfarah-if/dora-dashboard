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
