import { createSpaceClient, screenAnnotationFor, type ScreenAnnotationState } from "@q9labsai/chalk-client";
import { beforeEach, expect, it, vi } from "vitest";
import { createSfuHarness, fakeStream } from "../../../client/src/media/sfu.test.helpers";
import { FakePeerConnection } from "../../../client/src/media/fake-peer-connection.test.helpers";
import { registerAnnotationSession } from "../../../client/src/screen-annotation";
import { AnnotationSession } from "../../../client/src/screen-annotation/session";
import { opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";
import { ownerId, recordingClient, recoverSocket, recoveryId, settle, stateWithPeer, wireSnapshot } from "../../../client/tests/helpers/sync-v1";
import { createNativeAnnotationCapture } from "./android-capture";

const nativeEvents = vi.hoisted((): string[] => []);
const frameSize = { width: 1080, height: 2400 };

vi.mock("@cloudflare/react-native-webrtc", async () => {
  const { FakeTrack } = await import("../../../client/src/media/sfu.test.helpers");
  return {
    MediaStreamTrack: class extends FakeTrack {
      constructor({ id }: { readonly id: string }) {
        super(id, "video");
      }

      getSettings() {
        return frameSize;
      }

      release() {
        nativeEvents.push("release capture");
      }
    },
  };
});
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
        return true;
      },
      probe: async () => {
        nativeEvents.push("probe overlay");
        return frameSize;
      },
      render() {},
      stop() {},
    },
  },
}));

beforeEach(() => {
  nativeEvents.length = 0;
});

it.each([
  { scenario: "availability on", negotiated: "burn-in", enabled: true },
  { scenario: "availability absent from welcome", negotiated: false, enabled: false },
  { scenario: "availability withdrawn after welcome", negotiated: "burn-in", enabled: false },
] as const)("publishes an Android screen share with $scenario", async ({ negotiated, enabled }) => {
  const grant = opaqueAccessGrant("screen-share");
  const client = createSpaceClient({ space: "screen-share", baseUrl: "http://127.0.0.1:1", getAccess: async () => grant });
  const { client: sync, sockets } = recordingClient();
  const { client: media } = createSfuHarness({}, (autoConnect) => new FakePeerConnection(autoConnect));
  const capture = createNativeAnnotationCapture();
  const annotation = new AnnotationSession(
    {
      subscribePorts(listener) {
        listener({ sync, media });
        return () => {};
      },
    },
    capture.verifiedAnnotationCapture,
  );
  registerAnnotationSession(client, annotation);
  const detach = capture.attach(client);
  try {
    const initial = stateWithPeer("collaborator");
    const snapshot = await wireSnapshot(initial);
    await sync.start();
    const socket = sockets[0]!;
    socket.open();
    await settle();
    await recoverSocket(sync, socket, { ...initial, stateDigest: snapshot.state_digest }, snapshot, "snapshot", true, undefined, false, false, negotiated);
    if (negotiated) {
      socket.receive({ type: "annotation_state", state: null, ...(enabled ? {} : { enabled: false }), server_at_ms: Date.now() });
      await settle();
    }

    const [track] = (await capture.getDisplayMedia()).getVideoTracks();
    expect(track?.id).toBe("screen");
    media.prepareLocalTrack("screen", track!);
    await media.start(fakeStream());
    await expect(media.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    const published = media.getSnapshot().localTracks.find((item) => item.source === "screen");
    expect(published).toMatchObject({ enabled: true, publicationId: expect.any(String) });
    expect(published?.track).toBe(track);

    const publicationId = published!.publicationId!;
    const projection = sync.getSnapshot().media!;
    socket.receive({
      type: "projection_event",
      stream: "media",
      projection_id: projection.projectionId,
      sequence: projection.sequence + 1,
      item: { participant_id: ownerId, source: "screen", enabled: true, publication_id: publicationId },
    });
    await settle();
    expect(sync.getSnapshot().media?.items).toEqual([expect.objectContaining({ participantId: ownerId, source: "screen", enabled: true, publicationId })]);

    const binds = socket.frames().filter((frame) => frame.type === "annotation_command" && (frame.command as { readonly kind?: string } | undefined)?.kind === "bind");
    const controls = screenAnnotationFor(client);
    if (enabled) {
      expect(binds).toMatchObject([{ type: "annotation_command", command: { kind: "bind", publication_id: publicationId, frame: frameSize, burned_in: true } }]);
      const state: ScreenAnnotationState = {
        layer: { layer_id: recoveryId, publication_id: publicationId, sharer_id: ownerId, frame: frameSize, burned_in: true },
        fence: 1,
        revision: 1,
        paused: false,
        marks: [],
        access: { draw_policy: "everyone", default_color: "#ff00ff", can_draw: true, can_moderate: true, can_manage_policy: true, requests: [] },
      };
      socket.receive({ type: "annotation_state", state, server_at_ms: Date.now() });
      await settle();
      expect(controls.getSnapshot()).toMatchObject({ status: "ready", state });
      expect(capture.verifiedAnnotationCapture(track!)).toEqual(frameSize);
    } else {
      expect(binds).toEqual([]);
      expect(controls.getSnapshot()).toEqual({ status: "unavailable" });
      expect(capture.verifiedAnnotationCapture(track!)).toBeUndefined();
    }

    capture.releaseTrack(track!);
    expect(track?.readyState).toBe("ended");
    expect(nativeEvents).toEqual(enabled ? ["permission check", "screen capture", "protect controls", "probe overlay", "release capture"] : ["screen capture", "release capture"]);
  } finally {
    detach();
    annotation.dispose();
    sync.stop();
    client.dispose();
  }
});
