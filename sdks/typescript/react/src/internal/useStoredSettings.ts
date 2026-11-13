import { useSyncExternalStore } from "react";

type StoredToggle = () => readonly [boolean, (next: boolean) => void];

/** An on/off setting that persists in localStorage and stays in sync across hooks and tabs. */
function createStoredToggle(key: string): StoredToggle {
  const listeners = new Set<() => void>();
  let fallback = true;
  let storageUnavailable = false;

  function read(): boolean {
    if (storageUnavailable) return fallback;
    try {
      return localStorage.getItem(key) !== "off";
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

  function set(next: boolean): void {
    fallback = next;
    try {
      localStorage.setItem(key, next ? "on" : "off");
    } catch {
      storageUnavailable = true;
      /* Private or blocked storage: keep this page's setting. */
    }
    for (const listener of listeners) listener();
  }

  return function useToggle() {
    return [useSyncExternalStore(subscribe, read, () => true), set];
  };
}

export const useMirrorSetting = createStoredToggle("chalk_mirror");
export const useSoundsSetting = createStoredToggle("chalk_sounds");
