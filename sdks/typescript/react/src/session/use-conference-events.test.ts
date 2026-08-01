// @vitest-environment happy-dom

import type { ChalkParticipant, ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConferenceEvents, type ConferenceEventHandlers } from "./use-conference-events";

describe("useConferenceEvents", () => {
  it("emits participant, screen-share, and session-end facts from snapshot changes", () => {
    const handlers: Required<ConferenceEventHandlers> = {
      onParticipantJoined: vi.fn(),
      onParticipantLeft: vi.fn(),
      onScreenShareStarted: vi.fn(),
      onScreenShareStopped: vi.fn(),
      onSessionEnded: vi.fn(),
    };
    const first = createSnapshot();
    const participant = createParticipant("participant-1");
    const track = { readyState: "live", kind: "video" } as MediaStreamTrack;
    const { rerender } = renderHook(({ snapshot }) => useConferenceEvents(snapshot, handlers), { initialProps: { snapshot: first } });

    act(() => {
      rerender({
        snapshot: {
          ...first,
          state: "live",
          connection: { sync: "healthy", media: "healthy" },
          participants: [participant],
          remoteMedia: [{ participantSessionId: participant.participantSessionId, source: "screen", publicationId: "publication-1", track }],
        },
      });
    });

    expect(handlers.onParticipantJoined).toHaveBeenCalledWith({ participant });
    expect(handlers.onScreenShareStarted).toHaveBeenCalledWith({ participant, participantSessionId: participant.participantSessionId });

    act(() => {
      rerender({ snapshot: { ...first, state: "failed", failure: { code: "session_ended", action: null, recoverable: false, message: "The session ended" } } });
    });

    expect(handlers.onParticipantLeft).toHaveBeenCalledWith({ participant });
    expect(handlers.onScreenShareStopped).toHaveBeenCalledWith({ participant, participantSessionId: participant.participantSessionId });
    expect(handlers.onSessionEnded).toHaveBeenCalledWith({ reason: "remote" });
  });
});

function createSnapshot(overrides: Partial<ChalkSessionSnapshot> = {}): ChalkSessionSnapshot {
  return {
    state: "idle",
    subject: null,
    connection: { sync: "idle", media: "idle" },
    admissionPolicy: null,
    participants: [],
    admissionRequests: [],
    localMedia: {
      microphone: { source: "microphone", state: "unavailable", track: null },
      camera: { source: "camera", state: "unavailable", track: null },
      screen: { source: "screen", state: "unavailable", track: null },
    },
    remoteMedia: [],
    failure: null,
    roomActions: { phase: "disabled", version: null, capabilities: [], error: null },
    participantRoomActionCapabilities: {},
    participantMedia: {},
    reactions: [],
    chat: {
      status: "idle",
      messages: [],
      pending: [],
      hasOlder: false,
      historyTruncated: false,
      retainedFloorSequence: null,
      unreadCount: 0,
      readReceipts: [],
      localReadThroughSequence: null,
      error: null,
    },
    whiteboard: { status: "unsubscribed", sceneId: null, revision: null, capabilities: [], canDraw: false, canClear: false, error: null },
    incomingMediaRequests: [],
    ...overrides,
  };
}

function createParticipant(participantSessionId: string): ChalkParticipant {
  return {
    participantSessionId,
    displayName: "Grace",
    handRaised: false,
    role: "participant",
    eligibleRoles: ["participant"],
    capabilities: ["subscribe"],
  };
}
