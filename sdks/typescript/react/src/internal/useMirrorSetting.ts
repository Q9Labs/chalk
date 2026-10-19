import { useSyncExternalStore } from "react";

const KEY = "chalk_mirror";
const listeners = new Set<() => void>();
let fallback = true;
let storageUnavailable = false;

function read(): boolean {
  if (storageUnavailable) return fallback;
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    storageUnavailable = true;
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

export function useMirrorSetting(): readonly [boolean, (mirrored: boolean) => void] {
  const mirrored = useSyncExternalStore(subscribe, read, () => true);
  return [mirrored, setMirrored];
}

function setMirrored(next: boolean): void {
  fallback = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    storageUnavailable = true;
    /* Private or blocked storage: keep this page's setting. */
  }
  for (const listener of listeners) listener();
}
