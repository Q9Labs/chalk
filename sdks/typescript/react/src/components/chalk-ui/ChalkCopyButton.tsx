import { useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
export function ChalkCopyButton({ text, label = "Copy link", announcement = "Link copied" }: { readonly text: string; readonly label?: string; readonly announcement?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  };
  return (
    <>
      <button type="button" aria-label={label} data-part="copy-button" data-copied={copied} className="chalk-copy" onClick={() => void copy()}>
        <span data-part="copy-icon" className={cn("chalk-copy-icon", copied && "chalk-copied")} aria-hidden="true">
          <svg className="chalk-copy-source" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <svg className="chalk-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {error ? "Could not copy. Try again." : copied ? announcement : ""}
      </span>
    </>
  );
}
