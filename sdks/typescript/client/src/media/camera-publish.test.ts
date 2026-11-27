import { expect, it } from "vitest";
import { FakePeerConnection } from "./fake-peer-connection.test.helpers";
import { createSfuHarness, FakeTrack, fakeStream, type HarnessOptions } from "./sfu.test.helpers";

function createHarness(options: HarnessOptions = {}) {
  return createSfuHarness(options, (autoConnect) => new FakePeerConnection(autoConnect));
}

async function publishCamera(h: ReturnType<typeof createHarness>): Promise<void> {
  await h.client.start(fakeStream());
  h.client.prepareLocalTrack("camera", new FakeTrack("camera", "video") as unknown as MediaStreamTrack);
  await expect(h.client.setLocalPublicationTarget({ operationId: "camera-start", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
}

function cameraInit(h: ReturnType<typeof createHarness>): RTCRtpTransceiverInit {
  const init = h.peers[0].transceiverInits.find((candidate) => candidate.direction === "sendonly");
  expect(init).toBeDefined();
  return init!;
}

it("publishes one camera stream on a WebRTC implementation without camera simulcast", async () => {
  const h = createHarness({ cameraSimulcast: false });
  await publishCamera(h);
  expect(cameraInit(h).sendEncodings).toBeUndefined();
});

it("keeps the camera simulcast layers on a WebRTC implementation that supports them", async () => {
  const h = createHarness();
  await publishCamera(h);
  expect(cameraInit(h).sendEncodings).toEqual([
    { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2500000, scalabilityMode: "L1T1" },
    { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650000, scalabilityMode: "L1T1" },
  ]);
});
