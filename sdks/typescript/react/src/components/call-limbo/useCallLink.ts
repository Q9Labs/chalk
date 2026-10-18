import { useEffect, useState } from "react";

export function useCallLink(alone: boolean) {
  const [open, setOpen] = useState(alone);
  useEffect(() => setOpen(alone), [alone]);
  return { open, toggle: () => setOpen((current) => !current), close: () => setOpen(false) };
}
