"use client";

import type { Capability, ChatSlice, ConnectionSlice, MediaSlice, ParticipantsSlice, ReactionsSlice, SelfSlice, SpaceClient, SpaceSnapshot, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useCallback, useContext, useSyncExternalStore } from "react";

import { SpaceClientContext } from "./context";

function useSnapshotSlice<T>(select: (snapshot: SpaceSnapshot) => T): T {
  const client = useSpaceClient();
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => select(client.getSnapshot()), [client, select]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const selectConnection = (snapshot: SpaceSnapshot): ConnectionSlice => snapshot.connection;
const selectSelf = (snapshot: SpaceSnapshot): SelfSlice => snapshot.self;
const selectParticipants = (snapshot: SpaceSnapshot): ParticipantsSlice => snapshot.participants;
const selectMedia = (snapshot: SpaceSnapshot): MediaSlice => snapshot.media;
const selectChat = (snapshot: SpaceSnapshot): ChatSlice => snapshot.chat;
const selectReactions = (snapshot: SpaceSnapshot): ReactionsSlice => snapshot.reactions;
const selectWhiteboard = (snapshot: SpaceSnapshot): WhiteboardSlice => snapshot.whiteboard;

export function useSpaceClient(): SpaceClient {
  const client = useContext(SpaceClientContext);

  if (client === null) {
    throw new Error("Chalk hooks must be used within a ChalkProvider.");
  }

  return client;
}

export function useConnection(): ConnectionSlice {
  return useSnapshotSlice(selectConnection);
}

export function useSelf(): SelfSlice {
  return useSnapshotSlice(selectSelf);
}

export function useParticipants(): ParticipantsSlice {
  return useSnapshotSlice(selectParticipants);
}

export function useMedia(): MediaSlice {
  return useSnapshotSlice(selectMedia);
}

export function useChat(): ChatSlice {
  return useSnapshotSlice(selectChat);
}

export function useReactions(): ReactionsSlice {
  return useSnapshotSlice(selectReactions);
}

export function useWhiteboard(): WhiteboardSlice {
  return useSnapshotSlice(selectWhiteboard);
}

export function useCan(capability: Capability): boolean {
  return useSelf().can(capability);
}
