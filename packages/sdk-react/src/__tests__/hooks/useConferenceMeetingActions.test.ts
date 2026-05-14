import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useConferenceMeetingActions } from "../../components/full/video-conference/useConferenceMeetingActions";

describe("useConferenceMeetingActions", () => {
  it("does not play a local-only hand-raise sound shortcut", () => {
    const play = vi.fn(() => {});
    const toggleHand = vi.fn(() => {});
    const incrementHandRaiseCount = vi.fn(() => {});

    const { result } = renderHook(() =>
      useConferenceMeetingActions({
        clearDisconnectGraceTimeout: () => {},
        setShowLeaveConfirm: () => {},
        setIsExiting: () => {},
        setIsDisconnectGraceActive: () => {},
        leave: async () => {},
        play,
        onEnd: undefined,
        buildEndData: () => ({
          roomId: "room-1",
          roomName: "Room",
          durationSeconds: 0,
          participantCount: 1,
          messageCount: 0,
          recordingUsed: false,
          recordingDurationSeconds: 0,
          screenShareUsed: false,
          whiteboardUsed: false,
          reactionCount: 0,
          handRaiseCount: 0,
          transcriptLineCount: 0,
        }),
        setPhase: () => {},
        onLeave: undefined,
        setSupportCode: () => {},
        resetForRejoin: () => {},
        media: {
          toggleAudio: () => {},
          toggleVideo: () => {},
        },
        screenShare: {
          toggle: async () => {},
        },
        recording: {
          toggle: () => {},
        },
        interactions: {
          isHandRaised: false,
          toggleHand,
          sendReaction: () => {},
        },
        incrementHandRaiseCount,
        sendChatMessage: () => {},
      }),
    );

    act(() => {
      result.current.handleToggleHandRaise();
    });

    expect(toggleHand).toHaveBeenCalledTimes(1);
    expect(incrementHandRaiseCount).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalledWith("handRaise");
  });

  it("does not play a local-only reaction sound shortcut", () => {
    const play = vi.fn(() => {});
    const sendReaction = vi.fn(() => {});

    const { result } = renderHook(() =>
      useConferenceMeetingActions({
        clearDisconnectGraceTimeout: () => {},
        setShowLeaveConfirm: () => {},
        setIsExiting: () => {},
        setIsDisconnectGraceActive: () => {},
        leave: async () => {},
        play,
        onEnd: undefined,
        buildEndData: () => ({
          roomId: "room-1",
          roomName: "Room",
          durationSeconds: 0,
          participantCount: 1,
          messageCount: 0,
          recordingUsed: false,
          recordingDurationSeconds: 0,
          screenShareUsed: false,
          whiteboardUsed: false,
          reactionCount: 0,
          handRaiseCount: 0,
          transcriptLineCount: 0,
        }),
        setPhase: () => {},
        onLeave: undefined,
        setSupportCode: () => {},
        resetForRejoin: () => {},
        media: {
          toggleAudio: () => {},
          toggleVideo: () => {},
        },
        screenShare: {
          toggle: async () => {},
        },
        recording: {
          toggle: () => {},
        },
        interactions: {
          isHandRaised: false,
          toggleHand: () => {},
          sendReaction,
        },
        incrementHandRaiseCount: () => {},
        sendChatMessage: () => {},
      }),
    );

    act(() => {
      result.current.handleSendReaction("🔥");
    });

    expect(sendReaction).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalledWith("reaction");
  });
});
