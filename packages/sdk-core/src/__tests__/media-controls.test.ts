import { describe, expect, it, mock } from "bun:test";
import { createConferenceSessionMediaController } from "../conference-session/media-controls.ts";

describe("createConferenceSessionMediaController", () => {
  it("resets local screen share state when start is cancelled after a transient local update", async () => {
    const participant = {
      id: "local",
      isScreenSharing: false,
      screenShareTrack: undefined,
      screenShareAudioTrack: undefined,
    } as any;

    const updates: Array<{ isScreenSharing: boolean; screenShareTrack: unknown; screenShareAudioTrack: unknown }> = [];
    const emitError = mock(() => {});
    const enableScreenShare = mock(async () => {
      participant.isScreenSharing = true;
      participant.screenShareTrack = { kind: "video" } as any;
      participant.screenShareAudioTrack = { kind: "audio" } as any;

      const err = new Error("Screen share was cancelled");
      (err as any).name = "AbortError";
      throw err;
    });

    const controller = createConferenceSessionMediaController({
      getRtkClient: () =>
        ({
          self: {
            enableScreenShare,
          },
        }) as any,
      getLocalParticipant: () => participant,
      emitError,
      emitParticipantUpdated: (_participantId, nextParticipant) => {
        updates.push({
          isScreenSharing: nextParticipant.isScreenSharing,
          screenShareTrack: nextParticipant.screenShareTrack,
          screenShareAudioTrack: nextParticipant.screenShareAudioTrack,
        });
      },
    });

    const started = await controller.startScreenShare();

    expect(started).toBe(false);
    expect(enableScreenShare).toHaveBeenCalledTimes(1);
    expect(participant.isScreenSharing).toBe(false);
    expect(participant.screenShareTrack).toBeUndefined();
    expect(participant.screenShareAudioTrack).toBeUndefined();
    expect(updates).toEqual([
      {
        isScreenSharing: false,
        screenShareTrack: undefined,
        screenShareAudioTrack: undefined,
      },
    ]);
    expect(emitError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SCREEN_SHARE_CANCELLED",
        details: { name: "AbortError" },
      }),
    );
  });
});
