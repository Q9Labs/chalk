import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

// AudioOutput uses detached new Audio() elements. Observe its real sinks,
// not an extra test sink that could bypass the application's playback gate.
export function installAgreementProbe() {
  const NativeAudio = window.Audio;
  window.__agreementAudio = [];
  window.Audio = class extends NativeAudio {
    constructor(...args) {
      super(...args);
      window.__agreementAudio.push(this);
    }
  };
}

// Self-contained for serialization by both Playwright and the e2e runner.
export async function sampleAgreement() {
  await window.proofPlayMedia?.();
  const snapshot = window.__chalk?.agreementSnapshot?.() ?? window.proofClient?.getSnapshot();
  const tiles = [...document.querySelectorAll('[data-part="stage-tile"][data-participant-id]')];
  const localTile = tiles.find((tile) => tile.dataset.tour === "local-video");
  const self = snapshot?.self.participantId ?? localTile?.dataset.participantId;
  const controls = localTile
    ? {
        microphone: Boolean(document.querySelector('button[aria-label="Mute microphone"]:not([disabled])')),
        camera: Boolean(document.querySelector('button[aria-label="Turn off camera"]:not([disabled])')),
      }
    : null;
  const local = snapshot
    ? Object.fromEntries(["microphone", "camera"].map((source) => [source, snapshot.media.local[source].state]))
    : {
        microphone: document.querySelector('button[aria-label="Mute microphone"]') ? "enabled" : "disabled",
        camera: document.querySelector('button[aria-label="Turn off camera"]') ? "enabled" : "disabled",
      };
  const participants = snapshot
    ? snapshot.participants.roster.map((participant) => ({ id: participant.participantId, microphone: participant.media.microphone === "active", camera: participant.media.camera === "active" }))
    : tiles.map((tile) => ({ id: tile.dataset.participantId, microphone: !tile.querySelector('[aria-label="Muted"]'), camera: Boolean(tile.querySelector("video")) }));
  const received = [];
  for (const participant of participants.filter((participant) => participant.id !== self)) {
    const tile = tiles.find((tile) => tile.dataset.participantId === participant.id);
    const video = tile?.querySelector("video") ?? [...document.querySelectorAll("video[data-participant-id]")].find((element) => element.dataset.participantId === participant.id);
    const audio = window.__agreementAudio?.findLast((element) => element.dataset.participantId === participant.id && element.srcObject);
    let energy = 0;
    if (audio && !audio.paused && !audio.muted && audio.volume > 0) {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(audio.srcObject);
      const analyser = context.createAnalyser();
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        analyser.getFloatTimeDomainData(samples);
        energy = Math.max(energy, samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      }
      source.disconnect();
      await context.close();
    }
    const frames = video && !video.paused && video.readyState >= 2 && video.videoWidth > 0 ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
    received.push({ id: participant.id, energy, frames, audio: audio ? { paused: audio.paused, muted: audio.muted, contextTracks: audio.srcObject?.getAudioTracks().map((track) => ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState })) ?? [] } : null });
    if (tile && snapshot) {
      participant.badgeMicrophone = !tile.querySelector('[aria-label="Muted"]');
      participant.badgeCamera = Boolean(tile.querySelector("video"));
    }
  }
  return { self, local, controls, participants, received };
}

export function agreementIssues(before, after, { advancing = true } = {}) {
  const issues = [];
  if (after.length < 2 || new Set(after.map((sample) => sample.self)).size !== after.length) issues.push("agreement requires at least two distinct participant identities");
  for (const owner of after) {
    if (!owner.self) issues.push("missing self identity");
    for (const source of ["microphone", "camera"]) if (owner.controls && owner.controls[source] !== (owner.local[source] === "enabled")) issues.push(`${owner.self} ${source}: own button disagrees with SDK state`);
    for (const observer of after.filter((observer) => observer.self !== owner.self)) {
      const participant = observer.participants.find((participant) => participant.id === owner.self);
      const received = observer.received.find((participant) => participant.id === owner.self);
      const previous = before.find((item) => item.self === observer.self)?.received.find((item) => item.id === owner.self);
      for (const source of ["microphone", "camera"]) {
        const on = owner.local[source] === "enabled";
        if (!participant || participant[source] !== on) issues.push(`${owner.self} ${source}: local ${owner.local[source]}, ${observer.self} projection ${participant?.[source]}`);
        const badge = participant?.[source === "microphone" ? "badgeMicrophone" : "badgeCamera"];
        if (badge !== undefined && badge !== on) issues.push(`${owner.self} ${source}: ${observer.self} badge disagrees`);
        if (source === "microphone" && Boolean(received?.energy > 0.00001) !== on) issues.push(`${owner.self} microphone: ${observer.self} playback energy ${received?.energy}${received?.audio === undefined ? "" : ` ${JSON.stringify(received.audio)}`}`);
        if (source === "camera" && advancing && Boolean(received && previous && received.frames > previous.frames + 1) !== on) issues.push(`${owner.self} camera: ${observer.self} frames ${previous?.frames} -> ${received?.frames}`);
      }
    }
  }
  return issues;
}

export async function assertAgreement(endpoints, { timeoutMs = 15_000 } = {}) {
  const sample = () => Promise.all(endpoints.map((endpoint) => endpoint.evaluate(sampleAgreement)));
  const deadline = Date.now() + timeoutMs;
  let issues;
  do {
    const before = await sample();
    await wait(350);
    const after = await sample();
    issues = agreementIssues(before, after);
    if (!issues.length) return after;
  } while (Date.now() < deadline);
  assert.deepEqual(issues, [], "Media agreement: owner controls, every observer badge, audible capture and advancing video must agree");
}

export function truthIssues(samples) {
  return samples.flatMap((owner) =>
    samples
      .filter((observer) => observer.self !== owner.self)
      .flatMap((observer) =>
        ["microphone", "camera"].flatMap((source) => {
          const peer = observer.participants.find((participant) => participant.id === owner.self);
          return owner.local[source] === "enabled" && !peer?.[source] ? [`${owner.self} ${source}: normal On while ${observer.self} shows Off`] : [];
        }),
      ),
  );
}

// SDK release guests have no React UI. Play the SDK's gated received tracks.
export async function playProofMedia() {
  for (const remote of window.proofClient.getSnapshot().media.remote) {
    const existing = [...document.querySelectorAll("[data-proof-source]")].find((element) => element.dataset.participantId === remote.participantId && element.dataset.proofSource === remote.source);
    const element = existing ?? (remote.track.kind === "audio" ? new Audio() : document.createElement("video"));
    element.dataset.participantId = remote.participantId;
    element.dataset.proofSource = remote.source;
    if (element.srcObject?.getTracks()[0] !== remote.track) element.srcObject = new MediaStream([remote.track]);
    if (element instanceof HTMLVideoElement) element.muted = true;
    document.body.append(element);
    await element.play();
  }
}
