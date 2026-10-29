import { useEffect, useState } from "react";

export function useCallLink(alone: boolean) {
  const [open, setOpen] = useState(alone);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- Keep existing link-card dismissal when another participant arrives.
  useEffect(() => {
    if (!alone) setOpen(false);
  }, [alone]);
  return { open, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
