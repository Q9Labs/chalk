import { useState } from "react";

export function useCallLink(alone: boolean) {
  const [open, setOpen] = useState(alone);
  const [wasAlone, setWasAlone] = useState(alone);
  if (wasAlone !== alone) {
    setWasAlone(alone);
    if (!alone) setOpen(false);
  }
  return { open, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
