# 19. Fall back to the GitHub device flow when the CLI login is missing

Date: 2026-10-02

## Status

Accepted

## Context

The default `gh-cli` mode of ADR 0004 needs the GitHub CLI installed and signed in. When it is not, the web app can only tell the person to run `gh auth login`, which stops anyone without the CLI, or anyone who does not use a terminal, from getting in. The `oauth` mode is no answer for people running their own copy of an open source tool, because each copy would need its own OAuth App and a client secret, and a secret cannot be published in the repository.

## Decision

In `gh-cli` mode, when no CLI login is found, the web app offers "Sign in with GitHub" through the [OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

- **One published client ID.** The project registers a single OAuth App with device flow enabled. Its client ID is public and needs no secret, so it is published as `PUBLISHED_DEVICE_CLIENT_ID` in `apps/api/src/core/config.ts`, and `GITHUB_DEVICE_CLIENT_ID` in `.env` overrides it. Until the app is registered the constant is empty, and an empty value turns the fallback off, so the sign-in page looks as it did before.
- **A port, an adapter and a service.** `DeviceAuthorisation` in `apps/api/src/interfaces` starts a flow and polls it, and `GitHubDeviceFlow` in `apps/api/src/infrastructure/github` implements it against `github.com/login/device/code` and `github.com/login/oauth/access_token`, accepting only an `https` verification link. Only `main.ts` constructs it (ADR 0003). `DeviceSignInService` holds the pending sign-ins and their timing, so the routes only translate HTTP.
- **Two routes.** `POST /api/auth/device` returns the short user code, the verification link, the polling interval and the expiry. `POST /api/auth/device/poll` answers `pending`, `granted`, `expired` or `denied`. GitHub's `device_code` stays on the server, keyed by a random id in a signed, HTTP-only `dora_device` cookie, so the browser only ever sees the user code.
- **The server sets the pace.** A poll that arrives before the interval has passed is answered `pending` without calling GitHub, and a `slow_down` from GitHub raises the stored interval. Starting a sign-in is limited to one every two seconds and twenty waiting at once, beyond which the API answers 429 without calling GitHub. The three sign-in routes refuse a request whose `Origin` is not the web app's. Together these stop a busy tab, a script or another site from getting the shared client ID rate limited.
- **The same session as OAuth.** A granted flow looks up the account, retires any earlier session from the same browser, creates a session in the existing `SessionStore` and sets the `dora_sid` cookie for eight hours. In `gh-cli` mode the API checks that session first and then the CLI. `/api/auth/me` reports where the session came from (`cli`, `device` or `oauth`), so the web app offers "Sign out" only where signing out does something, and `/api/auth/logout` now works in both modes.
- **Same scopes and storage.** The flow asks for `repo read:org`, as the OAuth mode does, and the token is held in memory only and never sent to the browser (ADR 0004).
- **The terminal crawl is unchanged.** `make crawl` still uses the CLI login, because a browser session cannot reach a separate process.

Alternatives considered:

- **The usual browser redirect as the fallback.** It needs a client secret, so every person running a copy would have to register an app and keep a secret in `.env`, which is the barrier this decision removes.
- **Pasting a personal access token.** Nothing to register, but people would have to create a token by hand, choose its scopes correctly and handle a long-lived credential themselves.
- **Running `gh auth login` from the API.** It is interactive and expects a terminal, and the API would be installing or driving a tool on the person's behalf.

## Consequences

### Positive

- Once the client ID is published, someone who clones the repository can sign in from the browser with no CLI, no app registration and no secret.
- People who already use the CLI see no change, because the CLI login is still tried and nothing new is shown when it works.
- No credential enters the repository, since a device flow client ID is not a secret.

### Negative

- The project owner must register and keep the OAuth App, and every copy depends on it. If the app is deleted, or device flow is switched off on it, the fallback stops working until a new client ID is published or set in `.env`.
- The consent screen names the project's app rather than one the person registered, and an organisation that restricts OAuth Apps must approve it before members can read its private repositories.
- A device sign-in lasts eight hours and, like every session, is lost when the API restarts (ADR 0004). For those eight hours it takes precedence over the CLI in that browser, so someone who later runs `gh auth login` as another account keeps acting as the device account there until they sign out.
- A device code shown on screen can be approved by anyone who reads it within its expiry, so the user code is no more secret than the screen it is on. That is the accepted design of the device flow, and the code expires in about fifteen minutes.
