import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "./lib/utils";

export interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  readonly label?: React.ReactNode;
  readonly error?: string;
  readonly icon?: React.ReactNode;
  readonly iconPosition?: "left" | "right";
  readonly size?: "sm" | "md" | "lg";
  readonly fullWidth?: boolean;
}

function getInputClassName(className: string | undefined, size: InputProps["size"], fullWidth: boolean, icon: React.ReactNode, iconPosition: NonNullable<InputProps["iconPosition"]>, error: string | undefined): string {
  return cn(
    "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-muted h-8 rounded-lg border px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-[3px] aria-invalid:ring-[3px] md:text-sm file:text-foreground placeholder:text-muted-foreground min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
    fullWidth ? "w-full" : "w-auto",
    size === "sm" && "h-7 text-sm",
    size === "lg" && "h-10 text-lg",
    icon && iconPosition === "left" && "pl-9",
    icon && iconPosition === "right" && "pr-9",
    error && "border-destructive",
    className,
  );
}

function Input({ className, type, label, error, icon, iconPosition = "left", size = "md", fullWidth = true, id, ...props }: InputProps) {
  const inputId =
    id ??
    (label
      ? `chalk-input-${String(label)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}`
      : undefined);
  if (!label && !error && !icon && size === "md" && id === undefined) {
    return <InputPrimitive type={type} data-slot="input" className={getInputClassName(className, size, fullWidth, icon, iconPosition, error)} {...props} />;
  }
  const input = (
    <div className="relative">
      {icon && iconPosition === "left" ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">{icon}</span> : null}
      <InputPrimitive id={inputId} type={type} data-slot="input" className={getInputClassName(className, size, fullWidth, icon, iconPosition, error)} aria-invalid={Boolean(error)} {...props} />
      {icon && iconPosition === "right" ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">{icon}</span> : null}
    </div>
  );

  return (
    <label className={cn("flex flex-col gap-1.5", fullWidth && "w-full")} htmlFor={inputId}>
      {label ? <span className="text-sm font-medium text-muted-foreground">{label}</span> : null}
      {input}
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </label>
  );
}

export { Input };
