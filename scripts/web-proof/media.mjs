import { installFixture } from "../prod-proof/fixture.mjs";

// Keep fake capture in the browser, while the real app owns joining and playback.
export function webMediaFixture(guest) {
  return `(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: "proof-camera", groupId: "proof", kind: "videoinput", label: "Proof camera", toJSON() { return {}; } },
      { deviceId: "proof-microphone", groupId: "proof", kind: "audioinput", label: "Proof microphone", toJSON() { return {}; } }
    ];
    (${installFixture.toString()})({ speech: "", guest: ${guest}, tones: true });
  })();`;
}

export async function incomingAudioLevel() {
  let level = 0;
  for (const connection of window.proofConnections) {
    for (const row of (await connection.getStats()).values()) {
      if (row.type === "inbound-rtp" && row.kind === "audio") level = Math.max(level, row.audioLevel ?? 0);
    }
  }
  return level;
}

export function remoteVideoFrames() {
  const tile = document.querySelector('[aria-label="Video tile for Proof guest 1"]');
  const video = tile?.querySelector("video");
  return video && video.readyState >= 2 && video.videoWidth > 0 ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
}
