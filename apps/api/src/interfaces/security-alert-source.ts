import type { RepoPosture, SecurityAlert } from "@dora-dashboard/core";

/**
 * What reading one alert source came to. `off` means the host says the feature is not switched on or not licensed for
 * this repository; `no_access` means the credential may not see the alerts, or the host does not say which. Both are
 * answers, not failures, so the crawl records them and carries on.
 */
export type AlertRead =
  | {
      status: "ok";
      alerts: SecurityAlert[];
      /** True when the host held more alerts than the page limit allowed, so the oldest updates were not read. */
      truncated: boolean;
      /** How many alerts were left out because they lacked a number, a creation time or a state this port knows. */
      skipped: number;
    }
  | { status: "off"; reason: "disabled" | "not_set_up" | "needs_advanced_security" }
  | { status: "no_access"; reason: "forbidden" | "admin_only_or_off" };

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
 *   is the one the host published. Alerts missing a number or a creation time are skipped, and a read that skipped
 *   one is still `ok`.
 * - Nothing that names a person is mapped (dismissers, resolvers, assignees, bypassers), and no free text a person
 *   wrote (dismissal comments, rule help, advisory descriptions). The secret value of a secret scanning alert is
 *   never requested, mapped or returned.
 * - `posture` reads the deploy branch's protection and the repository's security settings. Each sub-read is
 *   independent: a 403 or 404 leaves that part null. A rejected credential and a rate limit raise, as above.
 * - `settingsUrl` is a page on the host a person can open to switch features on. It makes no request.
 */
export interface SecurityAlertSource {
  readonly kind: string;
  dependencyAlerts(token: string, owner: string, name: string): Promise<AlertRead>;
  codeAlerts(token: string, owner: string, name: string): Promise<AlertRead>;
  secretAlerts(token: string, owner: string, name: string): Promise<AlertRead>;
  posture(token: string, owner: string, name: string, branch: string): Promise<RepoPosture>;
  settingsUrl(owner: string, name: string): string;
}
