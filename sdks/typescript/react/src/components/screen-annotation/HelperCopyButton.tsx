import { useRef, useState } from "react";

/** One-click copy with a visible and announced "Copied". */
export function HelperCopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <>
      <button type="button" className="chalk-ann-textbtn" aria-label={label} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
