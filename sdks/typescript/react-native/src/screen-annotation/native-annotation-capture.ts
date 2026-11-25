import { screenAnnotationFor, type ScreenAnnotationFrameSize, type SpaceClient } from "@q9labsai/chalk-client";
import { mediaDevices } from "@cloudflare/react-native-webrtc";
import { Alert, DeviceEventEmitter, NativeModules, Platform } from "react-native";
import { captureAndroidScreen } from "../media/android-screen-capture";
import { startIOSScreenBroadcast } from "../media/native-screen-share";
import { releaseNativeTrack } from "../media/native-release-track";
import { observeIOSScreenDimensions } from "./ios-screen-dimensions";

type AndroidAnnotationOverlay = {
  readonly hasPermission: () => Promise<boolean>;
  readonly requestPermission: () => Promise<boolean>;
  readonly protectControls: (trackId: string) => Promise<boolean>;
  readonly probe: (trackId: string) => Promise<ScreenAnnotationFrameSize | null>;
  readonly render: (trackId: string, scene: string, nowMs: number, mode: "annotated" | "recovering" | "plain") => void;
  readonly stop: (trackId: string) => void;
};

async function askForOverlayPermission(overlay: AndroidAnnotationOverlay): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "See marks over your screen?",
      "Allow Chalk to show marks while you’re in another app, or share without the overlay.",
      [
        { text: "Share without overlay", style: "cancel", onPress: () => resolve(false) },
        { text: "Open Android settings", onPress: () => resolve(overlay.requestPermission().catch(() => false)) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function createNativeAnnotationCapture() {
  const overlay = Platform.OS === "android" ? (NativeModules.ChalkAnnotationOverlay as AndroidAnnotationOverlay | undefined) : undefined;
  const dimensionObservers = new WeakMap<MediaStreamTrack, () => void>();
  const witnesses = new WeakMap<MediaStreamTrack, ScreenAnnotationFrameSize>();
  let share: MediaStreamTrack | undefined;
  let space: SpaceClient | undefined;
  let askAgain = true;

  async function prepareOverlay(overlay: AndroidAnnotationOverlay, annotation: ReturnType<typeof screenAnnotationFor>, track: MediaStreamTrack, permission: boolean) {
    if (annotation.getSnapshot().status !== "ready") return;
    share = track;
    // Chalk's UI (including annotation controls) must not enter its screen share.
    if (!(await overlay.protectControls(track.id).catch(() => false))) {
      share = undefined;
      if (annotation.getSnapshot().status !== "ready") return;
      releaseNativeTrack(track);
      throw new Error("Chalk could not protect the sharing controls.");
    }
    if (!permission || !annotation.supportsBurnIn?.()) return;
    const frame = await overlay.probe(track.id).catch(() => null);
    if (frame && share === track && track.readyState !== "ended" && annotation.supportsBurnIn?.()) witnesses.set(track, frame);
  }

  return {
    async getDisplayMedia(): Promise<MediaStream> {
      const annotation = space && screenAnnotationFor(space);
      let permission = false;
      if (overlay && annotation?.supportsBurnIn?.()) {
        permission = await overlay.hasPermission().catch(() => false);
        if (!permission && askAgain) {
          askAgain = false;
          permission = await askForOverlayPermission(overlay);
        }
      }
      if (Platform.OS === "ios") {
        await startIOSScreenBroadcast();
        const stream = await mediaDevices.getDisplayMedia();
        const nativeStream = stream as unknown as MediaStream;
        const track = nativeStream.getVideoTracks()[0];
        if (track) dimensionObservers.set(track, observeIOSScreenDimensions(track, stream.toURL()));
        return nativeStream;
      }
      const stream = await captureAndroidScreen();
      const track = stream.getVideoTracks()[0];
      if (track && overlay && annotation) await prepareOverlay(overlay, annotation, track, permission);
      return stream;
    },
    verifiedAnnotationCapture: (track: MediaStreamTrack) => witnesses.get(track),
    releaseTrack(track: MediaStreamTrack) {
      if (share === track) {
        share = undefined;
        overlay?.stop(track.id);
      }
      dimensionObservers.get(track)?.();
      dimensionObservers.delete(track);
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
        const active = state?.layer.burned_in === true && state.layer.publication_id === local.media.screenShare.publicationId && state.layer.sharer_id === local.self.participantId;
        const mode = active ? "annotated" : snapshot.status === "connecting" ? "recovering" : "plain";
        const scene = { sharerId: local.self.participantId, paused: active ? state.paused : true, marks: active ? state.marks : [] };
        overlay.render(track.id, JSON.stringify(scene), annotation.serverNowMs(), mode);
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
