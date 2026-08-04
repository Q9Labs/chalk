import type { ChalkSessionStore, NativeLifecyclePhase, NativeLifecyclePhaseInput } from "../client-compat";
import { useCallback, useSyncExternalStore } from "react";

import { deriveNativeLifecyclePhase } from "../client-compat";

type InitialPhase = "lobby" | "joining" | "meeting" | "end";
type ConferenceSnapshot = NativeLifecyclePhaseInput["snapshot"];

const IDLE_SNAPSHOT: ConferenceSnapshot = {
  state: "idle",
  failure: null,
  connection: { sync: "idle", media: "idle" },
};
const NOOP_UNSUBSCRIBE = () => undefined;

export type ConferencePhaseIntent = Pick<NativeLifecyclePhaseInput, "hasAskedToJoin" | "hasAskedToLeave">;

export function useConferencePhase(session: Pick<ChalkSessionStore, "subscribe" | "getSnapshot"> | null, intent: ConferencePhaseIntent, initialPhase?: InitialPhase): NativeLifecyclePhase {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : NOOP_UNSUBSCRIBE), [session]);
  const getSnapshot = useCallback((): ConferenceSnapshot => session?.getSnapshot() ?? IDLE_SNAPSHOT, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!session && initialPhase) return initialConferencePhase(initialPhase);
  return deriveNativeLifecyclePhase({ snapshot, ...intent });
}

function initialConferencePhase(phase: InitialPhase): NativeLifecyclePhase {
  switch (phase) {
    case "lobby":
      return "prejoin";
    case "joining":
      return "joining";
    case "meeting":
      return "active";
    case "end":
      return "ended";
  }
}
