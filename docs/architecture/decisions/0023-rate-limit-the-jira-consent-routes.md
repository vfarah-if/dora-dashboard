# 23. Rate limit the Jira consent routes

Date: 2026-10-06

## Status

Accepted

## Context

`GET /api/auth/jira/start` redirects to Atlassian, and `GET /api/auth/jira/callback` exchanges the returned code for tokens with an outbound request to `auth.atlassian.com` (ADR 0020). Both do work on behalf of whoever calls them, and the callback spends a request to a third party each time. CodeQL raised `js/missing-rate-limiting` against the start route, because it reads the call that builds the consent URL as an authorisation step. The dashboard is self-hosted for a team, but its routes are still reachable by anything that can reach the port.

## Decision

The API depends on `@fastify/rate-limit` (^10.3.0), registered in `apps/api/src/app.ts` with `global: false`, so only routes that name a limit are limited. `GET /api/auth/jira/start` and `GET /api/auth/jira/callback` each allow 20 requests a minute per client IP address. Counters are held in memory by the process. The plugin's error builder returns a `RateLimitedError`. Because both consent routes are browser navigations, their route-level error handler (ADR 0020) turns it into a redirect to `/repos` with `jira=rate_limited`, and nothing answers raw JSON there. A route that opts in later and is not a navigation would answer a 429 with the usual error body, formatted by the app's error handler. The limit is declared once as `CONSENT_RATE_LIMIT` in `apps/api/src/routes/jira.ts`.

### Alternatives considered

- **A hand-rolled limiter, as the device sign-in service has.** It would add no dependency, but CodeQL does not recognise a custom limiter, so the alert would remain, and a second limiter would be a second thing to maintain.
- **Renaming or reshaping the call so that the heuristic no longer matches.** This would silence the alert without limiting anything, which is gaming the scanner and not a fix.

## Consequences

### Positive

- The outbound token exchange cannot be driven at an unbounded rate through the callback.
- The CodeQL alert is answered by a control the scanner recognises, and other routes can opt in with one line of route configuration.

### Negative

- A new runtime dependency to keep updated.
- Counters live in process memory, so a restart clears them and several processes would each allow 20 a minute.
- Requests are keyed by IP address. Behind a reverse proxy every request appears to come from the proxy, so everyone shares one allowance unless Fastify's `trustProxy` is set. `trustProxy` is not set today, so a deployment behind a proxy should set it before relying on the limit.
- Unauthenticated requests count as well, because the limit is applied before the session check, so a caller without a session can use up the allowance of a shared address.
