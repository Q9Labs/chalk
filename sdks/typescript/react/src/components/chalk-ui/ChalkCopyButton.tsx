import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../utils/cn";
import { useCopyText } from "./useCopyText";

/** The copy glyph that morphs into a check while `copied` is true and back when it ends. */
export function CopyMorphIcon({ copied, size = 18 }: { readonly copied: boolean; readonly size?: number }) {
  return (
    <span data-part="copy-icon" className={cn("chalk-copy-icon", copied && "chalk-copied")} style={size === 18 ? undefined : { width: size, height: size }} aria-hidden="true">
      <svg className="chalk-copy-source" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <svg className="chalk-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}

export interface ChalkCopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly text: string;
  /** The accessible name, which a wrapping tooltip repeats. */
  readonly label?: string;
  readonly announcement?: string;
  readonly showLabel?: boolean;
}

/**
 * The one copy control: a 36px round icon button whose icon morphs to a check and back after two seconds.
 * The button takes the ref and every other prop, so a tooltip or menu can use it as its trigger directly.
 */
export const ChalkCopyButton = forwardRef<HTMLButtonElement, ChalkCopyButtonProps>(function ChalkCopyButton({ text, label = "Copy link", announcement = "Link copied", showLabel = false, className, type = "button", onClick, ...props }, ref) {
  const { copied, error, copy } = useCopyText(text);
  return (
    <>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        data-part="copy-button"
        data-copied={copied}
        className={cn("chalk-copy", className)}
        {...props}
        onClick={(event) => {
          onClick?.(event);
          void copy();
        }}
      >
        <CopyMorphIcon copied={copied} />
        {showLabel ? <span className="chalk-copy-label">{label}</span> : null}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {error ? "Could not copy. Try again." : copied ? announcement : ""}
      </span>
    </>
  );
});
