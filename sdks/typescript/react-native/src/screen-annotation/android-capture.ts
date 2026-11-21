import { screenAnnotationFor, type ScreenAnnotationFrameSize, type SpaceClient } from "@q9labsai/chalk-client";
import { mediaDevices } from "@cloudflare/react-native-webrtc";
import { Alert, DeviceEventEmitter, NativeModules, Platform } from "react-native";
import { releaseNativeTrack } from "../media/native-release-track";

type AndroidAnnotationOverlay = {
  readonly hasPermission: () => Promise<boolean>;
  readonly requestPermission: () => Promise<boolean>;
  readonly protectControls: (trackId: string) => Promise<boolean>;
  readonly probe: (trackId: string) => Promise<ScreenAnnotationFrameSize | null>;
  readonly render: (trackId: string, scene: string, presence: string, nowMs: number, active: boolean) => void;
  readonly stop: (trackId: string) => void;
};

export function createNativeAnnotationCapture() {
  const overlay = Platform.OS === "android" ? (NativeModules.ChalkAnnotationOverlay as AndroidAnnotationOverlay | undefined) : undefined;
  const witnesses = new WeakMap<MediaStreamTrack, ScreenAnnotationFrameSize>();
  let share: MediaStreamTrack | undefined;
  let space: SpaceClient | undefined;
  let askAgain = true;

  return {
    async getDisplayMedia(): Promise<MediaStream> {
      const annotation = space && screenAnnotationFor(space);
      let permission = false;
      if (overlay && annotation?.supportsBurnIn?.()) {
        permission = await overlay.hasPermission().catch(() => false);
        if (!permission && askAgain) {
          askAgain = false;
          permission = await new Promise((resolve) => {
            Alert.alert("See marks over your screen?", "Allow Chalk to show marks while you’re in another app, or share without the overlay.", [
              { text: "Share without overlay", style: "cancel", onPress: () => resolve(false) },
              { text: "Open Android settings", onPress: () => resolve(overlay.requestPermission().catch(() => false)) },
            ], { cancelable: true, onDismiss: () => resolve(false) });
          });
        }
      }
      const stream = (await mediaDevices.getDisplayMedia()) as unknown as MediaStream;
      const track = stream.getVideoTracks()[0];
      if (!track || !overlay) return stream;

      share = track;
      // Chalk's own UI (including annotation controls) must not enter its screen share.
      const protectedControls = await overlay.protectControls(track.id).catch(() => false);
      if (!protectedControls) {
        share = undefined;
        releaseNativeTrack(track);
        throw new Error("Chalk could not protect the sharing controls.");
      }
      if (permission) {
        const frame = await overlay.probe(track.id).catch(() => null);
        if (frame && share === track && track.readyState !== "ended") witnesses.set(track, frame);
      }
      return stream;
    },
    verifiedAnnotationCapture: (track: MediaStreamTrack) => witnesses.get(track),
    releaseTrack(track: MediaStreamTrack) {
      if (share === track) {
        share = undefined;
        overlay?.stop(track.id);
      }
      witnesses.delete(track);
      releaseNativeTrack(track);
    },
    attach(client: SpaceClient): () => void {
      if (!overlay) return () => {};
      space = client;
      const annotation = screenAnnotationFor(client);
      const emit = () => {
        const track = share;
        if (!track || !witnesses.has(track)) return;
        const snapshot = annotation.getSnapshot();
        const local = client.getSnapshot();
        const state = snapshot.status === "ready" ? snapshot.state : null;
        const active = state?.layer.burned_in === true &&
          state.layer.publication_id === local.media.screenShare.publicationId &&
          state.layer.sharer_id === local.self.participantId;
        overlay.render(
          track.id,
          JSON.stringify({ sharerId: local.self.participantId, paused: active ? state.paused : true, marks: active ? state.marks : [] }),
          JSON.stringify(active && snapshot.status === "ready" ? snapshot.presence.map((sample) => ({ ...sample, draft: null })) : []),
          annotation.serverNowMs(),
          active,
        );
      };
      const unbindAnnotation = annotation.subscribe(emit);
      const unbindSpace = client.subscribe(emit);
      const lost = DeviceEventEmitter.addListener("chalkAnnotationOverlayLost", (trackId: unknown) => {
        if (trackId !== share?.id || !share) return;
        witnesses.delete(share);
        void client.media.setScreenShareEnabled(false).catch(() => {});
      });
      return () => {
        lost.remove();
        unbindAnnotation();
        unbindSpace();
        if (share) overlay.stop(share.id);
      };
    },
  };
}
