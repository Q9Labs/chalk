import { describe, expect, it, vi } from "vitest";
import { ChalkError } from "../errors/chalk-error.ts";
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
    const emitError = vi.fn(() => {});
    const enableScreenShare = vi.fn(async () => {
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

    const emittedError = emitError.mock.calls[0]?.[0];
    expect(emittedError).toBeInstanceOf(ChalkError);
    expect(emittedError?.cause).toMatchObject({
      name: "AbortError",
      message: "Screen share was cancelled",
    });
  });

  it("preserves the original screen-share failure as the emitted cause", async () => {
    const participant = {
      id: "local",
      isScreenSharing: false,
      screenShareTrack: undefined,
      screenShareAudioTrack: undefined,
    } as any;

    const emitError = vi.fn(() => {});
    const enableScreenShare = vi.fn(async () => {
      const err = new Error("Could not start video source");
      (err as any).name = "NotReadableError";
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
      emitParticipantUpdated: () => {},
    });

    const started = await controller.startScreenShare();

    expect(started).toBe(false);
    const emittedError = emitError.mock.calls[0]?.[0];
    expect(emittedError).toBeInstanceOf(ChalkError);
    expect(emittedError).toMatchObject({
      code: "SCREEN_SHARE_FAILED",
      message: "Could not start video source",
      details: { name: "NotReadableError" },
    });
    expect(emittedError?.cause).toMatchObject({
      name: "NotReadableError",
      message: "Could not start video source",
    });
  });
});
