import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useMatch } from "react-router";
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

interface LinkProps {
  onClick?: () => void;
}

/**
 * The link to the GitHub Issues page, offered only when some repository has issues or a failed read of them. It sits
 * inside the signed-in nav because the repositories list needs a session.
 */
function IssuesNavLink({ onClick }: LinkProps) {
  const repos = useRepos();
  if (!repos.data || !hasIssues(repos.data)) return null;
  return (
    <NavLink to="/issues" onClick={onClick}>
      {copy.nav.issues}
    </NavLink>
  );
}

/** Which sub page of a repository is open, or null on any other page. Each belongs to a tab of its own. */
export function useRepoSubpage(): "code" | "security" | null {
  const onCode = useMatch("/repos/:id/code") !== null;
  const onSecurity = useMatch("/repos/:id/security") !== null;
  if (onCode) return "code";
  return onSecurity ? "security" : null;
}

/**
 * The Repositories tab covers the repository pages but not the code analysis or security page of a repository, which
 * belong to their own tabs. Otherwise two tabs would be lit at once.
 */
function RepositoriesNavLink({ onClick }: LinkProps) {
  const subpage = useRepoSubpage();
  return (
    <NavLink to="/repos" onClick={onClick} className={({ isActive }) => (isActive && subpage === null ? "active" : undefined)}>
      {copy.nav.repositories}
    </NavLink>
  );
}

/** Lit on the list at /code and on the code analysis page of any repository. */
function CodeAnalysisNavLink({ onClick }: LinkProps) {
  const onCodePage = useRepoSubpage() === "code";
  return (
    <NavLink to="/code" onClick={onClick} className={({ isActive }) => (isActive || onCodePage ? "active" : undefined)}>
      {copy.nav.codeAnalysis}
    </NavLink>
  );
}

/** Lit on the list at /security and on the security page of any repository. */
function SecurityNavLink({ onClick }: LinkProps) {
  const onSecurityPage = useRepoSubpage() === "security";
  return (
    <NavLink to="/security" onClick={onClick} className={({ isActive }) => (isActive || onSecurityPage ? "active" : undefined)}>
      {copy.nav.security}
    </NavLink>
  );
}

/** The tabs, in one place so that the row and the menu at narrow widths always list the same pages. */
function NavItems({ jira, onNavigate }: { jira: boolean; onNavigate?: () => void }) {
  return (
    <>
      <NavLink to="/" end onClick={onNavigate}>
        {copy.nav.home}
      </NavLink>
      <RepositoriesNavLink onClick={onNavigate} />
      <CodeAnalysisNavLink onClick={onNavigate} />
      <SecurityNavLink onClick={onNavigate} />
      {jira && (
        <NavLink to="/spaces" onClick={onNavigate}>
          {copy.nav.jira}
        </NavLink>
      )}
      <IssuesNavLink onClick={onNavigate} />
      <NavLink to="/review-queue" onClick={onNavigate}>
        {copy.nav.reviewQueue}
      </NavLink>
    </>
  );
}

/**
 * Below 561px the row of tabs is hidden, so a button opens the same links as a list under the header. It closes when
 * a link is followed, when the page changes and when Escape is pressed, which returns focus to the button.
 */
function NavMenu({ jira }: { jira: boolean }) {
  // The menu is open for the page it was opened on, so going to another page closes it without an effect.
  const { pathname } = useLocation();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const button = useRef<HTMLButtonElement>(null);
  const setOpen = (value: boolean) => setOpenOn(value ? pathname : null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button nav-menu-button"
        aria-expanded={open}
        aria-controls="app-menu"
        aria-label={copy.nav.menu}
        title={copy.nav.menu}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <nav id="app-menu" aria-label={copy.nav.menuList} className="app-menu">
          <NavItems jira={jira} onNavigate={() => setOpen(false)} />
        </nav>
      )}
    </>
  );
}

/** Sign out applies to browser sign-ins only. A CLI session belongs to the machine, not the page. */
const canSignOut = (auth: AuthState | undefined) =>
  auth?.source ? auth.source === "device" || auth.source === "oauth" : auth?.mode === "oauth";

export function Header({ auth }: { auth: AuthState | undefined }) {
  const logout = useLogout();
  const jira = useHealth().data?.jira === true;
  const user = auth?.user ?? null;
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // Where the tabs scroll along their own row, the lit one is kept in view. Only the row moves, never the page.
  useEffect(() => {
    nav.current?.querySelector("a.active")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [pathname, user, jira]);
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
          <nav ref={nav} aria-label={copy.nav.label} className="app-nav">
            <NavItems jira={jira} />
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
          {user && <NavMenu jira={jira} />}
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
