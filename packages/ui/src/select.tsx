import * as React from "react";

import { cn } from "./lib/utils";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly options: readonly SelectOption[];
  readonly value?: string;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
  readonly label?: string;
  readonly error?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly fullWidth?: boolean;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly id?: string;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, value, onChange, label, error, size = "md", fullWidth = false, placeholder = "Select…", disabled = false, className, id }, ref) {
  const generatedId = React.useId();
  const selectId = id ?? generatedId;
  const selectedOption = options.find((option) => option.value === value);

  return (
    <label className={cn("flex flex-col gap-1", fullWidth && "w-full")} htmlFor={selectId}>
      {label ? <span className="text-sm font-medium text-muted-foreground">{label}</span> : null}
      <select
        ref={ref}
        id={selectId}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange?.({ target: { value: event.target.value } })}
        aria-invalid={Boolean(error)}
        className={cn(
          "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-muted h-8 min-w-0 rounded-lg border px-2.5 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" && "h-7 text-xs",
          size === "lg" && "h-10 text-base",
          fullWidth && "w-full",
          !selectedOption && "text-muted-foreground",
          error && "border-destructive",
          className,
        )}
      >
        <option value="" disabled={options.length > 0}>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </label>
  );
});

Select.displayName = "Select";

export { Select };
