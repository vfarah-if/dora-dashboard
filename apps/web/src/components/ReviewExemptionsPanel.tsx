import { useId, useState, type FormEvent } from "react";
import type { RepoListing } from "@dora-dashboard/core";
import { errorText } from "../api/client";
import { useReviewExemptionDefaults, useUpdateReviewExemptions } from "../api/hooks";
import { copy } from "../copy";
import { formatLabelList } from "../lib/issues";
import { exemptionProblem, inputsFor, rulesFromInputs, type ExemptionInputs } from "../lib/reviewExemptions";
import { ErrorState } from "./States";

type Limits = NonNullable<ReturnType<typeof useReviewExemptionDefaults>["data"]>["limits"];

interface FieldProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  problem: "tooMany" | "tooLong" | "control" | null;
  limits: Limits | undefined;
  maxEntries: number | undefined;
  onChange: (value: string) => void;
}

function Field({ id, label, hint, value, placeholder, problem, limits, maxEntries, onChange }: FieldProps) {
  const text = copy.reviewExemptions;
  const problemId = `${id}-problem`;
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
        autoComplete="off"
        spellCheck={false}
      />
      <p id={hintId} className="field-hint">
        {hint}
      </p>
      {problem && (
        <p id={problemId} className="field-hint">
          {problem === "tooMany" && maxEntries !== undefined && text.tooMany(maxEntries)}
          {problem === "tooLong" && limits && text.tooLong(limits.length)}
          {problem === "control" && text.control}
        </p>
      )}
    </div>
  );
}

/**
 * The title words and labels that leave a merged pull request out of "merged with no review" for one repository. The
 * boxes start from the rules in force, and Reset puts the defaults back. The figure is built from stored pull requests,
 * so a change applies at once and no crawl follows.
 */
function ReviewExemptionsForm({ repo }: { repo: RepoListing }) {
  const text = copy.reviewExemptions;
  const update = useUpdateReviewExemptions(repo.id);
  const defaultsQuery = useReviewExemptionDefaults();
  const defaults = defaultsQuery.data;
  const limits = defaults?.limits;
  const current = inputsFor(repo.reviewExemptions, defaults);
  // Only what the person has typed is held here, so the boxes follow the defaults until they load or are reset.
  const [typed, setTyped] = useState<Partial<ExemptionInputs>>({});
  const [done, setDone] = useState<"saved" | "reset" | null>(null);
  const titleId = useId();
  const idBase = useId();
  const inputs: ExemptionInputs = { ...current, ...typed };

  const wordsProblem = limits ? exemptionProblem(inputs.titleWords, limits.titleWords, limits) : null;
  const labelsProblem = limits ? exemptionProblem(inputs.labels, limits.labels, limits) : null;
  const blocked = !limits || wordsProblem !== null || labelsProblem !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDone(null);
    update.mutate(rulesFromInputs(inputs), {
      onSuccess: () => {
        setTyped({});
        setDone("saved");
      },
    });
  };

  const reset = () => {
    setDone(null);
    update.mutate(null, {
      onSuccess: () => {
        setTyped({});
        setDone("reset");
      },
    });
  };

  return (
    <form className="configure-panel" onSubmit={submit} aria-labelledby={titleId}>
      <h3 id={titleId} className="configure-title">
        {text.title}
      </h3>
      <p className="field-hint">{text.lede}</p>
      {repo.reviewExemptionsUnreadable && (
        <p className="notice notice-warning" role="alert">
          {text.unreadable}
        </p>
      )}
      {defaultsQuery.isPending && (
        <p className="field-hint" role="status">
          {text.loadingDefaults}
        </p>
      )}
      {defaultsQuery.isError && <ErrorState error={defaultsQuery.error} onRetry={() => void defaultsQuery.refetch()} />}
      <Field
        id={`${idBase}-words`}
        label={text.titleWordsLabel}
        hint={text.titleWordsHint}
        value={inputs.titleWords}
        placeholder={formatLabelList(defaults?.titleWords)}
        problem={wordsProblem}
        limits={limits}
        maxEntries={limits?.titleWords}
        onChange={(value) => setTyped((now) => ({ ...now, titleWords: value }))}
      />
      <Field
        id={`${idBase}-labels`}
        label={text.labelsLabel}
        hint={text.labelsHint}
        value={inputs.labels}
        placeholder={formatLabelList(defaults?.labels)}
        problem={labelsProblem}
        limits={limits}
        maxEntries={limits?.labels}
        onChange={(value) => setTyped((now) => ({ ...now, labels: value }))}
      />
      {defaults && (
        <p className="field-hint">{text.defaultsLine(formatLabelList(defaults.titleWords), formatLabelList(defaults.labels))}</p>
      )}
      <p className="field-hint">{text.emptyNote}</p>
      <p className="field-hint">{text.applyNote}</p>
      {update.isError && (
        <p className="notice notice-error" role="alert">
          {errorText(update.error)}
        </p>
      )}
      {update.isSuccess && done && (
        <p className="notice notice-info" role="status">
          {done === "saved" ? text.saved : text.resetDone}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={update.isPending || blocked}>
          {update.isPending ? copy.common.saving : text.save}
        </button>
        <button type="button" className="button button-ghost" onClick={reset} disabled={update.isPending}>
          {text.reset}
        </button>
      </div>
    </form>
  );
}

/** A button that opens the editor beside the figure it changes, so the page stays short until someone wants it. */
export function ReviewExemptionsPanel({ repo }: { repo: RepoListing }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="screen-only">
      <button
        type="button"
        className="button button-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((now) => !now)}
      >
        {open ? copy.reviewExemptions.close : copy.reviewExemptions.open}
      </button>
      <div id={panelId}>{open && <ReviewExemptionsForm repo={repo} />}</div>
    </div>
  );
}
