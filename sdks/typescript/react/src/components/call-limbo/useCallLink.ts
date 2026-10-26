import { useEffect, useState } from "react";

export function useCallLink(alone: boolean) {
  const [open, setOpen] = useState(alone);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing link-card dismissal when another participant arrives.
  useEffect(() => {
    if (!alone) setOpen(false);
  }, [alone]);
  return { open, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
