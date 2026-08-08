import * as React from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./lib/utils";

const toggleVariants = cva(
  "hover:text-foreground aria-pressed:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[state=on]:bg-accent data-[state=on]:text-accent-foreground gap-1 rounded-lg text-sm font-medium transition-colors [&_svg:not([class*='size-'])]:size-4 group/toggle hover:bg-accent inline-flex items-center justify-center whitespace-nowrap outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-input hover:bg-accent border bg-transparent",
      },
      size: {
        default: "h-8 min-w-8 px-2",
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-1.5 text-[0.8rem]",
        lg: "h-9 min-w-9 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ToggleProps = Omit<TogglePrimitive.Props, "pressed" | "onPressedChange" | "onChange"> &
  VariantProps<typeof toggleVariants> & {
    readonly checked?: boolean;
    readonly enabled?: boolean;
    readonly onChange?: (checked: boolean) => void;
    readonly pressed?: boolean;
    readonly onPressedChange?: (checked: boolean) => void;
    readonly label?: React.ReactNode;
    readonly ariaLabel?: string;
    readonly ariaLabelledby?: string;
  };

function Toggle({ className, variant = "default", size = "default", checked, enabled, onChange, label, ariaLabel, ariaLabelledby, pressed, onPressedChange, id, ...props }: ToggleProps) {
  const resolvedPressed = checked ?? enabled ?? pressed;
  const generatedId = React.useId();
  const toggleId = id ?? (label ? `chalk-toggle-${generatedId.replace(/:/g, "")}` : undefined);
  const toggle = <TogglePrimitive id={toggleId} data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} pressed={resolvedPressed} onPressedChange={onPressedChange ?? onChange} aria-label={ariaLabel} aria-labelledby={ariaLabelledby} {...props} />;
  return label ? (
    <span className="inline-flex items-center gap-2">
      {toggle}
      <label htmlFor={toggleId}>{label}</label>
    </span>
  ) : (
    toggle
  );
}

export { Toggle, toggleVariants };
