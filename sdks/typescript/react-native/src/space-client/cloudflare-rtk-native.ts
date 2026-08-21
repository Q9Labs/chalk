import type RealtimeKitClient from "@cloudflare/realtimekit-react-native";
import type { CloudflareRTKClientFactory, CloudflareRTKConnection, CloudflareRTKParticipant } from "@q9labsai/chalk-client";

type NativeRealtimeKitClient = Awaited<ReturnType<typeof RealtimeKitClient.init>>;
type NativeRealtimeKitParticipant = ReturnType<NativeRealtimeKitClient["participants"]["joined"]["toArray"]>[number];

export const createNativeRealtimeKitClient: CloudflareRTKClientFactory = async ({ authToken, onError }) => {
  const { default: NativeRealtimeKitClient } = await import("@cloudflare/realtimekit-react-native");
  const client = await NativeRealtimeKitClient.init({
    authToken,
    defaults: { audio: false, video: false },
    onError,
  });
  return adaptNativeRealtimeKitClient(client);
};

function adaptNativeRealtimeKitClient(client: NativeRealtimeKitClient): CloudflareRTKConnection {
  const self = client.self;
  return {
    join: () => client.joinRoom(),
    leave: () => client.leaveRoom(),
    self: {
      get peerId() {
        return self.peerId;
      },
      get audioEnabled() {
        return self.audioEnabled;
      },
      get videoEnabled() {
        return self.videoEnabled;
      },
      get screenShareEnabled() {
        return self.screenShareEnabled;
      },
      get audioTrack() {
        return self.audioTrack ?? null;
      },
      get videoTrack() {
        return self.videoTrack ?? null;
      },
      get screenShareTracks() {
        return {
          ...(self.screenShareTracks.audio ? { audio: self.screenShareTracks.audio } : {}),
          ...(self.screenShareTracks.video ? { video: self.screenShareTracks.video } : {}),
        };
      },
      enableAudio: () => self.enableAudio(),
      enableVideo: () => self.enableVideo(),
      enableScreenShare: () => self.enableScreenShare(),
      disableAudio: () => self.disableAudio(),
      disableVideo: () => self.disableVideo(),
      disableScreenShare: () => self.disableScreenShare(),
      onAudioUpdate: (listener) => {
        self.on("audioUpdate", listener);
        return () => self.off("audioUpdate", listener);
      },
      onVideoUpdate: (listener) => {
        self.on("videoUpdate", listener);
        return () => self.off("videoUpdate", listener);
      },
      onScreenShareUpdate: (listener) => {
        self.on("screenShareUpdate", listener);
        return () => self.off("screenShareUpdate", listener);
      },
      onLeft: (listener) => {
        const callback = () => listener();
        self.on("roomLeft", callback);
        return () => self.off("roomLeft", callback);
      },
    },
    participants: {
      joined: {
        list: () => client.participants.joined.toArray().map(toParticipant),
        onJoined: (listener) => {
          const callback = (participant: NativeRealtimeKitParticipant) => listener(toParticipant(participant));
          client.participants.joined.on("participantJoined", callback);
          return () => client.participants.joined.off("participantJoined", callback);
        },
        onLeft: (listener) => {
          const callback = (participant: NativeRealtimeKitParticipant) => listener(toParticipant(participant));
          client.participants.joined.on("participantLeft", callback);
          return () => client.participants.joined.off("participantLeft", callback);
        },
      },
    },
  };
}

function toParticipant(participant: NativeRealtimeKitParticipant): CloudflareRTKParticipant {
  return {
    id: participant.id,
    userId: participant.userId,
    ...(participant.customParticipantId === undefined ? {} : { customParticipantId: participant.customParticipantId }),
    audioEnabled: participant.audioEnabled,
    videoEnabled: participant.videoEnabled,
    screenShareEnabled: participant.screenShareEnabled,
    audioTrack: participant.audioTrack ?? null,
    videoTrack: participant.videoTrack ?? null,
    screenShareTracks: {
      ...(participant.screenShareTracks.audio ? { audio: participant.screenShareTracks.audio } : {}),
      ...(participant.screenShareTracks.video ? { video: participant.screenShareTracks.video } : {}),
    },
  };
}
