import { useSyncExternalStore } from "react";
const KEY = "chalk_sounds";
const listeners = new Set<() => void>();
let fallback = true;
function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return fallback;
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
export function useSoundsSetting(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  return [
    enabled,
    (next) => {
      fallback = next;
      try {
        localStorage.setItem(KEY, next ? "on" : "off");
      } catch {
        /* Private or blocked storage: keep this page's setting. */
      }
      for (const listener of listeners) listener();
    },
  ];
}
