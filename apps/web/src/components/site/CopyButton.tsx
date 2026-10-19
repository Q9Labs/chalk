import { useEffect, useState } from "react";

import { Icon } from "./Icon";

/** The call's copy control: a round button whose icon turns into a check for two seconds. */
export function CopyButton({ text, label = "Copy" }: { readonly text: string | (() => string); readonly label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const copied = state === "copied";
  return (
    <>
      <button type="button" className={copied ? "ib ok" : "ib"} aria-label={copied ? "Copied" : label} data-tip onClick={() => void copy()}>
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <span className="sr" role="status">
        {copied ? "Copied" : state === "failed" ? "Copy failed. Select the text to copy it." : ""}
      </span>
    </>
  );
}
