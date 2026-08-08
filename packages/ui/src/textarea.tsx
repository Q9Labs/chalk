import * as React from "react";

import { cn } from "./lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label?: string;
  readonly error?: string;
  readonly showCount?: boolean;
  readonly resize?: "none" | "vertical" | "horizontal" | "both";
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, error, showCount = false, resize = "vertical", maxLength, value, className, id, ...props }, ref) {
  const generatedId = React.useId();
  const textareaId = id ?? generatedId;
  const currentLength = typeof value === "string" ? value.length : 0;

  return (
    <label className="flex w-full flex-col gap-1.5" htmlFor={textareaId}>
      {label ? <span className="text-sm font-medium text-muted-foreground">{label}</span> : null}
      <textarea
        ref={ref}
        id={textareaId}
        value={value}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        className={cn(
          "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-muted flex min-h-20 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          resize === "none" && "resize-none",
          resize === "vertical" && "resize-y",
          resize === "horizontal" && "resize-x",
          resize === "both" && "resize",
          error && "border-destructive",
          className,
        )}
        {...props}
      />
      {error || (showCount && maxLength) ? (
        <span className={cn("flex justify-between text-xs text-muted-foreground", error && "text-destructive")}>
          <span>{error}</span>
          {showCount && maxLength ? (
            <span>
              {currentLength} / {maxLength}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

Textarea.displayName = "Textarea";

export { Textarea };
