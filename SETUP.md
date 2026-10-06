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

## Connect Jira

Jira Cloud is optional. When it is connected, issues from the Jira spaces you choose are read beside a repository's pull requests and joined to them by issue key (such as `WID-12`) in the pull request title or branch name. The dashboard reaches Jira through OAuth 2.0 (3LO), so each deployment registers its own Atlassian app once (ADR 0020). Until that app's client ID and secret are in `.env`, Jira is switched off and the dashboard behaves exactly as it does without it.

### Register the Atlassian app

1. Open the developer console at <https://developer.atlassian.com/console/myapps/> and sign in with the Atlassian account you use for Jira. The console is a separate site; the settings cog inside Jira does not lead to it.
2. Choose **Create**, then **OAuth 2.0 integration**. Give it a name that says what it is for, such as "DORA dashboard".
3. For **Access type** choose **Resource-level**, so the app reaches only the site picked on the consent screen. Account-level would also reach every other site in the same Atlassian organisation without asking, which the dashboard does not need. A client's own Jira lives in their Atlassian account, so neither option reaches it without its own consent.
4. Agree to the developer terms and choose **Create**. The notice about rotating refresh tokens needs no action; the dashboard stores each new refresh token as Atlassian issues it.

### Give it permissions and a callback

1. In the app's left-hand menu open **Permissions**, choose **Add** beside **Jira API**, then **Configure**. Add the classic scopes `read:jira-work` and `read:jira-user`, and the granular scopes `read:board-scope:jira-software`, `read:board-scope.admin:jira-software` and `read:project:jira`. If the board scopes are not listed there, add the **Jira Software API** in the same way and find them under it. Without the admin board scope a space's board columns read as empty rather than failing. The `offline_access` scope is requested when you connect and needs no tick.
2. Open **Authorization**, choose **Add** beside **OAuth 2.0 (3LO)** and set the callback URL to exactly `http://localhost:5181/api/auth/jira/callback`, then save. This is the web address, which forwards `/api` to the API in the same way as the GitHub callback. In another deployment use the address the dashboard is served from, and set `ATLASSIAN_REDIRECT_URI` to match.
3. Leave **Distribution** on **Not sharing**. An unshared app can still be used by its owner, which is all a local dashboard needs. Sharing asks for vendor details and a personal data declaration, and the honest answer to "Does your app store personal data?" is Yes, because the crawl keeps each issue's assignee account ID and each space's assignee display names. Answering Yes commits you to polling Atlassian's personal data reporting API, which the dashboard does not yet do, so a teammate who needs Jira should register their own app instead.

### Add the credentials

Open **Settings** in the app's menu and copy the **Client ID** and **Secret** from Authentication details into `.env` in the repository root. Use `.env`, which is gitignored, and never `.env.example`, which is committed. Treat the secret as a password.

```bash
ATLASSIAN_CLIENT_ID=<your client id>
ATLASSIAN_CLIENT_SECRET=<your client secret>
```

`ATLASSIAN_REDIRECT_URI` defaults to `WEB_ORIGIN` followed by `/api/auth/jira/callback`, which is the callback above, and is needed only when Atlassian holds a different address. Set both credentials or neither; the API stops at start-up if only one is set. Restart `make dev`; the API's start-up line includes `jira on` when both values were read, and `jira off` otherwise.

### Connect and choose spaces

1. Open `http://localhost:5181/repos` and choose **Configure deploy** on a repository. The Jira spaces panel sits under the deploy settings.
2. Choose **Connect Jira**, pick your site on Atlassian's consent screen and allow access. You return to the same page.
3. Choose the site (it is chosen for you when there is only one), then search for spaces by name or key and tick the ones whose work this repository delivers.
4. Before saving, open **How this space flows** and check that the board columns and statuses match the board your team uses. The dashboard reads the first board it finds in a space, so a space with several boards may show a different one.
5. Choose **Save links**. Each linked space is crawled straight away, and the panel shows its issue count and crawl status. **Re-crawl** reads what changed since the last crawl; **Full re-crawl** reads everything again and removes issues that no longer exist in the space.

A repository can link spaces on more than one site; saving on one site leaves the others untouched.

### After upgrading to the delivery page

The delivery measures need data that earlier crawls did not record, so after upgrading choose **Full re-crawl** on each linked space, which records issue levels and assignee names, and on each linked repository, which records the branch names used to join pull requests to issues. Until then, sub-tasks are told apart by type name and pull requests are joined by title only. The delivery page is at `/spaces`, reached through the **Jira** link in the header, and each space opens at `/spaces/:id` (ADR 0021).

### What to know

- The Jira grant is held in memory only, so after the API restarts, or after you sign out, choose **Connect Jira** again. The terminal crawl (`make crawl`) cannot read Jira.
- If Atlassian refuses to refresh the grant, or answers a request with 401, the grant is dropped and you connect again. If Atlassian is only unavailable or rate limiting, the grant is kept and the crawl reports the failure instead.
- Declining consent on Atlassian's screen returns you to the page with `jira=denied`, and any other failure returns with `jira=error` and a reason in the API log.
- The two consent routes, `/api/auth/jira/start` and `/api/auth/jira/callback`, allow 20 requests a minute from one client address (ADR 0023).
- Linked spaces and their crawled issues, including summaries, are visible to everyone signed in to this dashboard, even if their own Jira account cannot see that space.
- The dashboard reads the whole space, not one person's filtered view of a board.
- The assignee's account ID is stored on each issue, and display names are stored per space so that the delivery page can list them behind **Show people**. An email address is never read (ADR 0008, ADR 0020). An incremental crawl adds or updates names, and **Full re-crawl** replaces them, so names of people no longer assigned are dropped.
- Before the first real crawl, add your real site hostnames and space keys to `.private-names` so that `make check-names` keeps them out of the repository (ADR 0009). Examples and tests use `acme.example.test` and the space key `WID`.

## Automated tests

```bash
make test                  # every suite, with GitHub replaced by fakes, so no network or client ID is needed
make test-coverage-force   # the same with coverage, uncached; every workspace must reach 90%
make quality               # everything CI runs
```

To run only the sign-in tests, use `cd apps/api && npx vitest run test/device-flow.test.ts` for the API and `cd apps/web && npx vitest run src/components/DeviceSignIn.test.tsx` for the web app.

## When something goes wrong

| What you see                                          | What to do                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No "Sign in with GitHub" button                       | Check that `AUTH_MODE` is `gh-cli`, that `GITHUB_DEVICE_CLIENT_ID` is set in `.env`, and restart the API                  |
| The page signs straight in during the fallback test   | The API is still finding `gh`; start it again with the `PATH` shown above, through `make api`                             |
| GitHub says device flow is disabled                   | Tick Enable Device Flow on the OAuth App and save                                                                         |
| "Too many sign-in attempts"                           | The API allows one new sign-in every two seconds and twenty waiting at once; wait a moment and choose Try again           |
| Private repositories from an organisation are missing | An owner of that organisation must approve the OAuth App, or sign in through `gh` instead                                 |
| `make crawl` fails with no browser sign-in            | The terminal crawl always uses the GitHub CLI; run `gh auth login`                                                        |
| Code health is unavailable                            | Install `git` and lizard as the README describes, restart the API and crawl again, or set `CODE_ANALYSIS=off`             |
| No Jira panel under Configure deploy                  | The API printed `jira off`: put both `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` in `.env` and restart `make dev` |
| Atlassian reports a redirect or callback mismatch     | The callback URL on the app's Authorization page must be exactly `http://localhost:5181/api/auth/jira/callback`           |
| The consent screen says the app is blocked            | Your organisation's Atlassian admin restricts third-party apps and must allow this one                                    |
| "Connect Jira again"                                  | The API restarted, you signed out, or the refresh token lapsed after 90 days unused; connect again                        |
| A space shows no board columns                        | Add the `read:board-scope.admin:jira-software` scope and reconnect, or the space has no board                             |
| The columns differ from your board                    | The space has several boards and the first one was read; the statuses are still correct                                   |
| `make dev` says port 5181 or 8787 is in use           | An earlier `make dev` is still running; stop it in its terminal, or find it with `lsof -nP -iTCP:5181 -sTCP:LISTEN`       |
