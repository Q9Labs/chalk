import type RealtimeKitClient from "@cloudflare/realtimekit";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error.ts";
import { type ChalkError as ChalkErrorShape, type Participant, type ScreenShareOptions } from "../types.ts";
import type { VideoBackgroundEffect } from "../types/entities/media.ts";
import { wideEvents } from "../wide-events/index.ts";
import { withPatchedGetDisplayMedia } from "../utils/get-display-media-fallback.ts";
import { createConferenceSessionVideoBackgroundController, isConferenceSessionVideoBackgroundSupported } from "./video-background-controller.ts";

interface MediaControllerDeps {
  getRtkClient: () => RealtimeKitClient | undefined;
  getLocalParticipant: () => Participant | null;
  emitError: (error: ChalkErrorShape) => void;
  emitParticipantUpdated: (participantId: string, participant: Participant) => void;
}

const validateTrack = (track: MediaStreamTrack | undefined | null): boolean => {
  if (!track) {
    return false;
  }

  const isLive = track.readyState === "live";
  const isEnabled = track.enabled;

  return isLive && isEnabled;
};

const boostVideoBitrate = async (rtkClient: RealtimeKitClient): Promise<void> => {
  try {
    const client = rtkClient as unknown as {
      peerConnection?: RTCPeerConnection;
      pc?: RTCPeerConnection;
      _peerConnection?: RTCPeerConnection;
      webrtcPeer?: { peerConnection?: RTCPeerConnection };
    };

    const pc = client.peerConnection || client.pc || client._peerConnection || client.webrtcPeer?.peerConnection;

    if (!pc) {
      return;
    }

    const senders = pc.getSenders();
    const videoSender = senders.find((sender) => sender.track?.kind === "video");

    if (!videoSender) {
      return;
    }

    const params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    const encoding = params.encodings[0];
    if (encoding) {
      encoding.maxBitrate = 2_500_000;
      encoding.scaleResolutionDownBy = 1;
    }

    await videoSender.setParameters(params);
  } catch {
    // non-critical optimization
  }
};

export const createConferenceSessionMediaController = (deps: MediaControllerDeps) => {
  const videoBackgroundController = createConferenceSessionVideoBackgroundController({
    getRtkClient: deps.getRtkClient,
  });
  const getErrorConstraint = (error: unknown) => {
    if (!error || typeof error !== "object") {
      return undefined;
    }

    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : undefined;
  };
  const resetLocalScreenShareState = (participant: Participant) => {
    participant.isScreenSharing = false;
    participant.screenShareTrack = undefined;
    participant.screenShareAudioTrack = undefined;
    deps.emitParticipantUpdated(participant.id, participant);
  };

  const toggleVideo = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.toggle");
    ctx.set("mediaType", "video");
    ctx.set("before", localParticipant.videoEnabled);
    ctx.set("participantId", localParticipant.id);

    try {
      if (rtkClient.self.videoEnabled) {
        await rtkClient.self.disableVideo();
        localParticipant.videoEnabled = false;
        localParticipant.videoTrack = undefined;
      } else {
        await rtkClient.self.enableVideo();
        localParticipant.videoEnabled = true;
        localParticipant.videoTrack = rtkClient.self.videoTrack ?? undefined;
        await videoBackgroundController.reapplySelectedBackgroundEffect();
        await boostVideoBitrate(rtkClient);
      }

      deps.emitParticipantUpdated(localParticipant.id, localParticipant);
      ctx.complete("success", { enabled: localParticipant.videoEnabled });
      return localParticipant.videoEnabled;
    } catch (error) {
      ctx.complete("error", error);
      deps.emitError({
        code: "MEDIA_ERROR",
        message: "Failed to toggle camera",
      });
      return localParticipant.videoEnabled;
    }
  };

  const toggleAudio = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.toggle");
    ctx.set("mediaType", "audio");
    ctx.set("before", localParticipant.audioEnabled);
    ctx.set("participantId", localParticipant.id);

    try {
      if (rtkClient.self.audioEnabled) {
        await rtkClient.self.disableAudio();
        localParticipant.audioEnabled = false;
        localParticipant.audioTrack = undefined;
      } else {
        await rtkClient.self.enableAudio();
        localParticipant.audioEnabled = true;
        localParticipant.audioTrack = rtkClient.self.audioTrack ?? undefined;
      }

      deps.emitParticipantUpdated(localParticipant.id, localParticipant);
      ctx.complete("success", { enabled: localParticipant.audioEnabled });
      return localParticipant.audioEnabled;
    } catch (error) {
      ctx.complete("error", error);
      deps.emitError({
        code: "MEDIA_ERROR",
        message: "Failed to toggle microphone",
      });
      return localParticipant.audioEnabled;
    }
  };

  const startScreenShare = async (options?: ScreenShareOptions): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    if (localParticipant.isScreenSharing) {
      return true;
    }

    const ctx = wideEvents.start("screenshare.start");
    ctx.set("participantId", localParticipant.id);
    ctx.set("withAudio", options?.withAudio ?? false);

    try {
      await withPatchedGetDisplayMedia(
        async () => {
          await rtkClient.self.enableScreenShare();
          return true;
        },
        { withAudio: options?.withAudio },
      );

      localParticipant.isScreenSharing = true;
      deps.emitParticipantUpdated(localParticipant.id, localParticipant);
      ctx.complete("success");
      return true;
    } catch (error) {
      ctx.complete("error", error);
      const err = error as { name?: string; message?: string };
      const name = typeof err?.name === "string" ? err.name : undefined;
      const message = typeof err?.message === "string" ? err.message : "Failed to start screen sharing";
      const isCancelled = name === "AbortError" || name === "NotAllowedError";
      const constraint = getErrorConstraint(error);

      resetLocalScreenShareState(localParticipant);

      const code = name === "OverconstrainedError" ? ChalkErrorCode.OVERCONSTRAINED : isCancelled ? ChalkErrorCode.SCREEN_SHARE_CANCELLED : ChalkErrorCode.SCREEN_SHARE_FAILED;

      deps.emitError(
        new ChalkError(code, message, {
          cause: error instanceof Error ? error : undefined,
          details: {
            name,
            ...(constraint ? { constraint } : {}),
          },
        }),
      );
      return false;
    }
  };

  const stopScreenShare = async (): Promise<void> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return;
    }

    if (!localParticipant.isScreenSharing) {
      return;
    }

    const ctx = wideEvents.start("screenshare.stop");
    ctx.set("participantId", localParticipant.id);

    try {
      await rtkClient.self.disableScreenShare();
      localParticipant.isScreenSharing = false;
      localParticipant.screenShareTrack = undefined;
      localParticipant.screenShareAudioTrack = undefined;
      deps.emitParticipantUpdated(localParticipant.id, localParticipant);
      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
    }
  };

  const applyBackgroundEffect = async (effect: VideoBackgroundEffect): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    if (!isConferenceSessionVideoBackgroundSupported(rtkClient)) {
      return false;
    }

    const ctx = wideEvents.start("media.background.apply");
    ctx.set("mode", effect.mode);

    try {
      const applied = await videoBackgroundController.applyBackgroundEffect(effect);
      ctx.complete("success", { applied });
      return applied;
    } catch (error) {
      ctx.complete("error", error);
      deps.emitError({
        code: "MEDIA_ERROR",
        message: "Failed to apply video background",
        details: { mode: effect.mode },
      });
      return false;
    }
  };

  const clearBackgroundEffect = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.background.clear");

    try {
      const cleared = await videoBackgroundController.clearBackgroundEffect();
      ctx.complete("success", { cleared });
      return cleared;
    } catch (error) {
      ctx.complete("error", error);
      deps.emitError({
        code: "MEDIA_ERROR",
        message: "Failed to clear video background",
      });
      return false;
    }
  };

  const validateMediaTrack = validateTrack;

  return {
    applyBackgroundEffect,
    clearBackgroundEffect,
    reapplyBackgroundEffect: videoBackgroundController.reapplySelectedBackgroundEffect,
    toggleVideo,
    toggleAudio,
    startScreenShare,
    stopScreenShare,
    validateMediaTrack,
  };
};
