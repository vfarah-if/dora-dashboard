import { useLocation, useSearchParams } from "react-router";
import { useHealth } from "../api/hooks";
import { copy } from "../copy";
import { JIRA_OUTCOME_PARAM, jiraConnectUrl, parseJiraOutcome, returnPath, type JiraOutcome } from "../lib/jira";

/** A button that starts the Jira sign-in and comes back to the current page, without any earlier outcome in its address. */
export function ConnectButton({ label, primary = true }: { label: string; primary?: boolean }) {
  const location = useLocation();
  const connect = () => window.location.assign(jiraConnectUrl(returnPath(location.pathname, location.search)));
  return (
    <button type="button" className={`button ${primary ? "button-primary" : "button-secondary"}`} onClick={connect}>
      {label}
    </button>
  );
}

type Tone = "info" | "warning" | "error";

/** How each outcome looks, and whether trying again could help. A refusal of the dashboard's own settings cannot be fixed by retrying. */
const PRESENTATION: Record<JiraOutcome, { tone: Tone; retry: boolean }> = {
  denied: { tone: "info", retry: true },
  error: { tone: "error", retry: true },
  expired: { tone: "warning", retry: true },
  misconfigured: { tone: "error", retry: false },
  rate_limited: { tone: "warning", retry: true },
};

/**
 * Says how the last Jira sign-in ended, when the callback sent the person back with a `jira` outcome in the address.
 * Dismissing it removes the parameter. It renders nothing when there is no outcome, or one it does not know.
 */
export function JiraOutcomeNotice() {
  const [params, setParams] = useSearchParams();
  const health = useHealth();
  const outcome = parseJiraOutcome(params.get(JIRA_OUTCOME_PARAM));
  // Connecting leads to a route that does not exist when Jira is off, so say nothing until the server says it is on.
  if (!outcome || health.data?.jira !== true) return null;

  const { tone, retry } = PRESENTATION[outcome];
  const text = copy.jira.outcomes[outcome];
  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete(JIRA_OUTCOME_PARAM);
    setParams(next, { replace: true });
  };

  return (
    <div className={`notice notice-${tone}`} role={tone === "info" ? "status" : "alert"}>
      <p className="notice-title">{text.title}</p>
      <p>{text.body}</p>
      <div className="form-actions">
        {retry && <ConnectButton label={copy.jira.connectAgain} />}
        <button type="button" className="button button-ghost" onClick={dismiss}>
          {copy.jira.dismiss}
        </button>
      </div>
    </div>
  );
}
