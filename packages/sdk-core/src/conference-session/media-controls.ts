import type RealtimeKitClient from "@cloudflare/realtimekit";
import { ChalkErrorCode, type ChalkError, type Participant, type ScreenShareOptions } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
import { withPatchedGetDisplayMedia } from "../utils/get-display-media-fallback.ts";

interface MediaControllerDeps {
  getRtkClient: () => RealtimeKitClient | undefined;
  getLocalParticipant: () => Participant | null;
  emitError: (error: ChalkError) => void;
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
  const toggleVideo = async (): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.toggle");
    ctx.set("mediaType", "video");
    ctx.set("before", localParticipant.videoEnabled);

    try {
      if (rtkClient.self.videoEnabled) {
        await rtkClient.self.disableVideo();
        localParticipant.videoEnabled = false;
        localParticipant.videoTrack = undefined;
      } else {
        await rtkClient.self.enableVideo();
        localParticipant.videoEnabled = true;
        localParticipant.videoTrack = rtkClient.self.videoTrack ?? undefined;
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

    try {
      await withPatchedGetDisplayMedia(
        async () => {
          await rtkClient.self.enableScreenShare();
          return true;
        },
        { withAudio: options?.withAudio === true },
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

      const code = name === "OverconstrainedError" ? ChalkErrorCode.OVERCONSTRAINED : name === "NotAllowedError" ? ChalkErrorCode.SCREEN_SHARE_CANCELLED : ChalkErrorCode.SCREEN_SHARE_FAILED;

      deps.emitError({
        code,
        message,
        details: { name },
      });
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

  const validateMediaTrack = validateTrack;

  return {
    toggleVideo,
    toggleAudio,
    startScreenShare,
    stopScreenShare,
    validateMediaTrack,
  };
};
