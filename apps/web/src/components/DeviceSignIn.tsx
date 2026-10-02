import { useEffect, useRef, useState } from "react";
import { useDeviceFlow } from "../api/useDeviceFlow";
import { copy } from "../copy";

const text = copy.auth.device;

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="device-code-row">
      <p className="device-code" aria-label={text.codeLabel}>
        {code}
      </p>
      <button type="button" className="button button-secondary" onClick={() => void copyCode()}>
        {text.copy}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? text.copied : ""}
      </span>
    </div>
  );
}

export function DeviceSignIn() {
  const { state, start } = useDeviceFlow();

  if (state.phase === "idle") {
    return (
      <div className="device-sign-in">
        <p>{text.or}</p>
        <button type="button" className="button button-primary" onClick={() => void start()}>
          {copy.auth.signInButton}
        </button>
      </div>
    );
  }

  const retry = (
    <button type="button" className="button button-primary" onClick={() => void start()}>
      {text.tryAgain}
    </button>
  );

  return (
    <div className="device-sign-in">
      {state.phase === "starting" && <p aria-live="polite">{text.starting}</p>}
      {state.phase === "waiting" && (
        <>
          <CodeBlock code={state.start.userCode} />
          <ol className="device-steps" aria-label={text.stepsTitle}>
            <li>{text.stepOpen}</li>
            <li>{text.stepEnter}</li>
            <li>{text.stepApprove}</li>
          </ol>
          <a className="button button-secondary" href={state.start.verificationUri} target="_blank" rel="noopener noreferrer">
            {text.openLink} <span className="visually-hidden">{text.newTab}</span>
          </a>
          <p className="device-waiting" aria-live="polite">
            {text.waiting}
          </p>
        </>
      )}
      {(state.phase === "expired" || state.phase === "denied" || state.phase === "incomplete") && (
        <>
          <p className="notice notice-warning" role="alert">
            {state.phase === "expired" ? text.expired : state.phase === "denied" ? text.denied : text.incomplete}
          </p>
          {retry}
        </>
      )}
      {state.phase === "error" && (
        <>
          <p className="notice notice-error" role="alert">
            {state.message}
          </p>
          {retry}
        </>
      )}
    </div>
  );
}
