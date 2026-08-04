"use client";

import type { ChalkWhiteboardV1Transport, SpaceClientActions, SpaceClientStore, SpaceLocalMedia, SpaceMediaSource, SpaceParticipant, SpaceRemoteMedia, SpaceSnapshotView } from "../client-compat";
import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";

import { ChalkSessionContext } from "./context";

export type ChalkSelector<T> = (snapshot: SpaceSnapshotView) => T;
export type ChalkSelectionEquality<T> = (previous: T, next: T) => boolean;

type SelectionCache<T> = {
  readonly selector: ChalkSelector<T>;
  readonly snapshot: SpaceSnapshotView;
  readonly selection: T;
};

const selectSnapshot = (snapshot: SpaceSnapshotView) => snapshot;
const selectParticipants = (snapshot: SpaceSnapshotView) => snapshot.participants;
const selectLocalMedia = (snapshot: SpaceSnapshotView) => snapshot.localMedia;
const selectRemoteMedia = (snapshot: SpaceSnapshotView) => snapshot.remoteMedia;

export function useChalkSession(): SpaceClientStore {
  const session = useContext(ChalkSessionContext);

  if (session === null) {
    throw new Error("Chalk session hooks must be used within a ChalkProvider.");
  }

  return session;
}

export function useChalkSelector<T>(selector: ChalkSelector<T>, isEqual: ChalkSelectionEquality<T> = Object.is): T {
  const session = useChalkSession();
  const cacheRef = useRef<SelectionCache<T> | null>(null);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSelection = useCallback(() => {
    const snapshot = session.getSnapshot();
    const cached = cacheRef.current;

    if (cached?.snapshot === snapshot && cached.selector === selector) {
      return cached.selection;
    }

    const selection = selector(snapshot);
    let stableSelection = selection;
    if (cached !== null && isEqual(cached.selection, selection)) {
      stableSelection = cached.selection;
    }
    cacheRef.current = { selector, snapshot, selection: stableSelection };
    return stableSelection;
  }, [isEqual, selector, session]);

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

export function useChalkSnapshot(): SpaceSnapshotView {
  return useChalkSelector(selectSnapshot);
}

export function useParticipants(): readonly SpaceParticipant[] {
  return useChalkSelector(selectParticipants);
}

export function useLocalMedia(): Readonly<Record<SpaceMediaSource, SpaceLocalMedia>> {
  return useChalkSelector(selectLocalMedia);
}

export function useRemoteMedia(): readonly SpaceRemoteMedia[] {
  return useChalkSelector(selectRemoteMedia);
}

export function useChalkActions(): SpaceClientActions {
  const session = useChalkSession();

  return useMemo<SpaceClientActions>(
    () => ({
      join: () => session.join(),
      leave: () => session.leave(),
      setMicrophoneEnabled: (enabled) => session.setMicrophoneEnabled(enabled),
      setCameraEnabled: (enabled) => session.setCameraEnabled(enabled),
      startScreenShare: () => session.startScreenShare(),
      stopScreenShare: () => session.stopScreenShare(),
      setHandRaised: (raised) => session.setHandRaised(raised),
      setDisplayName: (displayName) => session.setDisplayName(displayName),
      assignParticipantRole: (participantId, role) => session.assignParticipantRole(participantId, role),
      assignOwner: (participantId) => session.assignOwner(participantId),
      admitParticipant: (requestId) => session.admitParticipant(requestId),
      denyAdmission: (requestId) => session.denyAdmission(requestId),
      muteParticipant: (participantId) => session.muteParticipant(participantId),
      stopParticipantCamera: (participantId) => session.stopParticipantCamera(participantId),
      stopParticipantScreenShare: (participantId) => session.stopParticipantScreenShare(participantId),
      removeParticipant: (participantId) => session.removeParticipant(participantId),
      endEpisode: () => session.endEpisode(),
      sendReaction: (reaction) => session.sendReaction(reaction),
      sendChatMessage: (input) => session.sendChatMessage(input),
      retryChatMessage: (clientMessageId) => session.retryChatMessage(clientMessageId),
      loadOlderChatMessages: () => session.loadOlderChatMessages(),
      markChatRead: (throughSequence) => session.markChatRead(throughSequence),
      requestUnmute: (participantId) => session.requestUnmute(participantId),
      requestStartCamera: (participantId) => session.requestStartCamera(participantId),
      acceptMediaRequest: (requestId) => session.acceptMediaRequest(requestId),
      declineMediaRequest: (requestId) => session.declineMediaRequest(requestId),
    }),
    [session],
  );
}

export function useChalkWhiteboardTransport(): ChalkWhiteboardV1Transport {
  const session = useChalkSession();
  if (!session.whiteboard) {
    throw new Error("The whiteboard-v1 transport is not available in this environment.");
  }
  return session.whiteboard;
}
