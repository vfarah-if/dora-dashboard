import type { AuthState } from "../api/hooks";
import { copy } from "../copy";
import { DeviceSignIn } from "./DeviceSignIn";

export function SignIn({ auth }: { auth: AuthState }) {
  if (auth.mode === "oauth") {
    return (
      <section className="card sign-in">
        <h1>{copy.auth.signInTitle}</h1>
        <p className="lede">{copy.auth.signInBody}</p>
        {auth.error && (
          <p className="notice notice-error" role="alert">
            {auth.error}
          </p>
        )}
        <a className="button button-primary" href="/api/auth/github/login">
          {copy.auth.signInButton}
        </a>
      </section>
    );
  }
  return (
    <section className="card sign-in">
      <h1>{copy.auth.ghCliTitle}</h1>
      <p className="lede">{copy.auth.ghCliBody}</p>
      {auth.error && (
        <p className="notice notice-error" role="alert">
          {auth.error}
        </p>
      )}
      <p>{copy.auth.ghCliInstruction}</p>
      <pre className="code-block">
        <code>{copy.auth.ghCliCommand}</code>
      </pre>
      <button type="button" className="button button-secondary" onClick={() => window.location.reload()}>
        {copy.auth.reload}
      </button>
      {auth.deviceFlow && <DeviceSignIn />}
    </section>
  );
}
