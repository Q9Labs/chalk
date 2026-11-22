import { expect, it, vi } from "vitest";
import { SFUError } from "./sfu";
import { bootstrap, createSfuHarness, FakeTrack, fakeStream, type HarnessOptions } from "./sfu.test.helpers";

import { FakePeerConnection } from "./fake-peer-connection.test.helpers";

type Harness = ReturnType<typeof createHarness>;
function createHarness(options: HarnessOptions = {}) {
  return createSfuHarness(options, (autoConnect) => new FakePeerConnection(autoConnect));
}
const GONE = () => new SFUError("Chalk SFU signaling failed with HTTP 404", "signaling_failed", { status: 404, retryableConnection: true });

async function startScreen(h: Harness): Promise<void> {
  h.client.prepareLocalTrack("screen", new FakeTrack("screen", "video") as unknown as MediaStreamTrack);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
}

it("stops a screen share whose media session the SFU has already removed", async () => {
  const h = createHarness({ replaceMediaConnection: async () => bootstrap("connection-2") });
  await h.client.start(fakeStream());
  await startScreen(h);
  vi.spyOn(h.transport, "closeTracks").mockRejectedValue(GONE());
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: "confirmed" });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")?.enabled ?? false).toBe(false);
});

it("stops sharing through the forced close and the Sync target when the SFU session is gone, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream());
  await startScreen(h);
  const close = vi.spyOn(h.transport, "closeTracks").mockRejectedValue(GONE());
  await h.client.closeForcedLocalPublication("screen", "user_pause");
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: "satisfied" });
  close.mockRestore();
  await h.client.clearPreparedLocalTrack("screen");
  h.client.prepareLocalTrack("screen", new FakeTrack("screen-2", "video") as unknown as MediaStreamTrack);
  await h.client.setLocalSourceIntent("screen", true);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-again", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")).toMatchObject({ enabled: true });
});

/** The calls the media controller makes when the user stops a screen share: the pause starts first and the local stop starts while it is in flight. */
async function stopScreenAsTheController(h: Harness): Promise<void> {
  void h.client.setLocalSourceIntent("screen", false, "user_pause").catch(() => undefined);
  const pause = h.client.closeForcedLocalPublication("screen", "user_pause");
  const localStop = h.client.clearPreparedLocalTrack("screen");
  await expect(pause).resolves.toBeUndefined();
  await expect(localStop).resolves.toBeUndefined();
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: expect.stringMatching(/^(confirmed|satisfied)$/) });
}

async function shareAgain(h: Harness): Promise<void> {
  h.client.prepareLocalTrack("screen", new FakeTrack("screen-2", "video") as unknown as MediaStreamTrack);
  await h.client.setLocalSourceIntent("screen", true);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-again", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")).toMatchObject({ enabled: true });
}

it("stops a screen share that is the only section and so carries the BUNDLE tag, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream());
  await startScreen(h);
  await stopScreenAsTheController(h);
  expect(h.transport.closeInputs.some((input) => input.force && input.sessionDescription === undefined)).toBe(true);
  await shareAgain(h);
  await stopScreenAsTheController(h);
  await shareAgain(h);
});

it("stops sharing when the SFU answers every close call with 404, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream(new FakeTrack("microphone", "audio")));
  await startScreen(h);
  const attempts: unknown[] = [];
  const close = vi.spyOn(h.transport, "closeTracks").mockImplementation(async (input) => {
    attempts.push(input);
    throw GONE();
  });
  await stopScreenAsTheController(h);
  expect(attempts.length).toBeGreaterThan(0);
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")?.enabled ?? false).toBe(false);
  close.mockRestore();
  await shareAgain(h);
});

it("reports no error when the SFU closes the BUNDLE-tag screen without an answer", async () => {
  const errors: unknown[] = [];
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`), onError: (error) => errors.push(error) });
  await h.client.start(fakeStream());
  await startScreen(h);
  await stopScreenAsTheController(h);
  expect(errors).toEqual([]);
});
