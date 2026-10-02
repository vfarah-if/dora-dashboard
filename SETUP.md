# Setting up the DORA Dashboard

This guide takes you from a fresh clone to a running dashboard, explains the three ways to sign in, and shows how to test the browser sign-in that is offered when the GitHub CLI is not signed in. The [README](README.md) explains what the dashboard measures and why.

## Before you start

| You need                                                          | Why                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Node 22.13 or later                                               | Runs the API and builds the web app                                          |
| `make` and `bash`                                                 | Every command goes through the Makefile; on Windows use WSL or Git Bash      |
| The [GitHub CLI](https://cli.github.com), signed in               | The default sign-in, and the only one the terminal crawl (`make crawl`) uses |
| `git` and [lizard](https://github.com/terryyin/lizard) (optional) | Code health figures; the README lists install commands for each platform     |

## First run

```bash
make all                                       # install, create .env, build, run every gate
cp repos.local.example.json repos.local.json   # list the repositories you want
make crawl-all                                 # crawl them into data/dora.sqlite
make dev                                       # API on :8787, web on http://localhost:5181
```

`make all` copies `.env.example` to `.env` the first time. Your `.env`, `repos.local.json` and the crawled data in `data/` are gitignored, so nothing you configure is published.

## Signing in

The dashboard never asks for a password, and the token it uses stays in the API's memory and is never sent to the browser (ADR 0004). Choose how it gets that token with `AUTH_MODE` in `.env`.

| Setting                                               | How you sign in                                                                                     | What you register                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AUTH_MODE=gh-cli` (the default)                      | Nothing to do once `gh auth login` has been run on the machine                                      | Nothing                                                          |
| `AUTH_MODE=gh-cli` with `GITHUB_DEVICE_CLIENT_ID` set | As above, and when the CLI is not signed in the page offers "Sign in with GitHub" with a short code | One OAuth App with device flow enabled, and no secret (ADR 0019) |
| `AUTH_MODE=oauth`                                     | "Sign in with GitHub" through the usual browser redirect                                            | An OAuth App with a client secret, kept in `.env`                |

The dashboard reads the repositories that the signed-in GitHub account can see. It does not read repositories on your disk or use your git credentials or SSH keys.

## Registering the app for the browser sign-in

You only need this for the device code sign-in, and only once. The client ID it gives you is not a secret, because the device flow uses no client secret.

1. On github.com open Settings, Developer settings, OAuth Apps, and choose New OAuth App. Register it under an organisation instead if the dashboard will read that organisation's private repositories, since an organisation that restricts OAuth Apps must approve it.
2. Set the Homepage URL to `http://localhost:5181`. The Authorisation callback URL is required by the form but not used by the device flow, so `http://localhost:5181` will do.
3. Tick **Enable Device Flow** and register the application.
4. Copy the **Client ID** into `.env`. You do not need to generate a client secret.

```bash
AUTH_MODE=gh-cli
GITHUB_DEVICE_CLIENT_ID=<your client id>
```

Leaving `GITHUB_DEVICE_CLIENT_ID` blank switches the browser sign-in off, and the sign-in page then only explains how to run `gh auth login`.

## Testing the browser sign-in locally

To see the fallback, the API has to believe the GitHub CLI is not signed in. Signing out of `gh` would do it but would also sign you out everywhere else, so instead put a stand-in `gh` that always fails at the front of the `PATH` for the API alone. Pointing `GH_CONFIG_DIR` at an empty folder is not enough on macOS, because `gh` can still find its token in the keychain.

```bash
# Terminal 1: the API, with the GitHub CLI hidden from it
mkdir -p /tmp/no-gh
printf '#!/bin/sh\necho "gh is hidden for this test" >&2\nexit 1\n' > /tmp/no-gh/gh
chmod +x /tmp/no-gh/gh
PATH="/tmp/no-gh:$PATH" make api
```

```bash
# Terminal 2: the web app
make web
```

Use `make api` and `make web` here rather than `make dev`, so the changed `PATH` reaches the API directly. If port 5181 or 8787 is already in use, stop the earlier servers first (`make dev-stop` stops those started with `make dev-bg`).

Then open http://localhost:5181 and work through these checks.

| Check                 | What you should see                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The sign-in page      | The usual `gh auth login` guidance, with a "Sign in with GitHub" button beneath it                                  |
| Start the sign-in     | A short code with a copy button, three numbered steps, a link to `github.com/login/device` and "Waiting for GitHub" |
| Approve it            | Open the link, enter the code and approve the app; the dashboard signs you in within a few seconds                  |
| The header            | "Sign out" appears, and choosing it returns you to the sign-in page                                                 |
| Decline instead       | Choose Cancel on GitHub; the page explains the sign-in was declined and offers "Try again"                          |
| Restart the API       | You are signed out, because sessions are held in memory                                                             |
| Light, dark and phone | The code and steps read clearly in both themes and at 375 pixels wide                                               |
| Your normal setup     | Stop both terminals and run `make dev`; the page signs straight in through `gh`, with no "Sign out" in the header   |

When you have finished, remove the stand-in with `rm -rf /tmp/no-gh`.

## Automated tests

```bash
make test                  # every suite, with GitHub replaced by fakes, so no network or client ID is needed
make test-coverage-force   # the same with coverage, uncached; every workspace must reach 90%
make quality               # everything CI runs
```

To run only the sign-in tests, use `cd apps/api && npx vitest run test/device-flow.test.ts` for the API and `cd apps/web && npx vitest run src/components/DeviceSignIn.test.tsx` for the web app.

## When something goes wrong

| What you see                                          | What to do                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No "Sign in with GitHub" button                       | Check that `AUTH_MODE` is `gh-cli`, that `GITHUB_DEVICE_CLIENT_ID` is set in `.env`, and restart the API        |
| The page signs straight in during the fallback test   | The API is still finding `gh`; start it again with the `PATH` shown above, through `make api`                   |
| GitHub says device flow is disabled                   | Tick Enable Device Flow on the OAuth App and save                                                               |
| "Too many sign-in attempts"                           | The API allows one new sign-in every two seconds and twenty waiting at once; wait a moment and choose Try again |
| Private repositories from an organisation are missing | An owner of that organisation must approve the OAuth App, or sign in through `gh` instead                       |
| `make crawl` fails with no browser sign-in            | The terminal crawl always uses the GitHub CLI; run `gh auth login`                                              |
| Code health is unavailable                            | Install `git` and lizard as the README describes, restart the API and crawl again, or set `CODE_ANALYSIS=off`   |
