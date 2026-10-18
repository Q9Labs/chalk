import { installFixture } from "../prod-proof/fixture.mjs";

// Keep fake capture in the browser, while the real app owns joining and playback.
export function webMediaFixture(guest) {
  return `(() => {
    if (!navigator.mediaDevices) return;
    // Entrance requests preview audio before a gesture. Resume every generated
    // context on the user's click, including one whose first resume is pending.
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        document.addEventListener("pointerdown", () => { void this.resume(); }, { once: true });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: "proof-camera", groupId: "proof", kind: "videoinput", label: "Proof camera", toJSON() { return {}; } },
      { deviceId: "proof-microphone", groupId: "proof", kind: "audioinput", label: "Proof microphone", toJSON() { return {}; } }
    ];
    (${installFixture.toString()})({ speech: "", guest: ${guest}, tones: true });
  })();`;
}

export async function incomingAudioLevel() {
  const reports = await Promise.all(window.proofConnections.map((connection) => connection.getStats()));
  const audio = reports.flatMap((report) => [...report.values()]).filter((row) => row.type === "inbound-rtp" && row.kind === "audio");
  return Math.max(0, ...audio.map((row) => row.audioLevel ?? 0));
}

export function remoteVideoFrames() {
  const tile = document.querySelector('[aria-label="Video tile for Proof guest 1"]');
  const video = tile?.querySelector("video");
  return video && video.readyState >= 2 && video.videoWidth > 0 ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
}
