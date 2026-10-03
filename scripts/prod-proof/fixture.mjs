import { readFile, unlink } from "node:fs/promises";
import { command } from "./runtime.mjs";

const spokenWords = "The purple lantern shines beside the quiet river. We are testing camera, screen sharing, recording, export, and transcription.";
export async function generateVoice(directory, signal) {
  const source = `${directory}/voice.aiff`;
  const target = `${directory}/voice.wav`;
  if (process.platform === "darwin") {
    await command("say", ["-v", "Samantha", "-r", "145", "-o", source, spokenWords], { signal });
    await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "48000", "-ac", "1", target], { signal });
    await unlink(source);
  } else {
    await command("espeak", ["-s", "145", "-w", target, spokenWords], { signal });
  }
  return (await readFile(target)).toString("base64");
}

// Browser-side generator: animated, distinguishable camera; repeatable spoken audio.
export function installFixture({ speech, guest }) {
  const NativePC = window.RTCPeerConnection;
  window.proofConnections = [];
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args);
      window.proofConnections.push(this);
    }
    addTransceiver(track, options) {
      if (track instanceof MediaStreamTrack && track.kind === "video" && track.id === window.proofCameraId) {
        return super.addTransceiver(track, {
          ...options,
          sendEncodings: [
            { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 120_000 },
            { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 450_000 },
            { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
          ],
        });
      }
      return super.addTransceiver(track, options);
    }
  };
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  function cameraTrack() {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    let frame = 0;
    window.proofCameraTimer = setInterval(() => {
      context.fillStyle = guest === 0 ? "#1b365d" : "#613c69";
      context.fillRect(0, 0, 1280, 720);
      context.fillStyle = "white";
      context.font = "64px sans-serif";
      context.fillText(`Proof guest ${guest + 1}`, 60, 100);
      context.fillText(`Frame ${frame++}`, 60, 200);
      for (let n = 0; n < 30; n++) {
        context.fillStyle = `hsl(${(frame * 7 + n * 12) % 360} 70% 60%)`;
        context.fillRect((frame * 11 + n * 61) % 1280, 250 + (n % 5) * 80, 70, 60);
      }
    }, 1000 / 15);
    const camera = canvas.captureStream(15).getVideoTracks()[0];
    window.proofCameraId = camera.id;
    return camera;
  }
  async function voiceTrack() {
    if (!window.proofAudio) {
      const context = new AudioContext();
      await context.resume();
      const bytes = Uint8Array.from(atob(speech), (character) => character.charCodeAt(0));
      const buffer = await context.decodeAudioData(bytes.buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = context.createGain();
      gain.gain.value = guest === 0 ? 0.8 : 0.08;
      const destination = context.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(destination);
      source.start();
      window.proofAudio = { context, source, destination };
    }
    return window.proofAudio.destination.stream.getAudioTracks()[0].clone();
  }
  function replaceTracks(stream, tracks, generated) {
    for (const track of tracks) {
      stream.removeTrack(track);
      track.stop();
    }
    stream.addTrack(generated);
  }
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await nativeCapture(constraints);
    if (constraints.video) replaceTracks(stream, stream.getVideoTracks(), cameraTrack());
    if (constraints.audio) replaceTracks(stream, stream.getAudioTracks(), await voiceTrack());
    return stream;
  };
}

export const shareHTML = `<!doctype html><title>Chalk proof screen share</title><canvas width="1920" height="1080"></canvas><script>
const c=document.querySelector('canvas').getContext('2d');let n=0;
setInterval(()=>{c.fillStyle='#102a43';c.fillRect(0,0,1920,1080);c.fillStyle='#ffffff';c.font='80px sans-serif';c.fillText('Synthetic screen share',80,160);c.fillText('Frame '+n++,80,320);c.fillStyle='#22c55e';c.fillRect((n*20)%1600,500,200,200)},1000/15);
</script>`;
