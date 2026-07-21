"use client";

import type { ChalkLocalMedia, ChalkMediaSource, ChalkParticipant, ChalkRemoteMedia, ChalkSessionActions, ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";

import { ChalkSessionContext } from "./context";

export type ChalkSelector<T> = (snapshot: ChalkSessionSnapshot) => T;
export type ChalkSelectionEquality<T> = (previous: T, next: T) => boolean;

type SelectionCache<T> = {
  readonly selector: ChalkSelector<T>;
  readonly snapshot: ChalkSessionSnapshot;
  readonly selection: T;
};

const selectSnapshot = (snapshot: ChalkSessionSnapshot) => snapshot;
const selectParticipants = (snapshot: ChalkSessionSnapshot) => snapshot.participants;
const selectLocalMedia = (snapshot: ChalkSessionSnapshot) => snapshot.localMedia;
const selectRemoteMedia = (snapshot: ChalkSessionSnapshot) => snapshot.remoteMedia;

export function useChalkSession(): ChalkSessionStore {
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

export function useChalkSnapshot(): ChalkSessionSnapshot {
  return useChalkSelector(selectSnapshot);
}

export function useParticipants(): readonly ChalkParticipant[] {
  return useChalkSelector(selectParticipants);
}

export function useLocalMedia(): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  return useChalkSelector(selectLocalMedia);
}

export function useRemoteMedia(): readonly ChalkRemoteMedia[] {
  return useChalkSelector(selectRemoteMedia);
}

export function useChalkActions(): ChalkSessionActions {
  const session = useChalkSession();

  return useMemo<ChalkSessionActions>(
    () => ({
      join: () => session.join(),
      leave: () => session.leave(),
      setMicrophoneEnabled: (enabled) => session.setMicrophoneEnabled(enabled),
      setCameraEnabled: (enabled) => session.setCameraEnabled(enabled),
      startScreenShare: () => session.startScreenShare(),
      stopScreenShare: () => session.stopScreenShare(),
      setHandRaised: (raised) => session.setHandRaised(raised),
      setDisplayName: (displayName) => session.setDisplayName(displayName),
      setAdmissionPolicy: (policy) => session.setAdmissionPolicy(policy),
      setParticipantRole: (participantSessionId, role) => session.setParticipantRole(participantSessionId, role),
      transferHost: (participantSessionId) => session.transferHost(participantSessionId),
      admitParticipant: (admissionRequestId) => session.admitParticipant(admissionRequestId),
      denyAdmission: (admissionRequestId) => session.denyAdmission(admissionRequestId),
      muteParticipant: (participantSessionId) => session.muteParticipant(participantSessionId),
      stopParticipantCamera: (participantSessionId) => session.stopParticipantCamera(participantSessionId),
      stopParticipantScreenShare: (participantSessionId) => session.stopParticipantScreenShare(participantSessionId),
      removeParticipant: (participantSessionId) => session.removeParticipant(participantSessionId),
      endSession: () => session.endSession(),
    }),
    [session],
  );
}
