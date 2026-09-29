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
}

export interface ExtraPreset {
  key: string;
  label: string;
  range: Pick<ReportRange, "from" | "to">;
}

type Preset = "all" | "90" | "30";

export function DateRangeControls({ value, onChange, now, extraPresets = [] }: DateRangeControlsProps) {
  const fromId = useId();
  const toId = useId();
  const today = isoDaysAgo(0, now);

  const presetRange = (preset: Preset): Pick<ReportRange, "from" | "to"> =>
    preset === "all" ? { from: null, to: null } : { from: isoDaysAgo(Number(preset), now), to: today };

  const presets: ExtraPreset[] = [
    ...extraPresets,
    ...(
      [
        { key: "all", label: copy.range.allTime },
        { key: "90", label: copy.range.last90 },
        { key: "30", label: copy.range.last30 },
      ] as const
    ).map((preset) => ({ ...preset, range: presetRange(preset.key) })),
  ];

  const activePreset = presets.find((preset) => preset.range.from === value.from && preset.range.to === value.to)?.key;

  return (
    <fieldset className="range-controls">
      <legend className="visually-hidden">{copy.range.legend}</legend>
      <div className="range-dates">
        <label htmlFor={fromId} className="field-inline">
          <span>{copy.range.from}</span>
          <input
            id={fromId}
            type="date"
            className="input"
            value={value.from ?? ""}
            max={value.to ?? undefined}
            onChange={(event) => onChange({ ...value, from: event.target.value || null })}
          />
        </label>
        <label htmlFor={toId} className="field-inline">
          <span>{copy.range.to}</span>
          <input
            id={toId}
            type="date"
            className="input"
            value={value.to ?? ""}
            min={value.from ?? undefined}
            onChange={(event) => onChange({ ...value, to: event.target.value || null })}
          />
        </label>
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
      <Toggle
        label={copy.range.includeBots}
        hint={copy.range.includeBotsHint}
        checked={value.includeBots}
        onChange={(includeBots) => onChange({ ...value, includeBots })}
      />
    </fieldset>
  );
}
