import { useSyncExternalStore, type ReactNode } from "react";

/** UI-only state a development harness forces on the call. Nothing sets it in a real call. */
export type DevScenario = {
  /** Opens this sheet as if the user had opened it; the user can still close it. */
  readonly sheet?: "more" | "people";
  /** Opens this menu as if the user had opened it. */
  readonly menu?: "leave";
  /** Content drawn in a tile in place of the camera, keyed by participant id. */
  readonly videoSlots?: Readonly<Record<string, ReactNode>>;
  /** Content drawn in place of a person's shared screen, keyed by the sharer's participant id. */
  readonly screenSlots?: Readonly<Record<string, ReactNode>>;
  /** The shared screen's width over height (S1 to S4). A real share is drawn as 16:9. */
  readonly shareAspect?: number;
  /** Spotlight (G1) or Grid (G2), as if the user had chosen it. */
  readonly layout?: "spotlight" | "grid";
  /** Pins this participant, as if the user had pinned them. */
  readonly pinned?: string;
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
