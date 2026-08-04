// @vitest-environment happy-dom

import type { SpaceParticipant, SpaceSnapshotView } from "../client-compat";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConferenceEvents, type ConferenceEventHandlers } from "./use-conference-events";
import { createSpaceSnapshot } from "./space-client.test.helpers";

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
          connectionStatus: "live",
          participants: [participant],
          remoteMedia: [{ participantId: participant.participantId, source: "screen", publicationId: "publication-1", track }],
        },
      });
    });

    expect(handlers.onParticipantJoined).toHaveBeenCalledWith({ participant });
    expect(handlers.onScreenShareStarted).toHaveBeenCalledWith({ participant, participantId: participant.participantId });

    act(() => {
      rerender({ snapshot: { ...first, connectionStatus: "failed", failure: { code: "episode.ended", recoverable: false, message: "The episode ended" } } });
    });

    expect(handlers.onParticipantLeft).toHaveBeenCalledWith({ participant });
    expect(handlers.onScreenShareStopped).toHaveBeenCalledWith({ participant, participantId: participant.participantId });
    expect(handlers.onSessionEnded).toHaveBeenCalledWith({ reason: "remote" });
  });
});

const createSnapshot = (overrides: Partial<SpaceSnapshotView> = {}) => createSpaceSnapshot(overrides);

function createParticipant(participantId: string): SpaceParticipant {
  return {
    participantId,
    displayName: "Grace",
    handRaised: false,
    role: "participant",
    eligibleRoles: ["participant"],
    capabilities: ["subscribe"],
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
  };
}
