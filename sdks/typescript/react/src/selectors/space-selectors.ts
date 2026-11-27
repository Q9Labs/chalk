import { deviceHint, participantDevice, type LocalMedia, type MediaSource, type Participant as SpaceParticipant, type RemoteMedia } from "@q9labsai/chalk-client";

import type { AudioParticipant } from "../components/audio-output/AudioOutput";
import type { Participant } from "../components/participant-grid/ParticipantGrid";
import type { ParticipantListParticipant } from "../components/participants-panel/ParticipantsPanel";

/**
 * A person using two devices is away only when neither connected device is active. Sync still
 * reports each Participant separately; this selector is where the UI reads them as one person.
 */
export function effectiveFocus(participant: SpaceParticipant, participants: readonly SpaceParticipant[]): SpaceParticipant["focus"] {
  const focus = participant.focus;
  if (!focus?.appState || focus.appState === "active") return focus;
  const activeElsewhere = participants.some((other) => other.participantId !== participant.participantId && other.identityId !== undefined && other.identityId === participant.identityId && other.presence.state === "connected" && other.focus?.appState === "active");
  return activeElsewhere ? { ...focus, appState: "active", windowed: false } : focus;
}

/** Returns the first participant with a live screen-share track for the Spotlight layout. */
export function toActiveScreenShare(participants: readonly Participant[]): Participant | undefined {
  return participants.find((participant) => participant.isScreenSharing && participant.screenShareTrack != null);
}

export function toVideoParticipants(participants: readonly SpaceParticipant[], remoteMedia: readonly RemoteMedia[], localId: string, displayName: string, localMedia: Readonly<Record<MediaSource, LocalMedia>>): Participant[] {
  const remoteByParticipant = new Map<string, Partial<Record<MediaSource | "screen_audio", MediaStreamTrack>> & { cameraPausedForNetwork?: true }>();
  const stateByParticipant = new Map(participants.map((participant) => [participant.participantId, participant.media]));
  for (const publication of remoteMedia) {
    const state = stateByParticipant.get(publication.participantId);
    if (!state || !sending(sourceState(state, publication.source), publication.track)) continue;
    const media = remoteByParticipant.get(publication.participantId) ?? {};
    media[publication.source] = publication.track;
    if (publication.source === "camera" && publication.pausedForNetwork) media.cameraPausedForNetwork = true;
    remoteByParticipant.set(publication.participantId, media);
  }
  const localFromSync = participants.find((participant) => participant.participantId === localId);
  const result: Participant[] = [
    {
      id: localId,
      displayName: localFromSync?.displayName || displayName,
      deviceHint: deviceHint(localFromSync, participants),
      device: participantDevice(localFromSync),
      isLocal: true,
      isMuted: !capturing(localMedia.microphone),
      isSpeaking: localFromSync?.presence.speaking ?? false,
      isActiveSpeaker: localFromSync?.presence.activeSpeaker ?? false,
      isVideoEnabled: capturing(localMedia.camera),
      // The share tile waits for a picked source, so a cancelled browser picker never reflows the stage.
      isScreenSharing: localMedia.screen.state === "enabled",
      isHandRaised: localFromSync?.handRaised,
      focus: localFromSync ? effectiveFocus(localFromSync, participants) : undefined,
      videoTrack: localMedia.camera.track,
      screenShareTrack: localMedia.screen.track,
    },
  ];
  for (const participant of participants) {
    if (participant.participantId === localId) continue;
    const media = remoteByParticipant.get(participant.participantId);
    result.push({
      id: participant.participantId,
      displayName: participant.displayName,
      deviceHint: deviceHint(participant, participants),
      device: participantDevice(participant),
      isOwnDevice: Boolean(localFromSync?.identityId && participant.identityId === localFromSync.identityId),
      isMuted: !sending(participant.media.microphone, media?.microphone),
      isSpeaking: participant.presence.speaking,
      isActiveSpeaker: participant.presence.activeSpeaker,
      isVideoEnabled: Boolean(media?.camera),
      isScreenSharing: Boolean(media?.screen),
      isHandRaised: participant.handRaised,
      focus: effectiveFocus(participant, participants),
      ...tileSignal(participant),
      ...(media?.cameraPausedForNetwork ? { isVideoPausedForNetwork: true } : {}),
      videoTrack: media?.camera,
      screenShareTrack: media?.screen,
      videoPublicationId: participant.media.cameraPublicationId,
      screenSharePublicationId: participant.media.screenSharePublicationId,
    });
  }
  return result;
}

/**
 * Your own tile follows the device. While Sync recovers, a source it had confirmed reads "requesting" though the device never
 * stopped capturing, so a short Sync drop does not swap your picture for the avatar or mark your microphone muted.
 */
function capturing(media: LocalMedia): boolean {
  if (media.state === "enabled") return true;
  return media.state === "requesting" && media.track !== null && media.track.enabled && media.track.readyState === "live";
}

/**
 * Another person's source follows Sync while Sync knows it. While Sync recovers it reads "unknown", and the track the SFU still
 * delivers keeps the source on, so a short Sync drop does not swap their picture for the avatar or mark them muted.
 */
function sending(state: SpaceParticipant["media"]["camera"], track: MediaStreamTrack | null | undefined): boolean {
  if (state === "active") return true;
  return state === "unknown" && Boolean(track) && track?.readyState === "live";
}

function sourceState(media: SpaceParticipant["media"], source: RemoteMedia["source"]): SpaceParticipant["media"]["camera"] {
  if (source === "camera") return media.camera;
  if (source === "microphone") return media.microphone;
  return media.screenShare;
}

/** What a guest's own rating and presence say about their tile. Unknown shows no signal at all. */
const TILE_BARS = { good: 4, weak: 2, poor: 1 } as const;

function tileSignal(participant: SpaceParticipant): Pick<Participant, "connectionQuality" | "isReconnecting"> {
  const { connectionQuality, state } = participant.presence;
  const quality = connectionQuality === undefined ? undefined : TILE_BARS[connectionQuality];
  return { ...(quality === undefined ? {} : { connectionQuality: quality }), ...(state === "disconnected" ? { isReconnecting: true } : {}) };
}

export function toAudioParticipants(remoteMedia: readonly RemoteMedia[]): AudioParticipant[] {
  const byParticipant = new Map<string, AudioParticipant>();
  for (const publication of remoteMedia) {
    if (publication.track.kind !== "audio") continue;
    const participant = byParticipant.get(publication.participantId) ?? { id: publication.participantId };
    if (publication.source === "microphone") participant.audioTrack = publication.track;
    if (publication.source === "screen_audio") participant.screenShareAudioTrack = publication.track;
    byParticipant.set(publication.participantId, participant);
  }
  return [...byParticipant.values()];
}

export function toParticipantNames(participants: readonly SpaceParticipant[], localId: string, displayName: string): Readonly<Record<string, string>> {
  return Object.fromEntries([...participants.map((participant) => [participant.participantId, participant.displayName] as const), [localId, participants.find((participant) => participant.participantId === localId)?.displayName ?? displayName]]);
}

export function toListParticipants(tiles: readonly Participant[], participantMedia: Readonly<Record<string, SpaceParticipant["media"]>>): ParticipantListParticipant[] {
  return tiles.map((participant) => {
    const media = participantMedia[participant.id];
    return {
      id: participant.id,
      displayName: participant.displayName,
      deviceHint: participant.deviceHint,
      isLocal: participant.isLocal,
      isMuted: participant.isLocal || media?.microphone === "unknown" ? participant.isMuted : media?.microphone !== "active",
      isVideoEnabled: participant.isLocal || media?.camera === "unknown" ? participant.isVideoEnabled : media?.camera === "active",
      isHandRaised: participant.isHandRaised,
    };
  });
}
