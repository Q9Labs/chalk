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
  const cameraShown = (video) => Boolean(video?.srcObject && getComputedStyle(video.parentElement).opacity !== "0");
  const isOn = (label, suffix = "") => Boolean(document.querySelector(`button[aria-label="${label}"]${suffix}`));
  function readSnapshot() {
    return window.__chalk?.agreementSnapshot?.() ?? window.proofClient?.getSnapshot();
  }
  const snapshot = readSnapshot();
  const tiles = [...document.querySelectorAll('[data-part="stage-tile"][data-participant-id]')];
  const localTile = tiles.find((tile) => tile.dataset.tour === "local-video");
  function selfId() {
    return snapshot?.self.participantId ?? localTile?.dataset.participantId;
  }
  const self = selfId();
  function controlState() {
    if (!localTile) return null;
    return { microphone: isOn("Mute microphone", ":not([disabled])"), camera: isOn("Turn off camera", ":not([disabled])") };
  }
  function localState() {
    if (snapshot) return Object.fromEntries(["microphone", "camera"].map((source) => [source, snapshot.media.local[source].state]));
    return { microphone: isOn("Mute microphone") ? "enabled" : "disabled", camera: isOn("Turn off camera") ? "enabled" : "disabled" };
  }
  function participantStates() {
    if (snapshot) return snapshot.participants.roster.map((participant) => ({ id: participant.participantId, microphone: participant.media.microphone === "active", camera: participant.media.camera === "active" }));
    return tiles.map((tile) => ({ id: tile.dataset.participantId, microphone: !tile.querySelector('[aria-label="Muted"]'), camera: cameraShown(tile.querySelector("video")) }));
  }
  function videoFrames(video) {
    if (!cameraShown(video)) return 0;
    if ([video.paused, video.readyState < 2, video.videoWidth <= 0].some(Boolean)) return 0;
    return video.getVideoPlaybackQuality().totalVideoFrames;
  }
  function audioState(audio) {
    if (!audio) return null;
    const contextTracks = audio.srcObject?.getAudioTracks().map((track) => ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState })) ?? [];
    return { paused: audio.paused, muted: audio.muted, contextTracks };
  }
  function playingAudio(audio) {
    if (!audio?.srcObject) return false;
    return [!audio.paused, !audio.muted, audio.volume > 0].every(Boolean);
  }
  async function audioEnergy(audio) {
    if (!playingAudio(audio)) return 0;
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(audio.srcObject);
    const analyser = context.createAnalyser();
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let energy = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      analyser.getFloatTimeDomainData(samples);
      energy = Math.max(energy, samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    }
    source.disconnect();
    await context.close();
    return energy;
  }
  function participantVideo(tile, id) {
    return tile?.querySelector("video") ?? [...document.querySelectorAll("video[data-participant-id]")].find((element) => element.dataset.participantId === id);
  }
  function participantAudio(id) {
    return window.__agreementAudio?.findLast((element) => element.dataset.participantId === id && element.srcObject);
  }
  function badges(participant, tile) {
    if (!tile || !snapshot) return;
    participant.badgeMicrophone = !tile.querySelector('[aria-label="Muted"]');
    participant.badgeCamera = cameraShown(tile.querySelector("video"));
  }
  const controls = controlState();
  const local = localState();
  const participants = participantStates();
  const received = [];
  for (const participant of participants.filter((participant) => participant.id !== self)) {
    const tile = tiles.find((tile) => tile.dataset.participantId === participant.id);
    const video = participantVideo(tile, participant.id);
    const audio = participantAudio(participant.id);
    received.push({ id: participant.id, energy: await audioEnergy(audio), frames: videoFrames(video), audio: audioState(audio) });
    badges(participant, tile);
  }
  return { self, local, controls, participants, received };
}

function badgeIssues(participant, source, on, prefix) {
  const badge = participant?.[source === "microphone" ? "badgeMicrophone" : "badgeCamera"];
  return [badge !== undefined, badge !== on].every(Boolean) ? [`${prefix} badge disagrees`] : [];
}

function microphoneIssues(received, on, prefix) {
  const { energy, audio } = received ?? {};
  if (Boolean(energy > 0.00001) === on) return [];
  const detail = audio === undefined ? "" : ` ${JSON.stringify(audio)}`;
  return [`${prefix} playback energy ${energy}${detail}`];
}

function cameraIssues({ frames: currentFrames } = {}, { frames: previousFrames } = {}, { on, prefix, checkCameraFrames }) {
  if (!checkCameraFrames) return [];
  const advancing = currentFrames > previousFrames + 1;
  return advancing === on ? [] : [`${prefix} frames ${previousFrames} -> ${currentFrames}`];
}

function projectionIssues(participant, source, owner, observer) {
  const on = owner.local[source] === "enabled";
  if (!participant || participant[source] !== on) return [`${owner.self} ${source}: local ${owner.local[source]}, ${observer.self} projection ${participant?.[source]}`];
  return [];
}

function observerIssues(before, owner, observer, checkCameraFrames) {
  const participant = observer.participants.find((participant) => participant.id === owner.self);
  const received = observer.received.find((participant) => participant.id === owner.self);
  const previous = before.find((item) => item.self === observer.self)?.received.find((item) => item.id === owner.self);
  return ["microphone", "camera"].flatMap((source) => {
    const on = owner.local[source] === "enabled";
    const prefix = `${owner.self} ${source}: ${observer.self}`;
    const playback = source === "microphone" ? microphoneIssues(received, on, prefix) : cameraIssues(received, previous, { on, prefix, checkCameraFrames });
    return [...projectionIssues(participant, source, owner, observer), ...badgeIssues(participant, source, on, prefix), ...playback];
  });
}

function controlIssues(owner) {
  if (!owner.controls) return [];
  return ["microphone", "camera"].flatMap((source) => (owner.controls[source] !== (owner.local[source] === "enabled") ? [`${owner.self} ${source}: own button disagrees with SDK state`] : []));
}

function identityIssues(samples) {
  return samples.length < 2 || new Set(samples.map((sample) => sample.self)).size !== samples.length ? ["agreement requires at least two distinct participant identities"] : [];
}

export function agreementIssues(before, after, { checkCameraFrames = true } = {}) {
  const issues = identityIssues(after);
  for (const owner of after) {
    if (!owner.self) issues.push("missing self identity");
    issues.push(...controlIssues(owner));
    issues.push(...after.filter((observer) => observer.self !== owner.self).flatMap((observer) => observerIssues(before, owner, observer, checkCameraFrames)));
  }
  return issues;
}

export async function assertAgreement(endpoints, { timeoutMs = 15_000, checkCameraFrames = true } = {}) {
  const sample = () => Promise.all(endpoints.map((endpoint) => endpoint.evaluate(sampleAgreement)));
  const deadline = Date.now() + timeoutMs;
  let issues;
  do {
    const before = await sample();
    await wait(350);
    const after = await sample();
    issues = agreementIssues(before, after, { checkCameraFrames });
    if (!issues.length) return after;
  } while (Date.now() < deadline);
  assert.deepEqual(issues, [], "Media agreement: owner controls, every observer badge and required playback must agree");
}

export function truthIssues(samples) {
  return samples.flatMap((owner) => [
    ...["microphone", "camera"].flatMap((source) => (owner.controls?.[source] && owner.local[source] !== "enabled" ? [`${owner.self} ${source}: normal On button without confirmed local state`] : [])),
    ...samples
      .filter((observer) => observer.self !== owner.self)
      .flatMap((observer) =>
        ["microphone", "camera"].flatMap((source) => {
          const peer = observer.participants.find((participant) => participant.id === owner.self);
          return owner.local[source] === "enabled" && !peer?.[source] ? [`${owner.self} ${source}: normal On while ${observer.self} shows Off`] : [];
        }),
      ),
  ]);
}

// SDK release guests have no React UI. Play the SDK's gated received tracks.
export async function playProofMedia() {
  function proofElement(remote) {
    const existing = [...document.querySelectorAll("[data-proof-source]")].find((element) => element.dataset.participantId === remote.participantId && element.dataset.proofSource === remote.source);
    return existing ?? (remote.track.kind === "audio" ? new Audio() : document.createElement("video"));
  }
  for (const remote of window.proofClient.getSnapshot().media.remote) {
    const element = proofElement(remote);
    element.dataset.participantId = remote.participantId;
    element.dataset.proofSource = remote.source;
    if (element.srcObject?.getTracks()[0] !== remote.track) element.srcObject = new MediaStream([remote.track]);
    if (element instanceof HTMLVideoElement) element.muted = true;
    document.body.append(element);
    await element.play();
  }
}
