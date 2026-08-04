import type { SpaceClientStore, SpacePhase, SpacePhaseInput } from "../client-compat";
import { deriveSpacePhase } from "../client-compat";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

type ConferenceSnapshot = SpacePhaseInput["snapshot"];

const IDLE_SNAPSHOT: ConferenceSnapshot = {
  connectionStatus: "idle",
  failure: null,
};

const NOOP_UNSUBSCRIBE = () => undefined;

export type ConferencePhaseIntent = Pick<SpacePhaseInput, "hasAskedToJoin" | "hasAskedToLeave">;

export function useConferencePhase(session: Pick<SpaceClientStore, "subscribe" | "getSnapshot"> | null, intent: ConferencePhaseIntent, initialPhase?: SpacePhase): SpacePhase {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : NOOP_UNSUBSCRIBE), [session]);
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? IDLE_SNAPSHOT, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!session && intent.hasAskedToLeave) return "ended";
  if (!session && initialPhase) return initialPhase;
  return deriveSpacePhase({ snapshot, ...intent });
}

export function useConferencePhaseObserver(phase: SpacePhase, onPhaseChange?: (phase: SpacePhase) => void): void {
  const callbackRef = useRef(onPhaseChange);
  callbackRef.current = onPhaseChange;

  useEffect(() => {
    callbackRef.current?.(phase);
  }, [phase]);
}
