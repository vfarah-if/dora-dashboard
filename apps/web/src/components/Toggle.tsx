import { useId } from "react";

export interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** An on/off switch. The label is part of the control's accessible name; the hint describes it. */
export function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  const hintId = useId();
  return (
    <div className="toggle">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? hintId : undefined}
        className="toggle-button"
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-track" aria-hidden="true">
          <span className="toggle-thumb" />
        </span>
        <span className="toggle-label">{label}</span>
      </button>
      {hint && (
        <span id={hintId} className="toggle-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
