import { expect, it, vi } from "vitest";
import { CloudflareSFUError } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap } from "./cloudflare-sfu";
import { bootstrap, FakeTrack, fakeStream, withTimedHarness, type Harness } from "./cloudflare-sfu-replacement.test-support";

const CAMERA_ON = { operationId: "camera-on", participantId: "participant-1", source: "camera", enabled: true } as const;

async function startDormantWithCamera(h: Harness): Promise<FakeTrack> {
  await h.client.start(fakeStream());
  await vi.advanceTimersByTimeAsync(0);
  const track = new FakeTrack("local-camera", "video");
  h.client.prepareLocalTrack("camera", track as unknown as MediaStreamTrack);
  return track;
}

it("replaces a dormant connection before the grant without publishing, and the enable reuses it", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await h.client.prepareLocalPublicationTarget(CAMERA_ON);

      expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
      expect(h.peers).toHaveLength(2);
      expect(h.peers[1]?.activeTransceiverCount()).toBe(0);
      expect(h.transport.addInputs).toHaveLength(0);
      expect(h.client.getSnapshot().localTracks).toEqual([expect.objectContaining({ source: "camera", enabled: false })]);

      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
      expect(h.peers).toHaveLength(2);
      expect(h.transport.addInputs).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("leaves nothing published when the grant is denied after the head start", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      const track = await startDormantWithCamera(h);
      const enabledBefore = track.enabled;

      await h.client.prepareLocalPublicationTarget(CAMERA_ON);
      expect(track.enabled).toBe(enabledBefore);
      // Denied: the coordinator never calls setLocalPublicationTarget, and the controller clears the prepared track.
      await h.client.clearPreparedLocalTrack("camera");
      await vi.advanceTimersByTimeAsync(0);

      expect(h.transport.addInputs).toHaveLength(0);
      expect(h.peers.every((peer) => peer.activeTransceiverCount() === 0)).toBe(true);
      expect(h.client.getSnapshot().localTracks).toEqual([]);
    },
    { replaceMediaConnection },
  );
});

it("lets the enable retry the replacement when the head start's replacement failed", async () => {
  const replaceMediaConnection = vi.fn<() => Promise<CloudflareSFUBootstrap>>().mockRejectedValueOnce(new Error("bootstrap unavailable")).mockResolvedValue(bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await expect(h.client.prepareLocalPublicationTarget(CAMERA_ON)).rejects.toThrow("bootstrap unavailable");
      expect(h.transport.addInputs).toHaveLength(0);

      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
      expect(h.transport.addInputs).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("starts no head start for an off target or a source the user paused", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await h.client.prepareLocalPublicationTarget({ ...CAMERA_ON, enabled: false });
      await h.client.setLocalSourceIntent("camera", false, "user_pause");
      await h.client.prepareLocalPublicationTarget(CAMERA_ON);

      expect(replaceMediaConnection).not.toHaveBeenCalled();
    },
    { replaceMediaConnection },
  );
});

const idleSessionBootstrap: CloudflareSFUBootstrap = { ...bootstrap("connection-1"), capabilities: { serverLayerAdaptation: true, subscriptionState: true, iceRestart: true, keepsIdleSession: true } };

it("keeps the connection nobody has used for the first offer when the SFU keeps idle sessions", async () => {
  const replaceMediaConnection = async () => bootstrap("replacement");
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await h.client.prepareLocalPublicationTarget(CAMERA_ON);
      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(h.peers).toHaveLength(1);
      expect(h.transport.addInputs.map((input) => input.connectionId)).toEqual(["connection-1"]);
    },
    { bootstrap: idleSessionBootstrap, replaceMediaConnection },
  );
});

it("replaces the kept connection when the SFU reports it gone at the first offer", async () => {
  let replacements = 0;
  const replaceMediaConnection = async () => bootstrap(`replacement-${++replacements}`);
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);
      h.transport.nextLocalPublishFailure = new CloudflareSFUError("session gone", "signaling_failed", { status: 404 });

      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(h.transport.addInputs.at(-1)?.connectionId).toBe("replacement-1");
    },
    { bootstrap: idleSessionBootstrap, replaceMediaConnection },
  );
});

it("starts ICE candidate gathering when the peer connection is created", () => {
  const { peerConnectionFactory } = createHarness();
  expect(peerConnectionFactory).toHaveBeenCalledWith(expect.objectContaining({ bundlePolicy: "max-bundle", iceCandidatePoolSize: 1 }));
});
