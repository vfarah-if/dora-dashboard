import { useId } from "react";
import type { ReportRange } from "../api/hooks";
import { copy } from "../copy";
import { isoDaysAgo } from "../lib/format";
import { Toggle } from "./Toggle";

export interface DateRangeControlsProps {
  value: ReportRange;
  onChange: (next: ReportRange) => void;
  /** Injected so presets can be tested against a fixed day. */
  now?: Date;
  /** Page-specific presets shown before the standard ones. */
  extraPresets?: readonly ExtraPreset[];
  /** Whether to offer the bots switch. Pages about issues rather than pull requests turn it off. */
  showBots?: boolean;
}

export interface ExtraPreset {
  key: string;
  label: string;
  range: Pick<ReportRange, "from" | "to">;
}

function standardPresets(now: Date | undefined): ExtraPreset[] {
  const today = isoDaysAgo(0, now);
  const lastDays = (days: number) => ({ from: isoDaysAgo(days, now), to: today });
  return [
    { key: "all", label: copy.range.allTime, range: { from: null, to: null } },
    { key: "90", label: copy.range.last90, range: lastDays(90) },
    { key: "30", label: copy.range.last30, range: lastDays(30) },
  ];
}

interface DateFieldProps {
  label: string;
  value: string | null;
  /** Set from the other end of the range, so a range cannot end before it starts. */
  min?: string | null;
  max?: string | null;
  onChange: (next: string | null) => void;
}

function DateField({ label, value, min, max, onChange }: DateFieldProps) {
  const id = useId();
  return (
    <label htmlFor={id} className="field-inline">
      <span>{label}</span>
      <input
        id={id}
        type="date"
        className="input"
        value={value ?? ""}
        min={min ?? undefined}
        max={max ?? undefined}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  );
}

export function DateRangeControls({ value, onChange, now, extraPresets = [], showBots = true }: DateRangeControlsProps) {
  const presets = [...extraPresets, ...standardPresets(now)];
  const activePreset = presets.find((preset) => preset.range.from === value.from && preset.range.to === value.to)?.key;

  return (
    <fieldset className="range-controls">
      <legend className="visually-hidden">{copy.range.legend}</legend>
      <div className="range-dates">
        <DateField label={copy.range.from} value={value.from} max={value.to} onChange={(from) => onChange({ ...value, from })} />
        <DateField label={copy.range.to} value={value.to} min={value.from} onChange={(to) => onChange({ ...value, to })} />
      </div>
      <div className="segmented" role="group" aria-label={copy.range.presetsLabel}>
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="segmented-button"
            aria-pressed={activePreset === preset.key}
            onClick={() => onChange({ ...value, ...preset.range })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {showBots && (
        <Toggle
          label={copy.range.includeBots}
          hint={copy.range.includeBotsHint}
          checked={value.includeBots}
          onChange={(includeBots) => onChange({ ...value, includeBots })}
        />
      )}
    </fieldset>
  );
}
