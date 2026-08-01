import type { ChalkSessionStore, ConferencePhase, ConferencePhaseInput } from "@q9labsai/chalk-client";
import { useCallback, useSyncExternalStore } from "react";

import { deriveConferencePhase } from "@q9labsai/chalk-client";

type InitialPhase = "lobby" | "joining" | "meeting" | "end";
type ConferenceSnapshot = ConferencePhaseInput["snapshot"];

const IDLE_SNAPSHOT: ConferenceSnapshot = {
  state: "idle",
  failure: null,
  connection: { sync: "idle", media: "idle" },
};
const NOOP_UNSUBSCRIBE = () => undefined;

export type ConferencePhaseIntent = Pick<ConferencePhaseInput, "hasAskedToJoin" | "hasAskedToLeave">;

export function useConferencePhase(session: Pick<ChalkSessionStore, "subscribe" | "getSnapshot"> | null, intent: ConferencePhaseIntent, initialPhase?: InitialPhase): ConferencePhase {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : NOOP_UNSUBSCRIBE), [session]);
  const getSnapshot = useCallback((): ConferenceSnapshot => session?.getSnapshot() ?? IDLE_SNAPSHOT, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!session && initialPhase) return initialConferencePhase(initialPhase);
  return deriveConferencePhase({ snapshot, ...intent });
}

function initialConferencePhase(phase: InitialPhase): ConferencePhase {
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
