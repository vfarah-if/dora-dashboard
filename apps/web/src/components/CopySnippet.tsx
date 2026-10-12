import { useEffect, useRef, useState } from "react";
import { copy } from "../copy";

type Status = "idle" | "copied" | "failed";

const canCopy = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";

/** How long the announcement stays, so that it is not left in the page for a screen reader to find later. */
const ANNOUNCEMENT_MS = 2000;

/**
 * A block of text to copy, with a labelled button, inside a labelled group so that a screen reader names the block
 * once. The announcement region is always in the page and visually hidden, so it is registered before the first copy,
 * and each copy puts a fresh message in it, so a second copy is announced again. It is cleared after a couple of
 * seconds. Where the browser does not let a page copy, the block says so and stays selectable, so nobody is left
 * without a way to take the text. Long lines scroll inside the block, never across the page.
 *
 * `instead` is a block shown for comparison, such as the risky way of writing something. It is never copyable.
 */
export function CopySnippet({ label, code, note, instead }: { label: string; code: string; note?: string; instead?: string }) {
  const [status, setStatus] = useState<Status>("idle");
  // Each copy gets a number, so that the message is a new element and a repeat is announced like the first.
  const [copies, setCopies] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const available = canCopy();
  useEffect(() => () => clearTimeout(timer.current), []);

  const announce = (next: Status) => {
    setStatus(next);
    setCopies((n) => n + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), ANNOUNCEMENT_MS);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      announce("copied");
    } catch {
      announce("failed");
    }
  };

  const message = status === "copied" ? copy.security.copied : status === "failed" ? copy.security.copyFailed : "";

  return (
    <div className="copy-snippet" role="group" aria-label={label}>
      <div className="copy-snippet-head">
        <span className="copy-snippet-label" aria-hidden="true">
          {label}
        </span>
        {available && (
          <button
            type="button"
            className="button button-ghost copy-button"
            onClick={() => void copyCode()}
            aria-label={copy.security.copyLabel(label)}
          >
            {status === "copied" ? copy.security.copied : copy.security.copyButton}
          </button>
        )}
      </div>
      {note && <p className="copy-snippet-note">{note}</p>}
      <pre className="copy-snippet-code" tabIndex={0}>
        <code>{code}</code>
      </pre>
      {instead && (
        <div className="copy-snippet-instead">
          <p className="copy-snippet-note">{copy.security.insteadOf}</p>
          <pre className="copy-snippet-code" tabIndex={0}>
            <code>{instead}</code>
          </pre>
        </div>
      )}
      {status === "failed" && (
        <p className="copy-snippet-status screen-only" aria-hidden="true">
          {copy.security.copyFailed}
        </p>
      )}
      {!available && <p className="copy-snippet-status screen-only">{copy.security.copyUnavailable}</p>}
      <div className="visually-hidden" role="status" aria-live="polite">
        {message && <span key={copies}>{message}</span>}
      </div>
    </div>
  );
}
