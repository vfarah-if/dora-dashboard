import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ACCEPTANCE_LIMITS, noteLength, noteProblem } from "@dora-dashboard/core";
import type { AcceptanceReason, NoteProblem } from "@dora-dashboard/core";
import { errorText } from "../api/client";
import { useAcceptFinding } from "../api/hooks";
import { copy } from "../copy";
import { focusAcceptedHeading, setAcceptNotice } from "../lib/acceptNotice";
import { REASONS, acceptanceRequest, conflictText, noteProblemText, type AcceptTarget } from "../lib/securityAcceptance";

const c = copy.security.acceptance;

type Problem = "noReason" | NoteProblem;

interface AcceptFindingProps {
  repoId: number;
  target: AcceptTarget;
  /** Names the place for a screen reader, such as the path and line, or the check for an absence. */
  place: string;
}

/**
 * A button that opens a short form beside one finding, in the way the review exemptions editor opens, so the page stays
 * quiet until someone decides. The form takes a reason and a note, and on success focus moves to the Accepted findings
 * heading, because the finding leaves this list and takes this control with it. Not printed.
 */
export function AcceptFinding({ repoId, target, place }: AcceptFindingProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AcceptanceReason | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const accept = useAcceptFinding(repoId);
  const toggle = useRef<HTMLButtonElement>(null);
  const firstReason = useRef<HTMLInputElement>(null);
  const base = useId();
  const panelId = `${base}-panel`;
  const noteId = `${base}-note`;
  const noteHintId = `${base}-note-hint`;
  const noteProblemId = `${base}-note-problem`;
  const reasonProblemId = `${base}-reason-problem`;
  const pending = accept.isPending;

  useEffect(() => {
    if (open) firstReason.current?.focus();
  }, [open]);

  // After a conflict the report is read again, and the finding may leave its list and take this form with it a moment
  // later. While the form stays, the sentence is said in the form. If the form leaves, the same sentence is said once in
  // the Accepted section and focus goes there, so there is only ever one message and a person still in the form is not moved.
  const mounted = useRef(true);
  const pendingConflict = useRef<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingConflict.current !== null) {
        setAcceptNotice(repoId, pendingConflict.current);
        focusAcceptedHeading();
      }
    };
  }, [repoId]);

  const cancel = () => {
    setOpen(false);
    setProblem(null);
    // A form opened again is a fresh one, so what was typed before is not carried over.
    setReason(null);
    setNote("");
    accept.reset();
    pendingConflict.current = null;
    setConflict(null);
    toggle.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    pendingConflict.current = null;
    setConflict(null);
    const found: Problem | null = reason === null ? "noReason" : noteProblem(note);
    setProblem(found);
    if (found !== null || reason === null) return;
    try {
      await accept.mutateAsync(acceptanceRequest(target, reason, note));
    } catch (error) {
      // A conflict has one cause, named by its code, and is said once. If the form is gone it is said in the Accepted
      // section with focus. If the form is still here it is said in the form, and moves to the section only if the form
      // leaves after the report is read again.
      const said = conflictText(error);
      if (said !== null) {
        if (mounted.current) {
          pendingConflict.current = said;
          setConflict(said);
        } else {
          setAcceptNotice(repoId, said);
          focusAcceptedHeading();
        }
      }
      // Any other failure shows from the mutation's own error, for as long as this form is there.
      return;
    }
    setOpen(false);
    setAcceptNotice(repoId, c.accepted);
    focusAcceptedHeading();
  };

  const count = noteLength(note);
  // A conflict has its own sentence above, so the request's error shows only for the other failures.
  const inlineError = accept.isError && conflictText(accept.error) === null;
  const noteIssue = problem !== null && problem !== "noReason" ? problem : null;

  return (
    <div className="screen-only accept-finding">
      <button
        ref={toggle}
        type="button"
        className="button button-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          // However the form is closed or opened, a conflict said in it is over, so a later unmount has nothing to announce.
          pendingConflict.current = null;
          setConflict(null);
          setOpen((now) => !now);
        }}
      >
        {c.accept} <span className="visually-hidden">{place}</span>
      </button>
      <div id={panelId}>
        {open && (
          <form
            className="configure-panel accept-form"
            onSubmit={(event) => void submit(event)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) {
                event.stopPropagation();
                cancel();
              }
            }}
            noValidate
          >
            <fieldset className="accept-reasons" aria-describedby={problem === "noReason" ? reasonProblemId : undefined}>
              <legend>{c.reasonLegend}</legend>
              {REASONS.map((value, index) => (
                <div key={value} className="accept-reason">
                  <label className="checkbox">
                    <input
                      ref={index === 0 ? firstReason : undefined}
                      type="radio"
                      name={`${base}-reason`}
                      value={value}
                      checked={reason === value}
                      aria-describedby={`${base}-hint-${value}`}
                      onChange={() => {
                        setReason(value);
                        setProblem((now) => (now === "noReason" ? null : now));
                      }}
                    />
                    <span>{c.reasons[value].label}</span>
                  </label>
                  <p id={`${base}-hint-${value}`} className="field-hint">
                    {c.reasons[value].hint}
                  </p>
                </div>
              ))}
              {problem === "noReason" && (
                <p id={reasonProblemId} className="field-hint accept-problem" role="alert">
                  {c.problems.noReason}
                </p>
              )}
            </fieldset>
            <div className="field">
              <label htmlFor={noteId}>{c.noteLabel}</label>
              <textarea
                id={noteId}
                className="input accept-note"
                rows={3}
                value={note}
                onChange={(event) => {
                  const value = event.target.value;
                  setNote(value);
                  // Core's rule, as the server applies it. A note that is too long, or that holds a control character
                  // such as a line break from a paste, is said as soon as it appears. An empty one waits for the submit.
                  const found = noteProblem(value);
                  setProblem((now) => (now === "noReason" ? now : found === "empty" ? null : found));
                }}
                onKeyDown={(event) => {
                  // The note is one line, so Enter does not add a break.
                  // An Enter that confirms an IME composition must get through.
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
                }}
                aria-invalid={noteIssue !== null}
                aria-describedby={noteIssue ? `${noteHintId} ${noteProblemId}` : noteHintId}
                autoComplete="off"
                spellCheck
              />
              <p id={noteHintId} className="field-hint">
                {c.noteHint(ACCEPTANCE_LIMITS.note)}
              </p>
              <p className="field-hint accept-count" data-over={count > ACCEPTANCE_LIMITS.note}>
                {c.noteCount(count, ACCEPTANCE_LIMITS.note)}
              </p>
              {noteIssue && (
                <p id={noteProblemId} className="field-hint accept-problem" role="alert">
                  {noteProblemText(noteIssue)}
                </p>
              )}
            </div>
            {conflict && (
              <p className="notice notice-error" role="alert">
                {conflict}
              </p>
            )}
            {inlineError && (
              <p className="notice notice-error" role="alert">
                {errorText(accept.error)}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className="button button-primary" disabled={pending}>
                {pending ? copy.common.saving : c.submit}
              </button>
              <button type="button" className="button button-ghost" onClick={cancel} disabled={pending}>
                {c.cancel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
