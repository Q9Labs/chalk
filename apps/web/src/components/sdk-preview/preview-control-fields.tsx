import { useId, type ReactNode } from "react";

import { valueLabel } from "./preview-labels";

/**
 * Shared building blocks for the preview controls panel. Every field favours
 * one-click, always-visible options over dropdowns so a state can be changed
 * without opening anything.
 */

const legendClassName = "mb-1.5 block text-xs font-semibold text-[#555b65]";
const chipClassName = "inline-flex h-8 cursor-pointer select-none items-center rounded-lg border border-[#d9d8d2] bg-white px-3 text-[13px] font-medium leading-none text-[#40454d] transition-colors hover:border-[#55aac9] hover:bg-[#f7fbfc]";
const chipCheckedClassName = "peer-checked:border-[#202329] peer-checked:bg-[#202329] peer-checked:text-white peer-checked:hover:bg-[#2c3139] peer-focus-visible:ring-2 peer-focus-visible:ring-[#55aac9]/60 peer-focus-visible:ring-offset-1";

export function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className={legendClassName}>
        {label}
        {hint ? <span className="ml-1.5 font-normal text-[#858a92]">{hint}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

interface ChipGroupProps<T extends string | number> {
  readonly label: string;
  readonly hint?: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (value: T) => void;
  readonly format?: (value: T) => string;
  readonly describe?: (value: T) => string | undefined;
}

/** Radio group rendered as chips: one click to change, arrow keys to move. */
export function ChipGroup<T extends string | number>({ label, hint, value, options, onChange, format = (option) => valueLabel(String(option)), describe }: ChipGroupProps<T>) {
  const name = useId();
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label key={String(option)} className="relative" title={describe?.(option)}>
            <input type="radio" name={name} value={String(option)} checked={option === value} className="peer sr-only" onChange={() => onChange(option)} />
            <span className={`${chipClassName} ${chipCheckedClassName}`}>{format(option)}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}

interface SelectFieldProps<T extends string | number> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (value: T) => void;
  readonly format?: (value: T) => string;
  readonly describe?: (value: T) => string | undefined;
  readonly groupBy?: (value: T) => string;
}

/** Native select for long lists (a dozen or more options). */
export function SelectField<T extends string | number>({ label, value, options, onChange, format = (option) => valueLabel(String(option)), describe, groupBy }: SelectFieldProps<T>) {
  const renderOption = (option: T) => (
    <option key={String(option)} value={String(option)} title={describe?.(option)}>
      {format(option)}
    </option>
  );
  const groups = groupBy ? [...new Set(options.map(groupBy))] : [];

  return (
    <label className="block min-w-0 text-xs font-semibold text-[#555b65]">
      <span className={legendClassName}>{label}</span>
      <select
        className="h-9 w-full min-w-0 rounded-lg border border-[#d9d8d2] bg-white px-2.5 text-[13px] font-medium text-[#202329] outline-none transition focus:border-[#55aac9] focus:ring-2 focus:ring-[#55aac9]/40"
        value={String(value)}
        aria-label={label}
        onChange={(event) => {
          const next = options.find((option) => String(option) === event.target.value);
          if (next !== undefined) onChange(next);
        }}
      >
        {groupBy
          ? groups.map((group) => (
              <optgroup key={group} label={group}>
                {options.filter((option) => groupBy(option) === group).map(renderOption)}
              </optgroup>
            ))
          : options.map(renderOption)}
      </select>
    </label>
  );
}

interface SwitchFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

export function SwitchField({ label, hint, checked, onChange }: SwitchFieldProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex h-10 w-full items-center justify-between gap-3 rounded-lg border border-[#d9d8d2] bg-white px-3 text-left text-[13px] font-medium text-[#40454d] transition-colors hover:border-[#55aac9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/60 aria-checked:border-[#202329]"
    >
      <span className="min-w-0 truncate">
        {label}
        {hint ? <span className="ml-1.5 font-normal text-[#858a92]">{hint}</span> : null}
      </span>
      <span aria-hidden="true" className="relative h-5 w-9 shrink-0 rounded-full bg-[#d9d8d2] transition-colors group-aria-checked:bg-[#202329]">
        <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform group-aria-checked:translate-x-4" />
      </span>
    </button>
  );
}

interface ToggleChipProps {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly pressed: boolean;
  readonly onChange: (pressed: boolean) => void;
}

/** Independent on/off chip (not part of a radio group). */
export function ToggleChip({ label, ariaLabel, pressed, onChange }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={() => onChange(!pressed)}
      className="inline-flex h-8 select-none items-center gap-1.5 rounded-lg border border-[#d9d8d2] bg-white px-3 text-[13px] font-medium leading-none text-[#40454d] transition-colors hover:border-[#55aac9] hover:bg-[#f7fbfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55aac9]/60 aria-pressed:border-[#202329] aria-pressed:bg-[#202329] aria-pressed:text-white aria-pressed:hover:bg-[#2c3139]"
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${pressed ? "bg-[#7fd1a8]" : "bg-[#c9c8c2]"}`} />
      {label}
    </button>
  );
}
