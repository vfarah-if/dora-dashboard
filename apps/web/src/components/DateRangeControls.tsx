import { useId, useState } from "react";
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
  /** The latest date the range may hold. A complete date typed past it is shown as this instead, so the field never disagrees with the range. */
  limit: string;
  onChange: (next: string | null) => void;
}

/** A browser reports a date a keystroke at a time while the year is typed (0002, 0020, 0202, 2026). A year of 1000 or later is a date. */
const isCompleteDate = (typed: string) => Number(typed.slice(0, typed.indexOf("-"))) >= 1000;

function DateField({ label, value, min, max, limit, onChange }: DateFieldProps) {
  const id = useId();
  // What is typed, held here until it is a whole date, so a half-typed year never reaches the range or the address.
  const [draft, setDraft] = useState(value ?? "");
  // When the range changes from outside, such as a preset or the other field clearing this one, what was typed no
  // longer describes it, so the draft is reset to the new value during render rather than in an effect.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value ?? "");
  }
  return (
    <label htmlFor={id} className="field-inline">
      <span>{label}</span>
      <input
        id={id}
        type="date"
        className="input"
        value={draft}
        min={min ?? undefined}
        max={max ?? undefined}
        onChange={(event) => {
          const typed = event.target.value;
          if (typed === "") {
            setDraft(typed);
            onChange(null);
          } else if (isCompleteDate(typed)) {
            // The parent clamps too, but when the value is already the limit its prop does not change and the draft would not be reset.
            setDraft(typed > limit ? limit : typed);
            onChange(typed);
          } else setDraft(typed);
        }}
        onBlur={() => setDraft(value ?? "")}
      />
    </label>
  );
}

export function DateRangeControls({ value, onChange, now, extraPresets = [], showBots = true }: DateRangeControlsProps) {
  const today = isoDaysAgo(0, now);
  // ISO dates compare correctly as text. Neither end may be later than today, and a typed date that is gets today instead.
  const clamp = (date: string | null) => (date !== null && date > today ? today : date);
  const presets = [...extraPresets, ...standardPresets(now)];
  const activePreset = presets.find((preset) => preset.range.from === value.from && preset.range.to === value.to)?.key;

  return (
    <fieldset className="range-controls">
      <legend className="visually-hidden">{copy.range.legend}</legend>
      <div className="range-dates">
        <DateField
          label={copy.range.from}
          value={value.from}
          max={value.to && value.to < today ? value.to : today}
          limit={today}
          onChange={(next) => {
            const from = clamp(next);
            // The end typed into wins. When the new start passes the end, the end is cleared rather than the typed start refused.
            onChange(from && value.to && from > value.to ? { ...value, from, to: null } : { ...value, from });
          }}
        />
        <DateField
          label={copy.range.to}
          value={value.to}
          min={value.from}
          max={today}
          limit={today}
          onChange={(next) => {
            const to = clamp(next);
            // To does the same: a typed end before the start clears the start.
            onChange(to && value.from && to < value.from ? { ...value, from: null, to } : { ...value, to });
          }}
        />
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
