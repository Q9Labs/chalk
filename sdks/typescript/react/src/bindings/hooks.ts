"use client";

import {
  canDrawWhiteboard,
  type Capability,
  type ChatReaction,
  type ChatMessage,
  type ChatSlice,
  type ConnectionSlice,
  type MediaSlice,
  type OfflineSlice,
  type ParticipantsSlice,
  type ReactionsSlice,
  type RecordingSlice,
  type SelfSlice,
  type SpaceClient,
  type SpaceSnapshot,
  type WhiteboardSlice,
  type PresentingSlice,
} from "@q9labsai/chalk-client";
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";

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
const selectOffline = (snapshot: SpaceSnapshot): OfflineSlice => snapshot.offline;
const selectReactions = (snapshot: SpaceSnapshot): ReactionsSlice => snapshot.reactions;
const selectRecording = (snapshot: SpaceSnapshot): RecordingSlice => snapshot.recording;
const selectWhiteboard = (snapshot: SpaceSnapshot): WhiteboardSlice => snapshot.whiteboard;
const selectPresenting = (snapshot: SpaceSnapshot): PresentingSlice => snapshot.presenting;

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

/** Focus state and commands. `own` is this device's report; roster entries carry the states the viewer may see. */
export function useFocus() {
  const client = useSpaceClient();
  const self = useSelf();
  const participants = useParticipants();
  return useMemo(
    () => ({
      ...client.focus,
      own: participants.roster.find((participant) => participant.participantId === self.participantId)?.focus,
      participants: participants.roster.filter((participant) => participant.focus !== undefined),
    }),
    [client.focus, participants.roster, self.participantId],
  );
}

export function useMedia(): MediaSlice {
  return useSnapshotSlice(selectMedia);
}

export type MessageReaction = ChatReaction & { readonly isMine: boolean };
export type ReactChatMessage = Omit<ChatMessage, "reactions"> & { readonly reactions: readonly MessageReaction[] };
export type UseChatResult = Omit<ChatSlice, "messages"> & { readonly messages: readonly ReactChatMessage[]; readonly react: SpaceClient["chat"]["react"] };

export function useChat(): UseChatResult {
  const chat = useSnapshotSlice(selectChat);
  const self = useSelf();
  const client = useSpaceClient();
  return useMemo(
    () => ({ ...chat, react: client.chat.react, messages: chat.messages.map((message) => ({ ...message, reactions: (message.reactions ?? []).map((reaction) => ({ ...reaction, isMine: self.participantId !== null && reaction.participantIds.includes(self.participantId) })) })) }),
    [chat, client, self.participantId],
  );
}

/** Actions held while the connection recovers, and whether the user still has to decide about them. */
export function useOffline(): OfflineSlice {
  return useSnapshotSlice(selectOffline);
}

export function useReactions(): ReactionsSlice {
  return useSnapshotSlice(selectReactions);
}

export function useRecording(): RecordingSlice {
  return useSnapshotSlice(selectRecording);
}

export function useWhiteboard(): WhiteboardSlice {
  return useSnapshotSlice(selectWhiteboard);
}

export function usePresenting(): PresentingSlice {
  return useSnapshotSlice(selectPresenting);
}

export function useCan(capability: Capability): boolean {
  return useSelf().can(capability);
}

/** Whether this person can draw on the board. Sync decides from the call's policy, their role and the host's choice for them; until the board subscription is live, the role default stands in. A Sync without the drawing policy doesn't report role changes to the board, so there the live role still limits drawing. */
export function useCanDrawWhiteboard(): boolean {
  return canDrawWhiteboard(useWhiteboard(), useCan("drawWhiteboard"));
}

/** Local capture state and the action that opens the browser's share picker. */
export function useScreenShare() {
  const client = useSpaceClient();
  const { screenShare } = useMedia();
  return { ...screenShare, setEnabled: client.media.setScreenShareEnabled };
}
