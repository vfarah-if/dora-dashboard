import type { AlertOf, AlertSource, NoAccessReason, OffReason, RepoPosture } from "@dora-dashboard/core";

/**
 * What reading one alert source came to. `off` means the host says the feature is not switched on or not licensed for
 * this repository; `no_access` means the credential may not see the alerts, or the host does not say which. Both are
 * answers, not failures, so the crawl records them and carries on.
 */
export type AlertRead<S extends AlertSource = AlertSource> =
  | {
      status: "ok";
      alerts: AlertOf<S>[];
      /**
       * True when the read stopped before the end of the list, at the page limit or at a next page that could not be
       * followed, so the least recently updated alerts were not read.
       */
      truncated: boolean;
      /** How many alerts were left out because they lacked a number, a creation time or a state this port knows. */
      skipped: number;
      /**
       * The keys of the skipped alerts that had a number, so the caller can leave what it stores for them as it is. An
       * alert that has no number cannot be named, which is why a read that skipped one cannot prune.
       */
      skippedKeys: string[];
    }
  | { status: "off"; reason: OffReason }
  | { status: "no_access"; reason: NoAccessReason };

/**
 * The security alerts a code host raises, and the repository settings that explain them (ADR 0031). They are read
 * with the token the crawl already holds, so this is a port of its own and not part of `SourceProvider`.
 *
 * Contract every implementation must honour, because the security crawl relies on it:
 * - Each alert read answers `AlertRead`. A feature that is switched off, or an alert list the credential may not see,
 *   is an answer and never raises. A rejected credential raises `UnauthorisedError`. A rate limit, a refusal the
 *   adapter cannot classify (for example a single sign-on block) and any other failure raise `UpstreamError`, so an
 *   outage is never recorded as "off". No message carries the token.
 * - Alerts are mapped onto core's `SecurityAlert`. States map as core documents: open, fixed and dismissed. Severity
 *   is the one the host published. Alerts missing a number or a creation time, or with a state this port does not know,
 *   are skipped and counted, and a read that skipped one is still `ok`.
 * - Nothing that names a person is mapped (dismissers, resolvers, assignees, bypassers), and no free text a person
 *   wrote (dismissal comments, rule help, advisory descriptions). The secret value of a secret scanning alert is
 *   never requested, mapped or returned.
 * - `posture` reads the deploy branch's protection and the repository's security settings. Each sub-read is
 *   independent: a refusal that says this credential may not see the part leaves it null, and so does a 404 from an
 *   endpoint only an administrator, or a plan that has the feature, can read. A host answer that classic protection
 *   does not exist for the branch means the branch is known to be unprotected, which is not the same as null. Private
 *   vulnerability reporting and the repository's advisories are read only for a public repository, and the advisories
 *   only when the credential is an administrator's, because the host leaves draft and triage advisories out of the list
 *   for anyone else and a count without them would read as none waiting; `advisories` is null otherwise. A rejected
 *   credential and a rate limit raise, as above, and so does any other refusal, and a missing repository or deploy
 *   branch, so the crawl keeps the earlier posture and never saves one made of nulls.
 * - `settingsUrl` is a page on the host a person can open to switch features on. It makes no request.
 */
export interface SecurityAlertSource {
  readonly kind: string;
  dependencyAlerts(token: string, owner: string, name: string): Promise<AlertRead<"dependabot">>;
  codeAlerts(token: string, owner: string, name: string): Promise<AlertRead<"code_scanning">>;
  secretAlerts(token: string, owner: string, name: string): Promise<AlertRead<"secret_scanning">>;
  posture(token: string, owner: string, name: string, branch: string): Promise<RepoPosture>;
  settingsUrl(owner: string, name: string): string;
}
