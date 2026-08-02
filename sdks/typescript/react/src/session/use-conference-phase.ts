import type { ChalkSessionStore, ConferencePhase, ConferencePhaseInput } from "@q9labsai/chalk-client";
import { deriveConferencePhase } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

type ConferenceSnapshot = ConferencePhaseInput["snapshot"];

const IDLE_SNAPSHOT: ConferenceSnapshot = {
  state: "idle",
  failure: null,
  connection: { sync: "idle", media: "idle" },
};

const NOOP_UNSUBSCRIBE = () => undefined;

export type ConferencePhaseIntent = Pick<ConferencePhaseInput, "hasAskedToJoin" | "hasAskedToLeave">;

export function useConferencePhase(session: Pick<ChalkSessionStore, "subscribe" | "getSnapshot"> | null, intent: ConferencePhaseIntent, initialPhase?: ConferencePhase): ConferencePhase {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : NOOP_UNSUBSCRIBE), [session]);
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? IDLE_SNAPSHOT, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!session && intent.hasAskedToLeave) return "ended";
  if (!session && initialPhase) return initialPhase;
  return deriveConferencePhase({ snapshot, ...intent });
}

export function useConferencePhaseObserver(phase: ConferencePhase, onPhaseChange?: (phase: ConferencePhase) => void): void {
  const callbackRef = useRef(onPhaseChange);
  callbackRef.current = onPhaseChange;

  useEffect(() => {
    callbackRef.current?.(phase);
  }, [phase]);
}
