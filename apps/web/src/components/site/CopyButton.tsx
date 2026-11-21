import { useEffect, useState } from "react";

import { Icon } from "./Icon";

/** The site's copy control: a round button whose copy icon morphs into a check for two seconds. Its name stays put; the status line says what happened. */
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
      <button type="button" className="ib copy" data-copied={copied || undefined} aria-label={label} data-tip onClick={() => void copy()}>
        <Icon name="copy" />
        <Icon name="check" />
      </button>
      <span className="sr" role="status">
        {copied ? "Copied" : state === "failed" ? "Copy failed. Select the text to copy it." : ""}
      </span>
    </>
  );
}
