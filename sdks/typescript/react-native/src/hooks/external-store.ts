import { useCallback, useSyncExternalStore } from "react";

export interface ExternalStateManager<State> {
  getState: () => State;
  subscribe: (listener: (state: State) => void) => () => void;
}

export interface ExternalStore<State> {
  getSnapshot: () => State;
  subscribe: (listener: () => void) => () => void;
}

export function useManagerState<State>(manager: ExternalStateManager<State>): State {
  const subscribe = useCallback((onStoreChange: () => void) => manager.subscribe(() => onStoreChange()), [manager]);
  const getSnapshot = useCallback(() => manager.getState(), [manager]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
