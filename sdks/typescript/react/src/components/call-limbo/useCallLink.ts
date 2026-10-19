import { useEffect, useState } from "react";

export function useCallLink(alone: boolean) {
  const [open, setOpen] = useState(alone);
  useEffect(() => {
    if (!alone) setOpen(false);
  }, [alone]);
  return { open, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
