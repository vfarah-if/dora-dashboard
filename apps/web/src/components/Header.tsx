import { NavLink, useMatch } from "react-router";
import type { AuthState } from "../api/hooks";
import { useHealth, useLogout, useRepos } from "../api/hooks";
import { copy } from "../copy";
import { hasIssues } from "../lib/issues";
import { useTheme } from "../lib/theme";

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? copy.theme.toLight : copy.theme.toDark;
  return (
    <button type="button" className="icon-button" onClick={toggle} aria-label={label} title={label}>
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/**
 * The link to the GitHub Issues page, offered only when some repository has issues or a failed read of them. It sits
 * inside the signed-in nav because the repositories list needs a session.
 */
function IssuesNavLink() {
  const repos = useRepos();
  if (!repos.data || !hasIssues(repos.data)) return null;
  return <NavLink to="/issues">{copy.nav.issues}</NavLink>;
}

/** True on the code analysis page of any repository, which belongs to the Code analysis tab. */
function useOnCodePage(): boolean {
  return useMatch("/repos/:id/code") !== null;
}

/**
 * The Repositories tab covers the repository pages but not the code analysis page of a repository, which belongs to
 * the Code analysis tab. Otherwise two tabs would be lit at once.
 */
function RepositoriesNavLink() {
  const onCodePage = useOnCodePage();
  return (
    <NavLink to="/repos" className={({ isActive }) => (isActive && !onCodePage ? "active" : undefined)}>
      {copy.nav.repositories}
    </NavLink>
  );
}

/** Lit on the list at /code and on the code analysis page of any repository. */
function CodeAnalysisNavLink() {
  const onCodePage = useOnCodePage();
  return (
    <NavLink to="/code" className={({ isActive }) => (isActive || onCodePage ? "active" : undefined)}>
      {copy.nav.codeAnalysis}
    </NavLink>
  );
}

/** Sign out applies to browser sign-ins only. A CLI session belongs to the machine, not the page. */
const canSignOut = (auth: AuthState | undefined) =>
  auth?.source ? auth.source === "device" || auth.source === "oauth" : auth?.mode === "oauth";

export function Header({ auth }: { auth: AuthState | undefined }) {
  const logout = useLogout();
  const jira = useHealth().data?.jira === true;
  const user = auth?.user ?? null;
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <NavLink to="/" className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="3" y="12" width="4" height="9" rx="1.5" fill="var(--series-1)" />
            <rect x="10" y="7" width="4" height="14" rx="1.5" fill="var(--series-3)" />
            <rect x="17" y="3" width="4" height="18" rx="1.5" fill="var(--series-2)" />
          </svg>
          <span>{copy.appName}</span>
        </NavLink>
        {user && (
          <nav aria-label={copy.nav.label} className="app-nav">
            <NavLink to="/" end>
              {copy.nav.home}
            </NavLink>
            <RepositoriesNavLink />
            <CodeAnalysisNavLink />
            {jira && <NavLink to="/spaces">{copy.nav.jira}</NavLink>}
            <IssuesNavLink />
            <NavLink to="/review-queue">{copy.nav.reviewQueue}</NavLink>
          </nav>
        )}
        <div className="app-header-actions">
          {user && (
            <span className="user-chip" title={copy.auth.signedInAs(user.login)}>
              {user.avatarUrl && <img src={user.avatarUrl} alt={copy.auth.avatarAlt(user.login)} width="24" height="24" />}
              <span className="user-login">{user.login}</span>
            </span>
          )}
          <ThemeToggle />
          {user && canSignOut(auth) && (
            <button type="button" className="button button-ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
              {copy.auth.signOut}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
