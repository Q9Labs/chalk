import { expect, it, vi } from "vitest";
import type { CloudflareSFUBootstrap } from "./cloudflare-sfu";
import { bootstrap, FakeTrack, fakeStream, micOn, mute, publishMicrophone, withTimedHarness, type Harness } from "./cloudflare-sfu-replacement.test-support";

const muteInPlaceBootstrap: CloudflareSFUBootstrap = { ...bootstrap("connection-1"), capabilities: { serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, muteInPlace: true } };
async function unmute(h: Harness) {
  await h.client.setLocalSourceIntent("microphone", true);
  return h.client.setLocalPublicationTarget(micOn);
}
const microphoneAdds = (h: Harness) => h.transport.addInputs.flatMap((input) => input.tracks).filter((track) => track.source === "microphone");

it("parks a muted microphone on the SFU and resumes the same publication without SDP", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      const offers = h.transport.renegotiateInputs.length;

      await mute(h);
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(h.transport.updateInputs.map((input) => input.tracks.map(({ location, source, paused }) => ({ location, source, paused })))).toEqual([[{ location: "local", source: "microphone", paused: true }]]);

      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.transport.updateInputs.map((input) => input.tracks[0]?.paused)).toEqual([true, false]);
      expect(new Set(h.transport.updateInputs.map((input) => input.tracks[0]?.publicationId)).size).toBe(1);
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(microphoneAdds(h)).toHaveLength(1);
      expect(h.transport.renegotiateInputs).toHaveLength(offers);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("toggles the microphone and the camera many times without one close, add or offer", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      h.client.prepareLocalTrack("camera", new FakeTrack("local-camera", "video") as unknown as MediaStreamTrack);
      const camOn = { ...micOn, operationId: "cam-on", source: "camera" as const };
      await expect(h.client.setLocalPublicationTarget(camOn)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      const offers = h.transport.renegotiateInputs.length;
      const adds = h.transport.addInputs.length;
      const toggles = 20;
      for (let toggle = 0; toggle < toggles; toggle++) {
        await h.client.closeForcedLocalPublication("microphone", "user_pause");
        await h.client.closeForcedLocalPublication("camera", "user_pause");
        await h.client.setLocalSourceIntent("microphone", true);
        await expect(h.client.setLocalPublicationTarget(micOn)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
        await h.client.setLocalSourceIntent("camera", true);
        await expect(h.client.setLocalPublicationTarget(camOn)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      }
      const paused = h.transport.updateInputs.flatMap((input) => input.tracks.map((track) => track.paused));
      expect(paused).toEqual(Array.from({ length: toggles }, () => [true, true, false, false]).flat());
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(h.transport.addInputs).toHaveLength(adds);
      expect(h.transport.renegotiateInputs).toHaveLength(offers);
      expect(
        h.client
          .getSnapshot()
          .localTracks.map((track) => track.source)
          .sort(),
      ).toEqual(["camera", "microphone"]);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("resumes a parked microphone with a fresh track after the idle release ended the old one", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      const released = h.client.getSnapshot().localTracks[0]?.track;
      await mute(h);

      // The 30 s idle release: the old track ends, and the controller hands the media client a fresh capture.
      released?.stop();
      await h.client.clearPreparedLocalTrack("microphone", { stopTrack: false });
      const fresh = new FakeTrack("fresh-microphone", "audio") as unknown as MediaStreamTrack;
      h.client.prepareLocalTrack("microphone", fresh);

      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.peers[0]?.getSenders().map((sender) => sender.track)).toEqual([fresh]);
      expect(h.transport.updateInputs.map((input) => input.tracks[0]?.paused)).toEqual([true, false]);
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(microphoneAdds(h)).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("keeps a parked microphone parked when Sync acknowledges the mute", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      await mute(h);
      await expect(h.client.setLocalPublicationTarget({ ...micOn, operationId: "mic-off", enabled: false })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
      expect(h.transport.closeInputs).toHaveLength(0);
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(microphoneAdds(h)).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("keeps a microphone parked when Sync acknowledges the mute while the park is still in flight", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      let release = () => {};
      h.transport.trackUpdateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The real mute order: the intent and the park start together, and Sync's reply can land before the park does.
      const intent = h.client.setLocalSourceIntent("microphone", false, "user_pause");
      const parked = mute(h);
      const acknowledged = h.client.setLocalPublicationTarget({ ...micOn, operationId: "mic-off", enabled: false });
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      release();
      await Promise.all([intent, parked, acknowledged]);
      expect(h.transport.closeInputs).toHaveLength(0);
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(microphoneAdds(h)).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("closes a muted microphone as before when the SFU does not advertise mute in place", async () => {
  await withTimedHarness(async (h) => {
    await publishMicrophone(h);
    await mute(h);
    expect(h.transport.updateInputs).toHaveLength(0);
    expect(h.transport.closeInputs).toHaveLength(1);
  });
});

it("closes a muted microphone when the park request fails, so the mute still lands", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      h.transport.failTrackUpdates = true;
      await mute(h);
      expect(h.transport.closeInputs).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("publishes a new microphone when the SFU no longer holds the parked one", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      await mute(h);
      h.transport.failTrackUpdates = true;
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.transport.closeInputs).toHaveLength(1);
      expect(microphoneAdds(h)).toHaveLength(2);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});
