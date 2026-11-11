import { installFixture } from "../prod-proof/fixture.mjs";
import { installAgreementProbe } from "./agreement.mjs";

// Keep fake capture in the browser, while the real app owns joining and playback.
export function webMediaFixture(guest) {
  return `(() => {
    (${installAgreementProbe.toString()})();
    if (!navigator.mediaDevices) return;
    // Entrance requests preview audio before a gesture. Resume every generated
    // context on the user's click, including one whose first resume is pending.
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        document.addEventListener("pointerdown", () => { this.resume().catch(() => {}); }, { once: true });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: "proof-camera", groupId: "proof", kind: "videoinput", label: "Proof camera", toJSON() { return {}; } },
      { deviceId: "proof-microphone", groupId: "proof", kind: "audioinput", label: "Proof microphone", toJSON() { return {}; } }
    ];
    // The devices above are fake, so the permission is too: a browser that has never been asked reports "prompt", and on a tablet or phone
    // the pre-join step then covers Join call with the access sheet. Join with mic and camera off, as the proof did before that step.
    const queryPermission = navigator.permissions?.query.bind(navigator.permissions);
    if (queryPermission) {
      navigator.permissions.query = async (descriptor) =>
        descriptor.name === "camera" || descriptor.name === "microphone"
          ? Object.assign(new EventTarget(), { name: descriptor.name, state: "granted" })
          : queryPermission(descriptor);
    }
    try {
      if (localStorage.getItem("chalk.prejoin-devices") === null) localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: false, camera: false }));
    } catch {}
    (${installFixture.toString()})({ speech: "", guest: ${guest}, tones: true });
  })();`;
}

export async function incomingAudioLevel() {
  const reports = await Promise.all(window.proofConnections.map((connection) => connection.getStats()));
  const audio = reports.flatMap((report) => [...report.values()]).filter((row) => row.type === "inbound-rtp" && row.kind === "audio");
  return Math.max(0, ...audio.map((row) => row.audioLevel ?? 0));
}

// Chromium receives packets without a sink, but only decodes audio (and updates
// inbound audioLevel/energy) while the received track is being played.
export async function playIncomingAudio() {
  const tracks = window.proofClient
    .getSnapshot()
    .media.remote.filter((entry) => entry.track.kind === "audio")
    .map((entry) => entry.track);
  if (!tracks.length) throw new Error("SDK guest has no received audio track to play");
  const audio = document.createElement("audio");
  audio.srcObject = new MediaStream(tracks);
  document.body.append(audio);
  await audio.play();
}

export async function audioEvidence() {
  const reports = await Promise.all(window.proofConnections.map((connection) => connection.getStats()));
  return {
    contextState: window.proofAudio?.context.state ?? null,
    tracks: window.proofConnections
      .flatMap((connection) => connection.getSenders())
      .filter((sender) => sender.track?.kind === "audio")
      .map(({ track }) => ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState })),
    stats: reports
      .flatMap((report) => [...report.values()])
      .filter((row) => row.kind === "audio" && ["media-source", "outbound-rtp", "inbound-rtp"].includes(row.type))
      .map((row) => Object.fromEntries(["type", "bytesSent", "packetsSent", "bytesReceived", "packetsReceived", "audioLevel", "totalAudioEnergy", "totalSamplesDuration"].map((field) => [field, row[field] ?? null]))),
  };
}

export function remoteVideoFrames() {
  const tile = document.querySelector('[aria-label="Video tile for Proof guest 1"]')?.closest('[data-part="stage-tile"]');
  const video = tile?.querySelector("video");
  return video && video.readyState >= 2 && video.videoWidth > 0 ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
}
