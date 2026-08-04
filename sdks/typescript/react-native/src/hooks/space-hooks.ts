import type { Capability, SpaceSnapshot } from "@q9labsai/chalk-client";
import { useCallback, useSyncExternalStore } from "react";

import { useSpaceClient } from "../context/space-client-context";

function useSpaceSlice<TSlice extends keyof SpaceSnapshot>(slice: TSlice): SpaceSnapshot[TSlice] {
  const client = useSpaceClient();
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot()[slice], [client, slice]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useConnection(): SpaceSnapshot["connection"] {
  return useSpaceSlice("connection");
}

export function useSelf(): SpaceSnapshot["self"] {
  return useSpaceSlice("self");
}

export function useParticipants(): SpaceSnapshot["participants"] {
  return useSpaceSlice("participants");
}

export function useMedia(): SpaceSnapshot["media"] {
  return useSpaceSlice("media");
}

export function useChat(): SpaceSnapshot["chat"] {
  return useSpaceSlice("chat");
}

export function useReactions(): SpaceSnapshot["reactions"] {
  return useSpaceSlice("reactions");
}

export function useWhiteboard(): SpaceSnapshot["whiteboard"] {
  return useSpaceSlice("whiteboard");
}

export function useCan(capability: Capability): boolean {
  return useSelf().can(capability);
}
