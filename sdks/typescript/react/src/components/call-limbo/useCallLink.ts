import { useState } from "react";

/**
 * The reveal at the start of a call: the call menu opens by itself, with the QR code showing, for a host who is alone once
 * the call is live. Until then (joining, reconnecting) there is no call to share yet, so it waits. It closes when someone joins.
 */
export function useCallLink(alone: boolean, live: boolean) {
  const [open, setOpen] = useState(false);
  const [decided, setDecided] = useState(false);
  const [wasAlone, setWasAlone] = useState(alone);
  if (!decided && live) {
    setDecided(true);
    setOpen(alone);
  }
  if (wasAlone !== alone) {
    setWasAlone(alone);
    if (!alone) setOpen(false);
  }
  return { open: open && live, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
