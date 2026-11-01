import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { agreementIssues, playProofMedia, sampleAgreement, truthIssues } from "./agreement.mjs";

// Exercise the serialized browser sampler against media elements whose wrapper
// stays mounted, just as ParticipantTileSurface does when playback stops.
function sampler({ snapshot = false, opacity = "1", stream = true } = {}) {
  const video = {
    dataset: { participantId: "b" },
    parentElement: { opacity },
    srcObject: stream ? {} : null,
    paused: false,
    readyState: 2,
    videoWidth: 640,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 12 }),
  };
  const tile = { dataset: { participantId: "b" }, querySelector: (selector) => (selector === "video" ? video : null) };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.startsWith('[data-part="stage-tile"]') ? [tile] : [video]),
  };
  const window = snapshot
    ? { __chalk: { agreementSnapshot: () => ({ self: { participantId: "a" }, media: { local: { microphone: { state: "disabled" }, camera: { state: "disabled" } } }, participants: { roster: [{ participantId: "b", media: { microphone: "active", camera: "inactive" } }] } }) } }
    : {};
  const context = createContext({ window, document, getComputedStyle: (element) => element });
  return { context, window, sample: () => runInContext(`(${sampleAgreement.toString()})()`, context) };
}

for (const snapshot of [false, true]) {
  for (const [name, options, expected] of [
    ["a mounted video hidden behind the avatar", { opacity: "0" }, false],
    ["a mounted video without a playback stream", { stream: false }, false],
    ["a visible video with a playback stream", {}, true],
  ]) {
    test(`${snapshot ? "snapshot badge" : "DOM projection"}: camera reflects ${name}`, async () => {
      const result = await sampler({ snapshot, ...options }).sample();
      const participant = result.participants[0];
      assert.equal(snapshot ? participant.badgeCamera : participant.camera, expected);
      assert.equal(result.received[0].frames, expected ? 12 : 0);
    });
  }
}

test("guest samples attach late remote tracks and refresh replacement tracks without duplicating sinks", async () => {
  const { context, window, sample } = sampler();
  const elements = [];
  class Video {
    dataset = {};
    plays = 0;
    async play() {
      this.plays++;
    }
  }
  class Stream {
    constructor(tracks) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
  }
  const snapshot = { self: { participantId: "a" }, media: { local: { microphone: { state: "disabled" }, camera: { state: "disabled" } }, remote: [] }, participants: { roster: [] } };
  context.document = {
    querySelectorAll: (selector) => (selector === "[data-proof-source]" ? elements : []),
    createElement: () => new Video(),
    body: {
      append(element) {
        if (!elements.includes(element)) elements.push(element);
      },
    },
  };
  context.HTMLVideoElement = Video;
  context.MediaStream = Stream;
  window.proofClient = { getSnapshot: () => snapshot };
  runInContext(`window.proofPlayMedia = (${playProofMedia.toString()})`, context);
  await sample();
  assert.equal(elements.length, 0, "Joining before subscription needs no sink yet");
  const first = { kind: "video", id: "first" };
  snapshot.media.remote = [{ participantId: "b", source: "camera", track: first }];
  await sample();
  assert.equal(elements.length, 1);
  assert.equal(elements[0].srcObject.getTracks()[0], first);
  assert.equal(elements[0].plays, 1);
  const replacement = { kind: "video", id: "replacement" };
  snapshot.media.remote[0].track = replacement;
  await sample();
  assert.equal(elements.length, 1);
  assert.equal(elements[0].srcObject.getTracks()[0], replacement);
  assert.equal(elements[0].plays, 2);
});

function pair({ silent = false, stale = false, badge = true } = {}) {
  const otherId = (self) => (self === "a" ? "b" : "a");
  const energy = (self) => (silent && self === "b" ? 0 : 0.01);
  return ["a", "b"].map((self) => ({ self, local: { microphone: "enabled", camera: "enabled" }, participants: [{ id: otherId(self), microphone: badge, camera: true }], received: [{ id: otherId(self), energy: energy(self), frames: stale ? 10 : 20 }] }));
}

test("a healthy peer does not mask another sender's missing audio", () => {
  const issues = agreementIssues(pair({ stale: true }), pair({ silent: true }));
  assert.deepEqual(issues, ["a microphone: b playback energy 0"]);
});

test("a ready but frozen camera is not received video proof", () => {
  assert.equal(agreementIssues(pair({ stale: true }), pair({ stale: true })).filter((issue) => issue.includes("frames")).length, 2);
});

test("the Linux WebKit frame exception preserves microphone, camera projection, badge and control checks", () => {
  const before = pair({ stale: true });
  const after = pair({ stale: true, silent: true });
  after[0].controls = { microphone: false, camera: true };
  after[1].participants[0].camera = false;
  after[1].participants[0].badgeCamera = false;
  assert.deepEqual(agreementIssues(before, after, { checkCameraFrames: false }), ["a microphone: own button disagrees with SDK state", "a microphone: b playback energy 0", "a camera: local enabled, b projection false", "a camera: b badge disagrees"]);
  assert.equal(agreementIssues(before, pair({ stale: true })).filter((issue) => issue.includes("frames")).length, 2, "Frame checks remain the default for macOS WebKit and Chromium");
});

test("SFU On and muted Sync badges reproduce the split authority failure", () => {
  const split = pair({ badge: false });
  assert.equal(truthIssues(split).length, 2);
  assert.equal(agreementIssues(pair({ stale: true }), split).filter((issue) => issue.includes("projection")).length, 2);
});

test("both directions need audible capture and advancing frames", () => {
  assert.deepEqual(agreementIssues(pair({ stale: true }), pair()), []);
});

test("a pending SDK state cannot hide a normal On button during a held fault", () => {
  const samples = pair();
  samples[0].local.microphone = "enabling";
  samples[0].controls = { microphone: true, camera: true };
  assert.deepEqual(truthIssues(samples), ["a microphone: normal On button without confirmed local state"]);
});
