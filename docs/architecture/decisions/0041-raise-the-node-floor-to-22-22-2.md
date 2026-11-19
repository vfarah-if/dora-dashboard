# 41. Raise the Node floor to 22.22.2

Date: 2026-11-19

## Status

Accepted

## Context

`engines` in `package.json` admitted Node 22.13, the version `node:sqlite` needs (ADR 0005), and the lowest CI job ran on 22.13 (ADR 0018). The dependencies had already moved past it. react-router 8.5.1 in the web app needs Node 22.22.0, `@babel/parser` and `@babel/types` 8.1 in the API need 22.18.0, and jsdom 30, undici 8 and npm-check-updates 23.1.0 need 22.19.0 or 22.22.2. npm only warns when `engines` is not met, so the 22.13 job kept passing until jsdom 30.1.3 brought in undici 8.12, which calls `zlib.createZstdDecompress` as it loads. Node added that function in 22.15, so on 22.13 every web test file failed to start and the web coverage read 0%.

## Decision

- `engines.node` in `package.json` is `^22.22.2 || ^24.15.0 || >=26.0.0`. It is the range jsdom 30.1.3 declares, and every package in the lock file accepts it.
- The lowest CI job in `.github/workflows/ci.yml` runs on Node 22.22.2, so CI still tests the lowest version `engines` allows, and the second job stays on the newest Node 24.
- `README.md` and `SETUP.md` state the same floor.
- No package is held back or overridden to keep an older Node working. Holding jsdom at 30.1.2 would not have helped, because it and undici 8.11 already declared a newer Node than 22.13.

## Consequences

### Positive

- `engines` and CI describe a Node that every dependency supports, rather than one that worked only because nothing yet called a newer API as it loaded.
- The Babel 8 packages the API already uses now sit inside the range `engines` admits, and npm-check-updates could be installed as a devDependency without a warning on every install (ADR 0024).

### Negative

- Anyone on Node 22 below 22.22.2, Node 24 below 24.15.0, or Node 25 has to upgrade before running the dashboard. npm warns rather than refuses, so the warning on install, or a failure like this one, is what tells them.
- The floor follows the strictest dependency, so a future release of one of them can raise it again, and CI is where that will be found.
- CI tests the lowest Node 22 and the newest Node 24, not 24.15.0 itself, so a dependency that breaks only on an early Node 24 release would not be caught.
