import { ChalkErrorCode, type ChalkError, type Participant } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
import { getRtkIds, mapRtkParticipant } from "./rtk-identity.ts";
import { collectJoinedParticipants, getParticipantEmitters, onParticipantsEvent, toRtkParticipantsApi, type RtkParticipantsApi, type ParticipantEventEmitter } from "./rtk-participant-adapter.ts";
import { applyAudioUpdatePatch, applyScreenShareUpdatePatch, applyVideoUpdatePatch, hasMediaStateChanged, mergeParticipantMediaState } from "./participant-sync-reducer.ts";
import type { RtkSignalingDeps } from "./rtk-signaling-deps.ts";

const emitParticipantUpdated = (deps: RtkSignalingDeps, participantId: string, participant: Participant): void => {
  deps.emit("participant.updated", {
    participantId,
    participant,
  });
};

const ensureRemoteParticipant = (deps: RtkSignalingDeps, rtkParticipant: unknown): Participant | null => {
  const participant = mapRtkParticipant(deps.getPeerIdMap(), rtkParticipant);
  const localParticipant = deps.getLocalParticipant();

  if (localParticipant && participant.id === localParticipant.id) {
    return null;
  }

  const participants = deps.getParticipants();
  const { peerId } = getRtkIds(deps.getPeerIdMap(), rtkParticipant);
  let existing = participants.get(participant.id);

  if (!existing && peerId !== participant.id) {
    const existingByPeerId = participants.get(peerId);
    if (existingByPeerId) {
      participants.delete(peerId);
      existing = {
        ...existingByPeerId,
        ...participant,
        id: participant.id,
        isLocal: false,
      };
      participants.set(participant.id, existing);
    }
  }

  if (!existing) {
    participants.set(participant.id, participant);
    deps.emit("participant.joined", participant);
  }

  return participant;
};

const reconcileJoinedParticipants = (deps: RtkSignalingDeps, participantsApi: RtkParticipantsApi, options: { pruneStaleRemotes?: boolean } = {}): void => {
  const joinedParticipants = collectJoinedParticipants(participantsApi);
  deps.emitRoomSyncReady("rtk.snapshot", joinedParticipants.length + (deps.getLocalParticipant() ? 1 : 0));
  const joinedRemoteIds = new Set<string>();

  for (const joinedParticipant of joinedParticipants) {
    const participant = ensureRemoteParticipant(deps, joinedParticipant);
    if (!participant) {
      continue;
    }
    joinedRemoteIds.add(participant.id);

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      continue;
    }

    const merged = mergeParticipantMediaState(existing, participant);
    if (!hasMediaStateChanged(existing, merged)) {
      continue;
    }

    participants.set(participant.id, merged);
    emitParticipantUpdated(deps, participant.id, merged);
  }

  if (options.pruneStaleRemotes) {
    const participants = deps.getParticipants();
    const staleRemoteIds = Array.from(participants.values())
      .filter((participant) => !participant.isLocal && !joinedRemoteIds.has(participant.id))
      .map((participant) => participant.id);

    for (const participantId of staleRemoteIds) {
      participants.delete(participantId);
      deps.emit("participant.left", participantId);
    }
  }
};

const emitTrackError = (deps: RtkSignalingDeps, error: ChalkError): void => {
  deps.emit("error", error);
};

const getTrackDiagnostics = (track: MediaStreamTrack | undefined | null) => ({
  hasTrack: !!track,
  trackReadyState: track?.readyState ?? null,
  trackEnabled: track?.enabled ?? null,
  trackMuted: track?.muted ?? null,
});

const getScreenShareDiagnostics = (participant: Participant) => ({
  hasVideoTrack: !!participant.screenShareTrack,
  videoTrackReadyState: participant.screenShareTrack?.readyState ?? null,
  videoTrackEnabled: participant.screenShareTrack?.enabled ?? null,
  videoTrackMuted: participant.screenShareTrack?.muted ?? null,
  hasAudioTrack: !!participant.screenShareAudioTrack,
  audioTrackReadyState: participant.screenShareAudioTrack?.readyState ?? null,
  audioTrackEnabled: participant.screenShareAudioTrack?.enabled ?? null,
  audioTrackMuted: participant.screenShareAudioTrack?.muted ?? null,
});

const isLiveTrack = (track: MediaStreamTrack | null | undefined): boolean => !!track && track.readyState === "live" && track.enabled;

export const setupRtkParticipantDebugHooks = (deps: Pick<RtkSignalingDeps, "debug" | "getRtkClient">): void => {
  const rtkClient = deps.getRtkClient();
  if (!deps.debug || !rtkClient?.participants?.joined) {
    return;
  }

  const debugEvents = ["participantJoined", "participantLeft", "videoUpdate", "audioUpdate", "screenShareUpdate", "participantsUpdate", "participantsCleared"];

  for (const eventName of debugEvents) {
    try {
      (rtkClient.participants.joined as unknown as ParticipantEventEmitter).on?.(eventName, (_data: unknown) => {
        // debug hook
      });
    } catch {
      // best effort
    }
  }
};

export const setupRtkParticipantSync = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient?.participants) {
    return;
  }

  const participantsApi = toRtkParticipantsApi(rtkClient.participants);
  const syncLocalParticipantMediaState = (): void => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.videoEnabled = rtkClient.self.videoEnabled;
    localParticipant.audioEnabled = rtkClient.self.audioEnabled;
    localParticipant.videoTrack = rtkClient.self.videoTrack ?? undefined;
    localParticipant.audioTrack = rtkClient.self.audioTrack ?? undefined;

    if (localParticipant.videoEnabled) {
      deps.validateTrack(localParticipant.videoTrack, "LOCAL_VIDEO", localParticipant.id);
    }
    if (localParticipant.audioEnabled) {
      deps.validateTrack(localParticipant.audioTrack, "LOCAL_AUDIO", localParticipant.id);
    }
  };

  rtkClient.self.on("roomJoined", () => {
    deps.setConnectionState("connected");
    syncLocalParticipantMediaState();
    deps.logConnectionState();
    reconcileJoinedParticipants(deps, participantsApi, {
      pruneStaleRemotes: true,
    });
    void deps.reapplyBackgroundEffect?.().catch(() => {
      // best effort after RTK reconnect resets local tracks
    });
  });

  rtkClient.self.on("roomLeft", (payload: { state?: string } | undefined) => {
    if (deps.isLeaving()) {
      deps.setConnectionState("disconnected");
      return;
    }

    void deps.suspendBackgroundEffect?.().catch(() => {
      // best effort while RTK is disconnecting
    });

    if (payload?.state === "failed") {
      deps.setConnectionState("failed");
      deps.emit("error", {
        code: ChalkErrorCode.CONNECTION_FAILED,
        message: "Connection lost and could not be restored",
        details: {
          transport: "rtk",
          roomId: deps.roomId,
          roomState: payload.state,
        },
      } as ChalkError);
      return;
    }

    deps.setConnectionState("reconnecting");
  });

  rtkClient.self.on("videoUpdate", (data: { videoEnabled: boolean; videoTrack: MediaStreamTrack | null }) => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    const hadLiveVideo = localParticipant.videoEnabled && isLiveTrack(localParticipant.videoTrack);
    const previousTrack = localParticipant.videoTrack ?? null;
    const hasLiveVideo = data.videoEnabled && isLiveTrack(data.videoTrack);
    const trackChanged = previousTrack !== (data.videoTrack ?? null);
    const backgroundSelected = deps.hasSelectedBackgroundEffect?.() ?? false;

    localParticipant.videoEnabled = data.videoEnabled;
    localParticipant.videoTrack = data.videoTrack ?? undefined;

    if (data.videoEnabled) {
      const isValid = deps.validateTrack(data.videoTrack, "LOCAL_VIDEO", localParticipant.id);
      if (!isValid) {
        emitTrackError(deps, {
          code: "MEDIA_ERROR",
          message: "Video enabled but track unavailable or invalid",
          details: { trackState: data.videoTrack?.readyState },
        } as ChalkError);
      }
    }

    const ctx = wideEvents.start("media.video.update");
    ctx.merge({
      scope: "local",
      participantId: localParticipant.id,
      enabled: data.videoEnabled,
      ...getTrackDiagnostics(data.videoTrack),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, localParticipant.id, localParticipant);

    if (!backgroundSelected) {
      return;
    }

    if (!hasLiveVideo && (hadLiveVideo || trackChanged)) {
      void deps.suspendBackgroundEffect?.().catch(() => {
        // best effort while local video becomes unavailable
      });
      return;
    }

    if (hasLiveVideo && (!hadLiveVideo || trackChanged)) {
      void deps.reapplyBackgroundEffect?.().catch(() => {
        // best effort when RTK swaps the local video track under an active effect
      });
    }
  });

  rtkClient.self.on("audioUpdate", (data: { audioEnabled: boolean; audioTrack: MediaStreamTrack | null }) => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.audioEnabled = data.audioEnabled;
    localParticipant.audioTrack = data.audioTrack ?? undefined;

    if (data.audioEnabled) {
      const isValid = deps.validateTrack(data.audioTrack, "LOCAL_AUDIO", localParticipant.id);
      if (!isValid) {
        emitTrackError(deps, {
          code: "MEDIA_ERROR",
          message: "Audio enabled but track unavailable or invalid",
          details: { trackState: data.audioTrack?.readyState },
        } as ChalkError);
      }
    }

    const ctx = wideEvents.start("media.audio.update");
    ctx.merge({
      scope: "local",
      participantId: localParticipant.id,
      enabled: data.audioEnabled,
      ...getTrackDiagnostics(data.audioTrack),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, localParticipant.id, localParticipant);
  });

  rtkClient.self.on(
    "screenShareUpdate",
    (data: {
      screenShareEnabled: boolean;
      screenShareTracks: {
        audio?: MediaStreamTrack;
        video?: MediaStreamTrack;
      };
    }) => {
      const localParticipant = deps.getLocalParticipant();
      if (!localParticipant) {
        return;
      }

      localParticipant.isScreenSharing = data.screenShareEnabled;
      localParticipant.screenShareTrack = data.screenShareTracks?.video ?? undefined;
      localParticipant.screenShareAudioTrack = data.screenShareTracks?.audio ?? undefined;

      const ctx = wideEvents.start("screenshare.update");
      ctx.merge({
        scope: "local",
        participantId: localParticipant.id,
        enabled: data.screenShareEnabled,
        ...getScreenShareDiagnostics(localParticipant),
      });
      ctx.complete("success");
      emitParticipantUpdated(deps, localParticipant.id, localParticipant);
    },
  );

  const emitters: ParticipantEventEmitter[] = getParticipantEmitters(participantsApi);

  onParticipantsEvent(emitters, "participantJoined", (rtkParticipant: unknown) => {
    ensureRemoteParticipant(deps, rtkParticipant);
  });

  onParticipantsEvent(emitters, "participantLeft", (rtkParticipant: unknown) => {
    const { stableId, peerId } = getRtkIds(deps.getPeerIdMap(), rtkParticipant);
    deps.getPeerIdMap().delete(peerId);

    const participants = deps.getParticipants();
    const deletedStable = participants.delete(stableId);
    const deletedPeer = peerId !== stableId ? participants.delete(peerId) : false;

    if (deletedStable || deletedPeer) {
      deps.emit("participant.left", stableId);
    }
  });

  onParticipantsEvent(emitters, "videoUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(deps, rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated = applyVideoUpdatePatch(existing, participant);
    participants.set(participant.id, updated);

    if (participant.videoEnabled) {
      deps.validateTrack(participant.videoTrack, "REMOTE_VIDEO", participant.id);
    }

    const ctx = wideEvents.start("media.video.update");
    ctx.merge({
      scope: "remote",
      participantId: updated.id,
      participantName: updated.displayName,
      enabled: updated.videoEnabled,
      ...getTrackDiagnostics(updated.videoTrack),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, participant.id, updated);
  });

  onParticipantsEvent(emitters, "audioUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(deps, rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated = applyAudioUpdatePatch(existing, participant);
    participants.set(participant.id, updated);

    if (participant.audioEnabled) {
      deps.validateTrack(participant.audioTrack, "REMOTE_AUDIO", participant.id);
    }

    const ctx = wideEvents.start("media.audio.update");
    ctx.merge({
      scope: "remote",
      participantId: updated.id,
      participantName: updated.displayName,
      enabled: updated.audioEnabled,
      ...getTrackDiagnostics(updated.audioTrack),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, participant.id, updated);
  });

  onParticipantsEvent(emitters, "screenShareUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(deps, rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated = applyScreenShareUpdatePatch(existing, participant);
    participants.set(participant.id, updated);

    if (participant.isScreenSharing) {
      const isValid = deps.validateTrack(participant.screenShareTrack, "REMOTE_SCREENSHARE", participant.id);
      if (!isValid) {
        emitTrackError(deps, {
          code: "MEDIA_ERROR",
          message: "Screen share enabled but track unavailable or invalid",
          details: { trackState: participant.screenShareTrack?.readyState },
        } as ChalkError);
      }
    }

    const ctx = wideEvents.start("screenshare.update");
    ctx.merge({
      scope: "remote",
      participantId: updated.id,
      participantName: updated.displayName,
      enabled: updated.isScreenSharing,
      ...getScreenShareDiagnostics(updated),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, participant.id, updated);
  });

  onParticipantsEvent(emitters, "screenShareUpdate", (rtkParticipant: unknown) => {
    const participant = ensureRemoteParticipant(deps, rtkParticipant);
    if (!participant) {
      return;
    }

    const participants = deps.getParticipants();
    const existing = participants.get(participant.id);
    if (!existing) {
      return;
    }

    const updated = applyScreenShareUpdatePatch(existing, participant);
    participants.set(participant.id, updated);

    if (participant.isScreenSharing) {
      const isValid = deps.validateTrack(participant.screenShareTrack, "REMOTE_SCREENSHARE", participant.id);
      if (!isValid) {
        emitTrackError(deps, {
          code: "SCREEN_SHARE_ERROR",
          message: `Screen share track unavailable for participant ${participant.displayName}`,
          details: { participantId: participant.id },
        } as ChalkError);
      }
    }

    const ctx = wideEvents.start("screenshare.update");
    ctx.merge({
      scope: "remote",
      participantId: updated.id,
      participantName: updated.displayName,
      enabled: updated.isScreenSharing,
      ...getScreenShareDiagnostics(updated),
    });
    ctx.complete("success");
    emitParticipantUpdated(deps, participant.id, updated);
  });

  onParticipantsEvent(emitters, "participantsUpdate", () => {
    reconcileJoinedParticipants(deps, participantsApi);
  });

  onParticipantsEvent(emitters, "participantsCleared", () => {
    const participants = deps.getParticipants();
    const remoteIds = Array.from(participants.values())
      .filter((participant) => !participant.isLocal)
      .map((participant) => participant.id);

    for (const participantId of remoteIds) {
      participants.delete(participantId);
      deps.emit("participant.left", participantId);
    }

    deps.getPeerIdMap().clear();

    queueMicrotask(() => reconcileJoinedParticipants(deps, participantsApi));
    setTimeout(() => reconcileJoinedParticipants(deps, participantsApi), 50);
    setTimeout(() => reconcileJoinedParticipants(deps, participantsApi), 250);
  });

  if (typeof participantsApi.on === "function") {
    participantsApi.on("activeSpeakerChanged", (speaker: unknown) => {
      if (speaker) {
        const ids = getRtkIds(deps.getPeerIdMap(), speaker);
        const participant = deps.getParticipants().get(ids.stableId) ?? null;
        if (deps.getActiveSpeaker()?.id !== participant?.id) {
          deps.setActiveSpeaker(participant);
          deps.emit("speaker.active.changed", participant);
        }
        return;
      }

      if (deps.getActiveSpeaker() !== null) {
        deps.setActiveSpeaker(null);
        deps.emit("speaker.active.changed", null);
      }
    });
  }
};
