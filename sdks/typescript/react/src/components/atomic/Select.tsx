import React, { useId, useState, useRef, useEffect } from "react";
import { ArrowDown01Icon, Tick01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  label?: string;
  error?: string;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const sizeClasses = {
  sm: "h-8 text-sm px-2",
  md: "h-10 text-base px-3",
  lg: "h-12 text-lg px-4",
};

const iconSizes = {
  sm: 14,
  md: 16,
  lg: 20,
};

export const Select = React.memo(
  React.forwardRef<HTMLButtonElement, SelectProps>(({ className, options, label, error, size = "md", fullWidth = false, placeholder, disabled, id, value, onChange }, ref) => {
    const generatedId = useId();
    const selectId = id || generatedId;
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find((opt) => opt.value === value);
    const displayText = selectedOption?.label || placeholder || "Select...";

    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsOpen(false);
        }
      };

      if (isOpen) {
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
      }
    }, [isOpen]);

    useEffect(() => {
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") setIsOpen(false);
      };

      if (isOpen) {
        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
      }
    }, [isOpen]);

    const handleSelect = (optionValue: string) => {
      onChange?.({ target: { value: optionValue } });
      setIsOpen(false);
    };

    return (
      <div className={cn("flex flex-col gap-1", fullWidth && "w-full")} ref={containerRef}>
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-muted-foreground">
            {label}
          </label>
        )}
        <div className="relative">
          <button
            ref={ref}
            id={selectId}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            className={cn(
              "flex items-center justify-between gap-2 rounded-xl border border-border bg-card transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent",
              "disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap",
              selectedOption ? "text-foreground" : "text-muted-foreground",
              error && "border-destructive",
              sizeClasses[size],
              fullWidth ? "w-[350px]" : "w-auto",
              className,
            )}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-invalid={!!error}
            aria-errormessage={error ? `${selectId}-error` : undefined}
          >
            <span className="truncate">{displayText}</span>
            <ArrowDown01Icon size={iconSizes[size]} className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
          </button>

          {isOpen && (
            <div className="absolute z-50 mt-1 w-full rounded-xl border border-border bg-popover py-1 shadow-lg overflow-hidden" role="listbox" aria-labelledby={selectId}>
              {options.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No options available</div>
              ) : (
                options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => !option.disabled && handleSelect(option.value)}
                    className={cn("flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors whitespace-nowrap overflow-hidden", "hover:bg-accent", "disabled:cursor-not-allowed disabled:opacity-50", option.value === value ? "bg-accent text-primary" : "text-foreground")}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.value === value && <Tick01Icon size={14} className="shrink-0 text-primary" />}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {error && (
          <span id={`${selectId}-error`} className="text-sm text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  }),
);

Select.displayName = "Select";
