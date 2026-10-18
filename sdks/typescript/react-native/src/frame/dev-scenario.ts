import { useSyncExternalStore, type ReactNode } from "react";

/** UI-only state a development harness forces on the call. Nothing sets it in a real call. */
export type DevScenario = {
  /** Opens this sheet as if the user had opened it; the user can still close it. */
  readonly sheet?: "more" | "people" | "chat";
  /** Opens this menu as if the user had opened it. */
  readonly menu?: "leave";
  /** Content drawn in a tile in place of the camera, keyed by participant id. */
  readonly videoSlots?: Readonly<Record<string, ReactNode>>;
};

const empty: DevScenario = {};
let scenario = empty;
const listeners = new Set<() => void>();

export function setDevScenario(next: DevScenario | null): void {
  scenario = next ?? empty;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDevScenario(): DevScenario {
  return useSyncExternalStore(
    subscribe,
    () => scenario,
    () => scenario,
  );
}
