import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface ChalkCheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-checked" | "children" | "onChange"> {
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  /** The visible label. The whole row toggles the box. */
  readonly children: ReactNode;
}

/** A form choice that is part of what gets sent. Settings that act at once use ChalkToggle instead. */
export const ChalkCheckbox = forwardRef<HTMLButtonElement, ChalkCheckboxProps>(function ChalkCheckbox({ checked, defaultChecked = false, onCheckedChange, onClick, disabled, className, children, type = "button", ...props }, ref) {
  const [local, setLocal] = useState(defaultChecked);
  const value = checked ?? local;
  return (
    <label data-part="checkbox" className={cn("chalk-checkbox", className)} data-disabled={disabled || undefined}>
      <button
        ref={ref}
        type={type}
        role="checkbox"
        aria-checked={value}
        disabled={disabled}
        data-checked={value || undefined}
        className="chalk-checkbox-box"
        onClick={(event) => {
          if (checked === undefined) setLocal(!value);
          onCheckedChange?.(!value);
          onClick?.(event);
        }}
        {...props}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
      <span className="chalk-checkbox-label">{children}</span>
    </label>
  );
});
