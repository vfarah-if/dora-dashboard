import { useId, useState, type FormEvent } from "react";
import type { RepoListing } from "@dora-dashboard/core";
import { errorText } from "../api/client";
import { useUpdateIssueLabels } from "../api/hooks";
import { copy } from "../copy";
import {
  defaultInputs,
  inputsFromRules,
  kindLabel,
  LABEL_KINDS,
  LABEL_PRIORITIES,
  labelProblem,
  MAX_LABEL_LENGTH,
  MAX_LABEL_NAMES,
  priorityLabel,
  rulesFromInputs,
  type LabelInputs,
} from "../lib/issues";

interface LabelFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}

function LabelField({ id, label, value, placeholder, onChange }: LabelFieldProps) {
  const problem = labelProblem(value);
  const problemId = `${id}-problem`;
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
        aria-describedby={problem ? problemId : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {problem && (
        <p id={problemId} className="field-hint">
          {problem === "tooMany" ? copy.issueLabels.tooMany(MAX_LABEL_NAMES) : copy.issueLabels.tooLong(MAX_LABEL_LENGTH)}
        </p>
      )}
    </div>
  );
}

const DEFAULTS = defaultInputs();

/**
 * Which label names mean which kind and priority for one repository. An empty box keeps the default shown inside it.
 * Saving sends only the boxes filled in, or null when none are. The report is built from stored issues, so a change
 * applies at once and no crawl follows.
 */
export function IssueLabelsPanel({ repo }: { repo: RepoListing }) {
  const text = copy.issueLabels;
  const update = useUpdateIssueLabels(repo.id);
  const [inputs, setInputs] = useState<LabelInputs>(() => inputsFromRules(repo.issueLabels));
  const [done, setDone] = useState<"saved" | "reset" | null>(null);
  const titleId = useId();
  const idBase = useId();

  const hasProblem = [...Object.values(inputs.kinds), ...Object.values(inputs.priorities)].some(
    (value) => labelProblem(value) !== null,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDone(null);
    update.mutate(rulesFromInputs(inputs), { onSuccess: () => setDone("saved") });
  };

  const reset = () => {
    setDone(null);
    update.mutate(null, {
      onSuccess: () => {
        setInputs(inputsFromRules(null));
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
      <fieldset className="checkbox-group">
        <legend>{text.kindsLegend}</legend>
        {LABEL_KINDS.map((kind) => (
          <LabelField
            key={kind}
            id={`${idBase}-kind-${kind}`}
            label={text.kindLabel(kindLabel(kind))}
            value={inputs.kinds[kind]}
            placeholder={DEFAULTS.kinds[kind]}
            onChange={(value) => setInputs((current) => ({ ...current, kinds: { ...current.kinds, [kind]: value } }))}
          />
        ))}
      </fieldset>
      <fieldset className="checkbox-group">
        <legend>{text.prioritiesLegend}</legend>
        {LABEL_PRIORITIES.map((priority) => (
          <LabelField
            key={priority}
            id={`${idBase}-priority-${priority}`}
            label={text.priorityLabel(priorityLabel(priority))}
            value={inputs.priorities[priority]}
            placeholder={DEFAULTS.priorities[priority]}
            onChange={(value) =>
              setInputs((current) => ({ ...current, priorities: { ...current.priorities, [priority]: value } }))
            }
          />
        ))}
      </fieldset>
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
        <button type="submit" className="button button-primary" disabled={update.isPending || hasProblem}>
          {update.isPending ? copy.common.saving : text.save}
        </button>
        <button type="button" className="button button-ghost" onClick={reset} disabled={update.isPending}>
          {text.reset}
        </button>
      </div>
    </form>
  );
}
