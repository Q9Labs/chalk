import { createSpaceClient, screenAnnotationFor } from "@q9labsai/chalk-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseParsedAccessGrant } from "../../../client/src/access/grant";
import { createDefaultConnectionDependencies } from "../../../client/src/connection/production";
import { registerAnnotationSession } from "../../../client/src/screen-annotation";
import { AnnotationSession } from "../../../client/src/screen-annotation/session";
import { opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";
import { recordingClient, recoverSocket, settle, stateWithPeer, wireSnapshot } from "../../../client/tests/helpers/sync-v1";
import { createNativeAnnotationCapture } from "./android-capture";

const nativeEvents = vi.hoisted((): string[] => []);

vi.mock("@cloudflare/react-native-webrtc", () => ({
  MediaStreamTrack: class {
    readonly id: string;
    readyState = "live";

    constructor({ id }: { readonly id: string }) {
      this.id = id;
    }

    stop() {
      this.readyState = "ended";
    }

    release() {
      nativeEvents.push("release capture");
    }
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppRegistry: { registerHeadlessTask() {} },
  Alert: { alert: () => nativeEvents.push("permission prompt") },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  NativeModules: {
    ChalkScreenCapture: {
      capture: async () => {
        nativeEvents.push("screen capture");
        return { id: "screen" };
      },
    },
    ChalkAnnotationOverlay: {
      hasPermission: async () => {
        nativeEvents.push("permission check");
        return true;
      },
      protectControls: async () => {
        nativeEvents.push("protect controls");
        return false;
      },
    },
  },
}));

beforeEach(() => {
  nativeEvents.length = 0;
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends EventTarget {
      readonly connectionState = "new";
      readonly iceConnectionState = "new";
      getSenders() {
        return [];
      }
      getTransceivers() {
        return [];
      }
      close() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { scenario: "annotations absent from welcome", negotiated: false, status: "unavailable" },
  { scenario: "negotiated annotations explicitly withdrawn", negotiated: "burn-in", status: "connecting" },
] as const)("starts a plain screen share with $scenario", async ({ negotiated, status }) => {
  const apiBaseURL = "http://127.0.0.1:1";
  const grant = opaqueAccessGrant("plain-screen-share");
  const client = createSpaceClient({ space: "plain-screen-share", baseUrl: apiBaseURL, getAccess: async () => grant });
  const { client: sync, sockets } = recordingClient();
  const media = createDefaultConnectionDependencies({ apiBaseURL, syncURL: "ws://127.0.0.1:1/v1/sync" }).createMediaClient({
    access: parseParsedAccessGrant(grant),
    credential: async () => "unused",
    onFailure: () => {},
    onScreenEnded: () => {},
  });
  const annotation = new AnnotationSession({
    subscribePorts(listener) {
      listener({ sync, media });
      return () => {};
    },
  });
  registerAnnotationSession(client, annotation);
  const capture = createNativeAnnotationCapture();
  const detach = capture.attach(client);
  try {
    const initial = stateWithPeer("collaborator");
    const snapshot = await wireSnapshot(initial);
    await sync.start();
    const socket = sockets[0]!;
    socket.open();
    await settle();
    await recoverSocket(sync, socket, { ...initial, stateDigest: snapshot.state_digest }, snapshot, "snapshot", true, undefined, false, false, negotiated);
    expect(screenAnnotationFor(client).getSnapshot()).toEqual({ status });
    if (negotiated) {
      socket.receive({ type: "annotation_state", state: null, enabled: false, server_at_ms: Date.now() });
      await settle();
    }
    expect(screenAnnotationFor(client).getSnapshot()).toEqual({ status: "unavailable" });

    const stream = await capture.getDisplayMedia();
    const [track] = stream.getVideoTracks();
    expect(track?.id).toBe("screen");
    expect(capture.verifiedAnnotationCapture(track!)).toBeUndefined();

    capture.releaseTrack(track!);
    expect(track?.readyState).toBe("ended");
    expect(nativeEvents).toEqual(["screen capture", "release capture"]);
    expect(socket.frames().filter((frame) => frame.type === "annotation_bind")).toEqual([]);
  } finally {
    detach();
    annotation.dispose();
    sync.stop();
    media.stop();
    client.dispose();
  }
});
