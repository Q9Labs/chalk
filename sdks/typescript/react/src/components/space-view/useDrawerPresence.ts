import { useEffect, useState } from "react";

export type DrawerState = "open" | "closing" | "closed";

/** Matches `--chalk-duration-normal`, which drives the drawer's exit animation. */
export const DRAWER_EXIT_MS = 200;

export interface DrawerPresence<T> {
  /** The panel to render: the live one while open, the last one while the exit animation runs. */
  readonly panel: T | null;
  readonly state: DrawerState;
}

/** Keeps the last panel mounted for `exitMs` after it is cleared so the drawer can animate out. */
export function useDrawerPresence<T>(panel: T | null, exitMs: number): DrawerPresence<T> {
  const [retained, setRetained] = useState<T | null>(panel);
  const [state, setState] = useState<DrawerState>(panel === null ? "closed" : "open");

  useEffect(() => {
    if (panel !== null) {
      setRetained(panel);
      setState("open");
      return;
    }
    setState((current) => (current === "closed" ? "closed" : "closing"));
    const timer = setTimeout(() => {
      setState("closed");
      setRetained(null);
    }, exitMs);
    return () => clearTimeout(timer);
  }, [exitMs, panel]);

  return { panel: state === "closed" ? null : retained, state };
}
