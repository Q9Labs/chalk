import type { ChalkParticipant, ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { useEffect, useRef } from "react";

export type ParticipantJoinedEvent = {
  readonly participant: ChalkParticipant;
};

export type ParticipantLeftEvent = {
  readonly participant: ChalkParticipant;
};

export type ScreenShareStartedEvent = {
  readonly participant: ChalkParticipant | null;
  readonly participantSessionId: string;
};

export type ScreenShareStoppedEvent = ScreenShareStartedEvent;

export type SessionEndedEvent = {
  readonly reason: "left" | "remote" | "failed";
};

export type ConferenceEventHandlers = {
  readonly onParticipantJoined?: (event: ParticipantJoinedEvent) => void;
  readonly onParticipantLeft?: (event: ParticipantLeftEvent) => void;
  readonly onScreenShareStarted?: (event: ScreenShareStartedEvent) => void;
  readonly onScreenShareStopped?: (event: ScreenShareStoppedEvent) => void;
  readonly onSessionEnded?: (event: SessionEndedEvent) => void;
};

type EventSnapshot = {
  readonly participants: ReadonlyMap<string, ChalkParticipant>;
  readonly screenShares: ReadonlySet<string>;
  readonly endReason: SessionEndedEvent["reason"] | null;
};

export function useConferenceEvents(snapshot: ChalkSessionSnapshot, handlers: ConferenceEventHandlers): void {
  const handlersRef = useRef(handlers);
  const previousRef = useRef<EventSnapshot | null>(null);
  handlersRef.current = handlers;

  useEffect(() => {
    const current = eventSnapshot(snapshot);
    const previous = previousRef.current;
    if (previous) {
      for (const [participantSessionId, participant] of current.participants) {
        if (!previous.participants.has(participantSessionId)) handlersRef.current.onParticipantJoined?.({ participant });
      }
      for (const [participantSessionId, participant] of previous.participants) {
        if (!current.participants.has(participantSessionId)) handlersRef.current.onParticipantLeft?.({ participant });
      }
      for (const participantSessionId of current.screenShares) {
        if (!previous.screenShares.has(participantSessionId)) {
          handlersRef.current.onScreenShareStarted?.({ participant: current.participants.get(participantSessionId) ?? null, participantSessionId });
        }
      }
      for (const participantSessionId of previous.screenShares) {
        if (!current.screenShares.has(participantSessionId)) {
          handlersRef.current.onScreenShareStopped?.({ participant: previous.participants.get(participantSessionId) ?? null, participantSessionId });
        }
      }
      if (current.endReason && !previous.endReason) handlersRef.current.onSessionEnded?.({ reason: current.endReason });
    }
    previousRef.current = current;
  }, [snapshot]);
}

function eventSnapshot(snapshot: ChalkSessionSnapshot): EventSnapshot {
  const participants = new Map(snapshot.participants.map((participant) => [participant.participantSessionId, participant] as const));
  const screenShares = new Set(snapshot.remoteMedia.filter((media) => media.source === "screen").map((media) => media.participantSessionId));
  const localParticipantSessionId = snapshot.subject?.participantSessionId;
  if (localParticipantSessionId && snapshot.localMedia.screen.state === "enabled") screenShares.add(localParticipantSessionId);

  return {
    participants,
    screenShares,
    endReason: getEndReason(snapshot),
  };
}

function getEndReason(snapshot: ChalkSessionSnapshot): SessionEndedEvent["reason"] | null {
  if (snapshot.failure?.code === "session_ended") return "remote";
  if (snapshot.state === "left") return "left";
  if (snapshot.state === "failed") return "failed";
  return null;
}
