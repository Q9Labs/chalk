import type { OfflineActionsPolicy } from "@q9labsai/chalk-client";
import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "chalk:offline-actions-policy";
const listeners = new Set<() => void>();
let memoryPolicy: OfflineActionsPolicy = "ask";

function isPolicy(value: string | null): value is OfflineActionsPolicy {
  return value === "ask" || value === "send" || value === "discard";
}

function read(): OfflineActionsPolicy {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPolicy(stored) ? stored : "ask";
  } catch {
    return memoryPolicy;
  }
}

function write(policy: OfflineActionsPolicy): void {
  memoryPolicy = policy;
  try {
    if (policy === "ask") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, policy);
  } catch {
    // Storage is unavailable (private mode); the choice lasts until the page closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The remembered answer to "send or discard actions made while offline". "ask" means nothing is remembered. */
export function useOfflineActionsPolicy(): readonly [OfflineActionsPolicy, (policy: OfflineActionsPolicy) => void] {
  const policy = useSyncExternalStore(subscribe, read, () => "ask" as const);
  const setPolicy = useCallback((next: OfflineActionsPolicy) => write(next), []);
  return [policy, setPolicy];
}
