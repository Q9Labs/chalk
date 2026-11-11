import { useEffect, useRef, useState } from "react";

const COPIED_MS = 2000;

/** Copies `text` to the clipboard and reports `copied` for two seconds, or `error` when the browser refuses. */
export function useCopyText(text: string) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [timer] Cancel the event-created copied-feedback timeout on unmount.
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setError(true);
    }
  };
  return { copied, error, copy };
}
