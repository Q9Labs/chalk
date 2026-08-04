import type { SpaceParticipant, SpaceSnapshotView } from "../client-compat";
import { useEffect, useRef } from "react";

export type ParticipantJoinedEvent = {
  readonly participant: SpaceParticipant;
};

export type ParticipantLeftEvent = {
  readonly participant: SpaceParticipant;
};

export type ScreenShareStartedEvent = {
  readonly participant: SpaceParticipant | null;
  readonly participantId: string;
};

export type ScreenShareStoppedEvent = ScreenShareStartedEvent;

export type EpisodeEndedEvent = {
  readonly reason: "left" | "remote" | "failed";
};

export type ConferenceEventHandlers = {
  readonly onParticipantJoined?: (event: ParticipantJoinedEvent) => void;
  readonly onParticipantLeft?: (event: ParticipantLeftEvent) => void;
  readonly onScreenShareStarted?: (event: ScreenShareStartedEvent) => void;
  readonly onScreenShareStopped?: (event: ScreenShareStoppedEvent) => void;
  readonly onSessionEnded?: (event: EpisodeEndedEvent) => void;
};

type EventSnapshot = {
  readonly participants: ReadonlyMap<string, SpaceParticipant>;
  readonly screenShares: ReadonlySet<string>;
  readonly endReason: EpisodeEndedEvent["reason"] | null;
};

export function useConferenceEvents(snapshot: SpaceSnapshotView, handlers: ConferenceEventHandlers): void {
  const handlersRef = useRef(handlers);
  const previousRef = useRef<EventSnapshot | null>(null);
  handlersRef.current = handlers;

  useEffect(() => {
    const current = eventSnapshot(snapshot);
    const previous = previousRef.current;
    if (previous) {
      for (const [participantId, participant] of current.participants) {
        if (!previous.participants.has(participantId)) handlersRef.current.onParticipantJoined?.({ participant });
      }
      for (const [participantId, participant] of previous.participants) {
        if (!current.participants.has(participantId)) handlersRef.current.onParticipantLeft?.({ participant });
      }
      for (const participantId of current.screenShares) {
        if (!previous.screenShares.has(participantId)) {
          handlersRef.current.onScreenShareStarted?.({ participant: current.participants.get(participantId) ?? null, participantId });
        }
      }
      for (const participantId of previous.screenShares) {
        if (!current.screenShares.has(participantId)) {
          handlersRef.current.onScreenShareStopped?.({ participant: previous.participants.get(participantId) ?? null, participantId });
        }
      }
      if (current.endReason && !previous.endReason) handlersRef.current.onSessionEnded?.({ reason: current.endReason });
    }
    previousRef.current = current;
  }, [snapshot]);
}

function eventSnapshot(snapshot: SpaceSnapshotView): EventSnapshot {
  const participants = new Map(snapshot.participants.map((participant) => [participant.participantId, participant] as const));
  const screenShares = new Set(snapshot.remoteMedia.filter((media) => media.source === "screen").map((media) => media.participantId));
  const localParticipantId = snapshot.self?.participantId;
  if (localParticipantId && snapshot.localMedia.screen.state === "enabled") screenShares.add(localParticipantId);

  return {
    participants,
    screenShares,
    endReason: getEndReason(snapshot),
  };
}

function getEndReason(snapshot: SpaceSnapshotView): EpisodeEndedEvent["reason"] | null {
  if (snapshot.failure?.code === "episode.ended") return "remote";
  if (snapshot.connectionStatus === "left") return "left";
  if (snapshot.connectionStatus === "failed") return "failed";
  return null;
}
